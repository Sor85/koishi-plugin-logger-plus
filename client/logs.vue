<!--
  日志列表展示组件
  负责渲染日志内容和控制最新日志追踪
-->
<template>
  <div class="logger-container">
    <div
      v-overlay-scrollbar="{ source: viewport.scrollbar }"
      ref="logList"
      class="log-list k-text-selectable"
      :style="listStyle"
      @scroll="handleScroll"
      @wheel.passive="markViewingLogs"
      @pointerdown="markViewingLogs"
    >
      <button
        v-if="canLoadMore"
        class="log-load-more-button"
        type="button"
        :disabled="loadingMore"
        @click="loadBeforeLogs"
      >{{ loadingMore ? '正在加载' : '查看更多消息' }}</button>
      <!-- 虚拟滚动：只渲染窗口内的日志行，窗口外的高度由上下内边距占位 -->
      <div
        ref="logViewport"
        class="log-viewport"
        :style="{ paddingTop: `${logWindow.paddingTop}px`, paddingBottom: `${logWindow.paddingBottom}px` }"
      >
        <div
          v-for="item in visibleLogs"
          :key="item.key"
          v-memo="[item.key, item.index, item.start]"
          :data-log-index="item.index"
          :data-log-key="item.key"
          :class="['line', `level-${item.record.type}`, { start: item.start }]"
          @contextmenu.prevent="openLogMenu(item.record, $event)"
        >
          <code><span v-html="renderPrefix(item.record)"></span><button
            v-if="getPrimaryPath(item.record)"
            class="log-name"
            type="button"
            :title="`筛选 ${item.record.name} 的日志`"
            @click="filterByRecord(item.record)"
            v-html="renderName(item.record)"
          ></button><span v-else v-html="renderName(item.record)"></span><span v-html="renderContent(item.record)"></span></code>
        </div>
      </div>
    </div>
    <span
      class="log-scrollbar-gutter"
      :style="{ width: scrollbarGutterWidth }"
      aria-hidden="true"
    ></span>
    <button
      :class="['logger-scroll-bottom', { visible: !isViewingLatest }]"
      type="button"
      title="回到底部"
      aria-label="回到底部"
      :aria-hidden="isViewingLatest"
      :tabindex="isViewingLatest ? -1 : undefined"
      @click="returnToLatest"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M18 13l-6 6-6-6"/>
      </svg>
    </button>
    <Teleport to="body">
      <div
        v-if="logMenu"
        ref="logMenuElement"
        class="logger-menu"
        :style="logMenuStyle"
        role="menu"
      >
        <button
          v-for="item in logMenuItems"
          :key="item.key"
          class="logger-menu-item"
          type="button"
          role="menuitem"
          @click="runLogMenuItem(item)"
        >{{ item.label }}</button>
      </div>
    </Teleport>
  </div>
</template>

<script lang="ts" setup>

import { Time, message, store } from '@koishijs/client'
import {} from '@koishijs/plugin-config'
import Logger from 'reggol'
import ansi from 'ansi_up'
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { LogAnchor } from './log-viewport'
import { getLogKey } from './log-record'
import { holdLiveLogTrim } from './live-log-trim'
import { vOverlayScrollbar } from './overlay-scrollbar'
import { useLogViewport } from './use-log-viewport'
import { createPreparedLogList } from './prepared-log-list'
import { readLogTextLayout } from './log-text-layout'
import { logPrefixColumns, type LogTextLayout } from './log-height-estimator'

const props = defineProps<{
  logs: Logger.Record[],
  showLink?: boolean,
  maxHeight?: string,
  resetFollowOnEnter?: boolean,
  preservePausedPositionOnReturn?: boolean,
  // 分页与历史生命周期由日志会话持有，列表组件只表达意图并读取结果
  canLoadMore?: boolean,
  loadingMore?: boolean,
  loadMore?: () => Promise<void>,
  // 查询切换时递增；用来在不重挂子树的前提下让视口回到最新
  resetToken?: number,
}>()

const emit = defineEmits<{
  (name: 'view-logs'): void
  (name: 'filter-path', path: string): void
}>()

interface LogMenuItem {
  key: string
  label: string
  run: () => void
}

interface LogMenuState {
  record: Logger.Record
  selection: string
}

interface VisibleLog {
  key: string
  index: number
  record: Logger.Record
  start: boolean
}

// this package does not have consistent exports in different environments
const converter = new (ansi['default'] || ansi)()
converter.escape_for_html = true

function renderColor(code: number, value: any, decoration = '') {
  return `\u001b[3${code < 8 ? code : '8;5;' + code}${decoration}m${value}\u001b[0m`
}

const showTime = 'yyyy-MM-dd hh:mm:ss'
// 等级标记的 ANSI 颜色：报错标红，其余等级沿用终端习惯的配色，info 保持正文色。
// 取 256 色表里的高亮档（9/11/10），暗色终端背景下比 1/3/2 的暗红暗黄对比度更高
const levelColors: Record<string, number> = {
  error: 9,
  warn: 11,
  success: 10,
  debug: 8,
}
// 右键菜单贴边时的安全距离，避免弹到视口外
const menuViewportGap = 8
// 虚拟滚动在视口上下各多渲染的高度：滑进新窗口之前先备好这一段，避免出现空白
const overscanHeight = 600
// 取不到实测行高时的估算值，与 --logger-line-height 一致
const fallbackLineHeight = 20
const router = useRouter()
const logList = ref<HTMLElement | null>(null)
const logViewport = ref<HTMLElement | null>(null)
const displayLogs = shallowRef<Logger.Record[]>([])
const preparingHistory = ref(false)
const nativeScrollbarWidth = ref(0)
const logMenu = ref<LogMenuState | null>(null)
const logMenuElement = ref<HTMLElement | null>(null)
const logMenuStyle = ref({ left: '0px', top: '0px' })

// 滚动位置、渲染窗口与追踪状态全部交给 LogViewport 协调，这里只接收结果
const { viewport, logWindow, isFollowing, isViewingLatest } = useLogViewport({
  list: logList,
  content: logViewport,
  overscan: overscanHeight,
  fallbackLineHeight,
  onStateChange: () => updateNativeScrollbarWidth(),
  onResize: () => prepareLogs(),
})
const preparedLogs = createPreparedLogList({
  yieldTask: () => new Promise(resolve => setTimeout(resolve, 0)),
  commit(records, heights) {
    // 先把新清单与预估交给核心取旧 DOM 锚点，再在同一次 Vue 刷新里替换展示记录。
    viewport.setItems(records.map(getLogKey), heights)
    displayLogs.value = records
  },
})
let textLayout: LogTextLayout | undefined
let typographyObserver: MutationObserver | undefined
function prepareLogs(recordsChanged = false) {
  const next = logList.value?.isConnected ? readLogTextLayout(logList.value)
    : textLayout ?? readLogTextLayout(null)
  if (!recordsChanged && textLayout?.columns === next.columns
    && textLayout.lineHeight === next.lineHeight && textLayout.separatorHeight === next.separatorHeight) return
  textLayout = next
  void preparedLogs.update(props.logs.slice(), next)
}
let pausedPosition: LogAnchor | undefined
// 暂停浏览期间挂起实时缓冲裁剪：清单前端被削会把用户正在读的那一段直接删掉，
// 视口内容整体上移、可滚动范围收缩，看起来就是位置被拉回、日志凭空消失
let releaseLiveLogTrim: (() => void) | undefined

watch(isFollowing, (following) => {
  if (following) {
    releaseLiveLogTrim?.()
    releaseLiveLogTrim = undefined
  } else {
    releaseLiveLogTrim ??= holdLiveLogTrim()
  }
}, { immediate: true })

const listStyle = computed(() => props.maxHeight ? { maxHeight: props.maxHeight } : {})

// 查询切换由会话递增 resetToken：分页进度已在会话侧重建，这里只把视口拉回最新。
// 不再靠复合 :key 拆掉整棵子树来重置，数据正确性不再依赖 Vue 重挂协议
watch(() => props.resetToken, () => viewport.followLatest())

// 只把窗口内的日志交给模板；下标取全量清单里的绝对下标，分隔行判定与锚点都依赖它
const visibleLogs = computed(() => {
  const items: VisibleLog[] = []
  for (let index = logWindow.value.start; index < logWindow.value.end; index++) {
    const record = displayLogs.value[index]
    if (!record) continue
    items.push({ key: getLogKey(record), index, record, start: isStart(index) })
  }
  return items
})

// 更早的日志改为手动加载：滑到顶部才会看到这个入口。是否还有更早记录由会话裁决
const canLoadMore = computed(() => Boolean(props.canLoadMore))
const loadingMore = computed(() => Boolean(props.loadingMore) || preparingHistory.value)

// 遮罩至少铺满列表右侧内边距：占位型滚动条按实测宽度盖住，覆盖式滚动条画在内边距上也一并盖住。
// 内边距区域本来就没有内容，铺同色底不会遮住日志正文
const scrollbarGutterWidth = computed(() => `max(1rem, ${nativeScrollbarWidth.value}px)`)

// 少数浏览器与用户样式会忽略 scrollbar-width / scrollbar-color，仍然给日志列表画出原生滚动条，
// 轨道底色比日志区域更深，右侧会出现一条竖带。实测滚动条占位宽度，交给同色遮罩盖平。
function updateNativeScrollbarWidth() {
  const element = logList.value
  if (!element) return
  nativeScrollbarWidth.value = Math.max(0, element.offsetWidth - element.clientWidth)
}

function markViewingLogs() {
  emit('view-logs')
}

function returnToLatest() {
  markViewingLogs()
  viewport.followLatest()
}

async function loadBeforeLogs() {
  if (!props.loadMore || !canLoadMore.value || loadingMore.value) return
  markViewingLogs()
  // 前插会把已加载的日志整体推下去：整个「取一页 + 写入记录」交给 around 执行，
  // 取锚点、改数据、按锚点复位的顺序封在它里面。会话在写入前会核对请求仍属于当前查询，
  // 请求有效性与阅读位置保护分属会话核心与视口核心，两者不互相接管
  preparingHistory.value = true
  try {
    await viewport.around(async () => {
      await props.loadMore!()
      await nextTick()
      await preparedLogs.ready()
    })
  } finally {
    preparingHistory.value = false
  }
}

function handleScroll() {
  closeLogMenu()
  viewport.handleScroll()
}

function getSelectionText() {
  const element = logList.value
  const selection = window.getSelection()
  if (!element || !selection || selection.isCollapsed) return ''
  // 选区跨行时任意一端落在日志列表内就算有效，避免只判断 anchorNode 漏掉反向选择
  if (!element.contains(selection.anchorNode) && !element.contains(selection.focusNode)) return ''
  return selection.toString()
}

const logMenuItems = computed<LogMenuItem[]>(() => {
  const state = logMenu.value
  if (!state) return []
  const { record, selection } = state
  const items: LogMenuItem[] = []
  if (selection) {
    items.push({ key: 'selection', label: '复制选中文本', run: () => copyText(selection, '已复制选中文本') })
  }
  items.push({ key: 'line', label: '复制整行日志', run: () => copyText(formatLine(record), '已复制日志') })
  items.push({ key: 'content', label: '复制日志正文', run: () => copyText(stripAnsi(record.content), '已复制日志正文') })
  items.push({ key: 'name', label: '复制来源名称', run: () => copyText(record.name, '已复制来源名称') })
  items.push({ key: 'time', label: '复制时间', run: () => copyText(formatTime(record), '已复制时间') })
  const pluginRoute = getPluginRoute(record)
  if (pluginRoute) {
    items.push({ key: 'plugin', label: '前往插件配置', run: () => router.push(pluginRoute) })
  }
  return items
})

function closeLogMenu() {
  if (logMenu.value) logMenu.value = null
}

async function openLogMenu(record: Logger.Record, event: MouseEvent) {
  markViewingLogs()
  logMenu.value = { record, selection: getSelectionText() }
  logMenuStyle.value = { left: `${event.clientX}px`, top: `${event.clientY}px` }
  await nextTick()
  const element = logMenuElement.value
  if (!element) return
  // 菜单渲染出来才知道实际尺寸，量完再把贴边的位置收回视口内
  const { width, height } = element.getBoundingClientRect()
  const maxLeft = Math.max(menuViewportGap, window.innerWidth - width - menuViewportGap)
  const maxTop = Math.max(menuViewportGap, window.innerHeight - height - menuViewportGap)
  logMenuStyle.value = {
    left: `${Math.min(Math.max(event.clientX, menuViewportGap), maxLeft)}px`,
    top: `${Math.min(Math.max(event.clientY, menuViewportGap), maxTop)}px`,
  }
}

function runLogMenuItem(item: LogMenuItem) {
  closeLogMenu()
  item.run()
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (logMenuElement.value?.contains(event.target as Node)) return
  closeLogMenu()
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeLogMenu()
}

onMounted(() => {
  // 字号令牌可能只改变祖先 style/class 而不改变列表盒子宽度，ResizeObserver 捕获不到。
  // 不观察子树，避免日志换窗本身触发文本预估。
  typographyObserver = new MutationObserver(() => prepareLogs())
  for (let element = logList.value; element; element = element.parentElement) {
    typographyObserver.observe(element, { attributes: true, attributeFilter: ['style', 'class'] })
  }
  requestAnimationFrame(updateNativeScrollbarWidth)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('keydown', handleDocumentKeydown)
  window.addEventListener('resize', closeLogMenu)
  window.addEventListener('resize', updateNativeScrollbarWidth)
  window.addEventListener('blur', closeLogMenu)
})

onUnmounted(() => {
  preparedLogs.dispose()
  typographyObserver?.disconnect()
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('keydown', handleDocumentKeydown)
  window.removeEventListener('resize', closeLogMenu)
  window.removeEventListener('resize', updateNativeScrollbarWidth)
  window.removeEventListener('blur', closeLogMenu)
  releaseLiveLogTrim?.()
  releaseLiveLogTrim = undefined
})

onActivated(() => {
  markViewingLogs()
  if (props.preservePausedPositionOnReturn && !isFollowing.value) {
    // 重新挂回文档要等一帧才有稳定读数，此前恢复出来的位置不可靠
    nextTick(() => requestAnimationFrame(() => {
      void viewport.restore(pausedPosition)
    }))
    return
  }
  if (props.resetFollowOnEnter) viewport.followLatest()
})

onDeactivated(() => {
  closeLogMenu()
  // 失活后容器已离开文档，此时再取位置只会拿到不稳定读数，所以在这里做最后一次取值
  pausedPosition = props.preservePausedPositionOnReturn ? viewport.capture() : undefined
})

// 实时裁剪可能让长度保持不变，因此同时侦听首尾记录；滚动换窗不会触发文本预估。
watch([() => props.logs, () => props.logs.length, () => props.logs[0], () => props.logs.at(-1)], () => {
  prepareLogs(true)
}, { immediate: true })

function isStart(index: number) {
  const logs = displayLogs.value
  return index > 0 && logs[index - 1].id > logs[index].id && logs[index].name === 'app'
}

function formatTime(record: Logger.Record) {
  return Time.template(showTime, new Date(record.timestamp))
}

// record.content 由 reggol 按 colors: 3 生成，正文里带 ANSI 转义序列；复制到剪贴板前必须去掉
function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function formatLine(record: Logger.Record, color = false) {
  const prefix = `[${record.type[0].toUpperCase()}]`
  const space = ' '
  let indent = 3 + space.length, output = ''
  indent += showTime.length + space.length
  output += (color ? renderColor(8, formatTime(record)) : formatTime(record)) + space
  const code = Logger.code(record.name, { colors: 3 })
  const label = color ? renderColor(code, record.name, ';1') : record.name
  const padLength = label.length - record.name.length
  output += prefix + space + label.padEnd(padLength) + space
  const content = color ? record.content : stripAnsi(record.content)
  output += content.replace(/\n/g, '\n' + ' '.repeat(indent))
  return output
}

function getPrimaryPath(record: Logger.Record) {
  return record.meta?.paths?.[0]
}

// 跳转入口收进右键菜单：只有配置数据已同步且日志带插件路径时才给出这一项
function getPluginRoute(record: Logger.Record) {
  if (!props.showLink || !store.config || !store.packages) return
  const path = getPrimaryPath(record)
  if (!path) return
  return '/plugins/' + path.replace(/\./, '/')
}

function filterByRecord(record: Logger.Record) {
  const path = getPrimaryPath(record)
  if (path) emit('filter-path', path)
}

async function writeClipboard(text: string) {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    const copied = document.execCommand('copy')
    if (!copied) throw new Error('copy failed')
  } finally {
    textarea.remove()
  }
}

async function copyText(text: string, hint: string) {
  try {
    await writeClipboard(text)
    message.success(hint)
  } catch {
    message.error('复制失败')
  }
}

function renderPrefix(record: Logger.Record) {
  const time = renderColor(8, formatTime(record))
  const marker = `[${record.type[0].toUpperCase()}]`
  const code = levelColors[record.type]
  const level = code === undefined ? marker : renderColor(code, marker, ';1')
  return converter.ansi_to_html(`${time} ${level} `)
}

function renderName(record: Logger.Record) {
  return converter.ansi_to_html(renderColor(Logger.code(record.name, { colors: 3 }), record.name, ';1'))
}

function renderContent(record: Logger.Record) {
  const indent = logPrefixColumns
  return converter.ansi_to_html(` ${record.content.replace(/\n/g, '\n' + ' '.repeat(indent))}`)
}

</script>

<style lang="scss" scoped>

.logger-container {
  position: relative;
  height: 100%;
}

.logger-scroll-bottom {
  position: absolute;
  right: 1.35rem;
  bottom: 1rem;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 2.1rem;
  height: 2.1rem;
  color: var(--terminal-fg);
  color: color-mix(in srgb, var(--terminal-fg) 82%, transparent);
  background: var(--terminal-bg-hover);
  background: color-mix(in srgb, var(--terminal-bg-hover) 58%, transparent);
  border: 1px solid var(--terminal-separator);
  border-color: color-mix(in srgb, var(--terminal-separator) 70%, var(--terminal-fg));
  border-radius: 999px;
  padding: 0;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transform: translateY(0.35rem);
  box-shadow: 0 10px 28px rgb(0 0 0 / 18%), inset 0 1px 0 rgb(255 255 255 / 8%);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  transition: opacity 0.15s ease, transform 0.18s ease-out, color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;

  &.visible {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }

  &:hover,
  &:focus-visible {
    color: var(--terminal-fg-hover);
    background: var(--terminal-bg-hover);
    background: color-mix(in srgb, var(--terminal-bg-hover) 72%, var(--terminal-bg));
    border-color: var(--terminal-separator);
    outline: none;
  }

  svg {
    width: 1.05rem;
    height: 1.05rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}

.log-list {
  box-sizing: border-box;
  // 虚拟滚动要把布局位置换算成滚动偏移：让滚动容器自己充当 offsetParent，
  // 占位容器与日志行的 offsetTop 才等于它们在滚动坐标里的位置
  position: relative;
  height: 100%;
  overflow-y: auto;
  // 位置只由 LogViewport 恢复；Firefox 的原生锚定会在宽度重排后重复补偿。
  overflow-anchor: none;
  color: var(--terminal-fg);
  background-color: var(--terminal-bg);
  padding: 1rem 1rem;

  // 虚拟滚动的占位容器：窗口之外的日志高度全部折进上下内边距，
  // 容器总高度由实测行与估算占位共同组成；自绘滑块另用记录坐标，避免实测修正导致回退
  .log-viewport {
    box-sizing: border-box;
  }

  // 分隔线占的那段留白必须计入行高：虚拟滚动按实测高度累加偏移，
  // 外边距既不进 offsetHeight 也不进 getBoundingClientRect，会让占位比真实内容矮一截
  .line.start {
    padding-top: 1rem;

    &::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 0.5rem;
      border-top: 1px solid var(--terminal-separator);
    }
  }

  .line {
    padding: 0 3rem 0 0.5rem;
    border-radius: 2px;
    font-size: var(--logger-font-size);
    line-height: var(--logger-line-height);
    white-space: pre-wrap;
    word-break: break-all;
    position: relative;

    &:hover {
      color: var(--terminal-fg-hover);
      background-color: var(--terminal-bg-hover);
    }

    ::selection {
      background-color: var(--terminal-bg-selection);
    }
  }

  // 报错整行标红，便于在长堆栈里定位失败的那一条
  .line.level-error {
    background-color: color-mix(in srgb, #f85149 16%, transparent);

    &:hover {
      color: var(--terminal-fg-hover);
      background-color: color-mix(in srgb, #f85149 26%, transparent);
    }
  }

  // 警告整行标黄，和报错的红底区分同一屏里的两种严重程度
  .line.level-warn {
    background-color: color-mix(in srgb, #d29922 16%, transparent);

    &:hover {
      color: var(--terminal-fg-hover);
      background-color: color-mix(in srgb, #d29922 26%, transparent);
    }
  }

  // 当成一行日志来排：与日志行同宽同高、同样的圆角与悬停反馈，不再是居中的胶囊。
  // 负的上外边距抵掉列表的顶部内边距，让这一行贴在页面最上沿
  .log-load-more-button {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 100%;
    height: var(--logger-line-height);
    margin-top: -1rem;
    color: var(--terminal-fg);
    color: color-mix(in srgb, var(--terminal-fg) 82%, transparent);
    background: var(--terminal-bg-hover);
    background: color-mix(in srgb, var(--terminal-bg-hover) 58%, transparent);
    border: 0;
    border-radius: 2px;
    padding: 0 0.5rem;
    font-family: inherit;
    font-size: var(--logger-font-size);
    line-height: 1;
    transition: color 0.15s ease, background-color 0.15s ease;

    &:hover,
    &:focus-visible {
      color: var(--terminal-fg-hover);
      background: var(--terminal-bg-hover);
      background: color-mix(in srgb, var(--terminal-bg-hover) 72%, var(--terminal-bg));
      outline: none;
    }

    &:disabled {
      opacity: 0.6;
    }
  }

  .log-name {
    color: inherit;
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;

    &:hover,
    &:focus-visible {
      text-decoration: underline;
    }
  }

}

// 遮住原生滚动条轨道：轨道底色比日志区域更深，会在右侧留下一条竖带。
// 宽度由 scrollbarGutterWidth 给出，至少盖住列表右侧内边距；
// pointer-events: none 保证原生滚动条仍可拖动，自绘滑块挂在 body 上层级更高，不会被遮住。
.log-scrollbar-gutter {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  background-color: var(--terminal-bg);
  pointer-events: none;
}

// 右键菜单挂到 body，避开日志滚动容器的裁剪；脱离根容器后必须自己声明排版基准
.logger-menu {
  position: fixed;
  z-index: 10002;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-width: 8.5rem;
  color: var(--terminal-fg);
  background: var(--terminal-bg);
  background: color-mix(in srgb, var(--terminal-bg-hover) 88%, var(--terminal-bg));
  border: 1px solid var(--terminal-separator);
  border-color: color-mix(in srgb, var(--terminal-separator) 70%, var(--terminal-fg));
  border-radius: 8px;
  padding: 0.25rem;
  font-family: var(--font-family, sans-serif);
  font-size: var(--logger-font-size);
  line-height: var(--logger-line-height);
  box-shadow: 0 12px 32px rgb(0 0 0 / 32%), inset 0 1px 0 rgb(255 255 255 / 8%);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}

.logger-menu-item {
  box-sizing: border-box;
  width: 100%;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 6px;
  padding: 0.3rem 0.65rem;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  text-align: left;
  white-space: nowrap;
  transition: color 0.15s ease, background-color 0.15s ease;

  &:hover,
  &:focus-visible {
    color: var(--terminal-fg-hover);
    background: color-mix(in srgb, var(--terminal-bg-hover) 92%, var(--terminal-fg));
    outline: none;
  }
}

</style>
