<!--
  日志列表展示组件
  负责渲染日志内容和控制最新日志追踪
-->
<template>
  <div class="logger-container">
    <div
      v-overlay-scrollbar
      ref="logList"
      class="log-list k-text-selectable"
      :style="listStyle"
      @scroll="handleScroll"
      @wheel.passive="markViewingLogs"
      @pointerdown="markViewingLogs"
    >
      <button
        v-if="showLoadMore"
        class="log-load-more-button"
        type="button"
        :disabled="loadingBefore"
        @click="loadBeforeLogs"
      >{{ loadingBefore ? '正在加载' : '查看更多消息' }}</button>
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

import { Time, message, send, store } from '@koishijs/client'
import {} from '@koishijs/plugin-config'
import Logger from 'reggol'
import ansi from 'ansi_up'
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { PausedLogPosition } from './log-position'
import { capturePausedLogPosition, restorePausedLogPosition } from './log-position'
import { getLogKey } from './log-record'
import { vOverlayScrollbar } from './overlay-scrollbar'
import type { VirtualListWindow } from './virtual-list'
import { createVirtualListLayout } from './virtual-list'

const props = defineProps<{
  logs: Logger.Record[],
  showLink?: boolean,
  maxHeight?: string,
  resetFollowOnEnter?: boolean,
  preservePausedPositionOnReturn?: boolean,
  loadBefore?: boolean,
  loadDate?: string,
  loadPath?: string,
  loadType?: string,
  loadSearch?: string,
  loadSearchPaths?: string[],
  loadCursor?: string,
}>()

const emit = defineEmits<{
  (name: 'prepend-logs', logs: Logger.Record[], cursor?: string): void
  (name: 'view-logs'): void
  (name: 'filter-path', path: string): void
}>()

interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
}

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
const isFollowing = ref(true)
const isViewingLatest = ref(true)
const nativeScrollbarWidth = ref(0)
const loadingBefore = ref(false)
const loadCursor = ref<string | undefined>()
const hasMoreBefore = ref(true)
const logMenu = ref<LogMenuState | null>(null)
const logMenuElement = ref<HTMLElement | null>(null)
const logMenuStyle = ref({ left: '0px', top: '0px' })
const logWindow = ref<VirtualListWindow>({ start: 0, end: 0, paddingTop: 0, paddingBottom: 0 })

watch(() => props.loadCursor, (cursor) => {
  loadCursor.value = cursor
})
let lastScrollTop = 0
let pausedPosition: PausedLogPosition | undefined
const layout = createVirtualListLayout(fallbackLineHeight)
// 日志行的 offsetTop 相对滚动容器的内边距盒，占位容器之前还有「查看更多消息」和顶部内边距
let contentTop = 0
let listWidth = 0
let windowFrame = 0
// 恢复滚动位置期间不让逐帧的高度修正插手，避免两处同时改 scrollTop 互相打断
let restoringPosition = false
let listResizeObserver: ResizeObserver | undefined

const listStyle = computed(() => props.maxHeight ? { maxHeight: props.maxHeight } : {})

// 只把窗口内的日志交给模板；下标取全量清单里的绝对下标，分隔行判定与锚点都依赖它
const visibleLogs = computed(() => {
  const items: VisibleLog[] = []
  for (let index = logWindow.value.start; index < logWindow.value.end; index++) {
    const record = props.logs[index]
    if (!record) continue
    items.push({ key: getLogKey(record), index, record, start: isStart(index) })
  }
  return items
})

// 更早的日志改为手动加载：滑到顶部才会看到这个入口，点击后才继续读取磁盘
const showLoadMore = computed(() => Boolean(props.loadBefore) && hasMoreBefore.value)

// 遮罩至少铺满列表右侧内边距：占位型滚动条按实测宽度盖住，覆盖式滚动条画在内边距上也一并盖住。
// 内边距区域本来就没有内容，铺同色底不会遮住日志正文
const scrollbarGutterWidth = computed(() => `max(1rem, ${nativeScrollbarWidth.value}px)`)

function scrollToBottom() {
  if (!logList.value) return
  logList.value.scrollTop = logList.value.scrollHeight
  syncLogWindow()
  updateViewingLatest()
}

function measureContentTop() {
  contentTop = logViewport.value?.offsetTop ?? 0
  return contentTop
}

// 按当前滚动位置算出要渲染的日志区间。窗口外的高度用占位容器的内边距顶出来，
// 不能用 transform 位移：transform 不进 offsetTop，这里和锚点恢复的换算都会整段偏掉
function syncLogWindow() {
  const element = logList.value
  let scrollOffset: number
  let viewportHeight: number
  if (element) {
    scrollOffset = element.scrollTop - measureContentTop()
    viewportHeight = element.clientHeight
  } else {
    // 首帧还拿不到滚动容器，按浏览器视口高度先备一屏；追踪最新日志时备的是末尾那一屏
    viewportHeight = window.innerHeight
    scrollOffset = isFollowing.value ? Math.max(0, layout.totalHeight() - viewportHeight) : 0
  }
  const next = layout.getWindow(scrollOffset, viewportHeight, overscanHeight)
  const current = logWindow.value
  if (next.start === current.start && next.end === current.end
    && next.paddingTop === current.paddingTop && next.paddingBottom === current.paddingBottom) return
  logWindow.value = next
}

// 量窗口内各行的真实高度，返回偏移是否需要重算
function measureRenderedLines() {
  const viewport = logViewport.value
  if (!viewport) return false
  let changed = false
  for (const line of viewport.querySelectorAll<HTMLElement>('[data-log-key]')) {
    const key = line.dataset.logKey
    if (!key) continue
    if (layout.measure(key, line.getBoundingClientRect().height)) changed = true
  }
  return changed
}

/**
 * 实测高度会改变占位高度，视口里的内容随之上下移动，因此必须按锚点把位置挪回去。
 *
 * 锚点要在改动占位高度之前取，否则读到的已经是移动后的位置；追踪最新日志时不需要锚点，
 * 直接重新贴到底部即可。
 */
async function settleLogWindow(anchor?: PausedLogPosition) {
  const element = logList.value
  if (!element) return
  if (measureRenderedLines()) {
    syncLogWindow()
    await nextTick()
  }
  if (isFollowing.value && !restoringPosition) {
    scrollToBottom()
  } else if (anchor) {
    restorePausedLogPosition(element, anchor)
    syncLogWindow()
  }
  updateViewingLatest()
  updateNativeScrollbarWidth()
}

function scheduleLogWindow() {
  if (windowFrame) return
  windowFrame = requestAnimationFrame(async () => {
    windowFrame = 0
    const element = logList.value
    const anchor = element && !isFollowing.value && !restoringPosition
      ? capturePausedLogPosition(element)
      : undefined
    syncLogWindow()
    await nextTick()
    await settleLogWindow(anchor)
  })
}

/**
 * 把视口滚回锚点所在的日志。
 *
 * 锚点那条日志可能落在渲染窗口之外，此时 DOM 里根本没有它：先按布局偏移粗定位，
 * 等窗口渲染出来并量过高度，再用锚点的实际位置精调一次。
 */
async function restoreLogPosition(anchor?: PausedLogPosition) {
  const element = logList.value
  if (!element || !anchor) return
  restoringPosition = true
  try {
    const index = layout.indexOf(anchor.key)
    if (index >= 0) {
      element.scrollTop = measureContentTop() + layout.offsetOf(index) - anchor.offset
      syncLogWindow()
      await nextTick()
      measureRenderedLines()
      syncLogWindow()
      await nextTick()
    }
    restorePausedLogPosition(element, anchor)
    syncLogWindow()
    updateViewingLatest()
  } finally {
    restoringPosition = false
  }
}

function updateViewingLatest() {
  const element = logList.value
  if (!element) return
  isViewingLatest.value = element.scrollTop + element.clientHeight + 64 >= element.scrollHeight
  lastScrollTop = element.scrollTop
}

// 少数浏览器与用户样式会忽略 scrollbar-width / scrollbar-color，仍然给日志列表画出原生滚动条，
// 轨道底色比日志区域更深，右侧会出现一条竖带。实测滚动条占位宽度，交给同色遮罩盖平。
function updateNativeScrollbarWidth() {
  const element = logList.value
  if (!element) return
  nativeScrollbarWidth.value = Math.max(0, element.offsetWidth - element.clientWidth)
}

// 容器宽度一变，之前量到的换行高度全部失效；清空重量，并按锚点保住当前位置
function handleListResize() {
  const element = logList.value
  if (!element) return
  const width = element.clientWidth
  if (width !== listWidth) {
    listWidth = width
    layout.forgetHeights()
  }
  scheduleLogWindow()
}

function setFollowing(value: boolean) {
  if (isFollowing.value === value) return
  isFollowing.value = value
  if (value) pausedPosition = undefined
}

function followLatest() {
  setFollowing(true)
  isViewingLatest.value = true
  nextTick(() => requestAnimationFrame(() => {
    scrollToBottom()
    scheduleLogWindow()
  }))
}

function markViewingLogs() {
  emit('view-logs')
}

function returnToLatest() {
  markViewingLogs()
  followLatest()
}

function rememberPausedPosition() {
  const element = logList.value
  if (!props.preservePausedPositionOnReturn || !element || isFollowing.value) return
  const position = capturePausedLogPosition(element)
  if (position) pausedPosition = position
}

async function loadBeforeLogs() {
  const element = logList.value
  if (!element || !props.loadBefore || loadingBefore.value || !hasMoreBefore.value) return
  // 前插会把已加载的日志整体推下去，先记住视口最上方那条，插完再按它把位置挪回来
  const anchor = capturePausedLogPosition(element)
  const firstLog = props.logs[0]
  markViewingLogs()
  loadingBefore.value = true
  try {
    const page = await send('logger-plus/load-before', {
      date: props.loadDate || undefined,
      path: props.loadPath || undefined,
      type: props.loadType || undefined,
      search: props.loadSearch || undefined,
      searchPaths: props.loadSearchPaths,
      cursor: loadCursor.value ?? (firstLog ? `${firstLog.timestamp}:${firstLog.id}` : undefined),
    }) as LogPage
    loadCursor.value = page.cursor
    hasMoreBefore.value = page.hasMore
    if (!page.logs.length) return
    restoringPosition = true
    emit('prepend-logs', page.logs, page.cursor)
    await nextTick()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
    await restoreLogPosition(anchor)
  } catch {
    message.error('加载更早日志失败')
  } finally {
    restoringPosition = false
    loadingBefore.value = false
  }
}

function handleScroll() {
  const element = logList.value
  if (!element) return
  const previousScrollTop = lastScrollTop
  updateViewingLatest()
  closeLogMenu()
  if (element.scrollTop < previousScrollTop) {
    setFollowing(false)
  } else if (isViewingLatest.value) {
    setFollowing(true)
  }
  // 滚动当帧先按已有高度换出新窗口，避免等到下一帧才补上内容
  syncLogWindow()
  rememberPausedPosition()
  scheduleLogWindow()
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
  const element = logList.value
  if (element) {
    listWidth = element.clientWidth
    // 估算行高取排版令牌的实测值，不在脚本里另写一份字面字号
    layout.setEstimatedHeight(Number.parseFloat(getComputedStyle(element).lineHeight) || fallbackLineHeight)
    if (typeof ResizeObserver !== 'undefined') {
      listResizeObserver = new ResizeObserver(handleListResize)
      listResizeObserver.observe(element)
    }
  }
  requestAnimationFrame(() => {
    syncLogWindow()
    scrollToBottom()
    updateNativeScrollbarWidth()
    scheduleLogWindow()
  })
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('keydown', handleDocumentKeydown)
  window.addEventListener('resize', closeLogMenu)
  window.addEventListener('resize', updateNativeScrollbarWidth)
  window.addEventListener('blur', closeLogMenu)
})

onUnmounted(() => {
  if (windowFrame) cancelAnimationFrame(windowFrame)
  listResizeObserver?.disconnect()
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('keydown', handleDocumentKeydown)
  window.removeEventListener('resize', closeLogMenu)
  window.removeEventListener('resize', updateNativeScrollbarWidth)
  window.removeEventListener('blur', closeLogMenu)
})

onActivated(() => {
  markViewingLogs()
  if (props.preservePausedPositionOnReturn && !isFollowing.value) {
    nextTick(() => requestAnimationFrame(() => {
      void restoreLogPosition(pausedPosition)
    }))
    return
  }
  if (props.resetFollowOnEnter) followLatest()
})

onDeactivated(() => {
  closeLogMenu()
  if (!props.preservePausedPositionOnReturn || isFollowing.value) {
    pausedPosition = undefined
    return
  }
  rememberPausedPosition()
})

// 日志条数变了就要重排窗口。实时推送是就地追加，数组引用不变，因此长度也要一起侦听
watch([() => props.logs, () => props.logs.length], () => {
  layout.setItems(props.logs.map(getLogKey))
  syncLogWindow()
  scheduleLogWindow()
}, { immediate: true })

function isStart(index: number) {
  return index > 0 && props.logs[index - 1].id > props.logs[index].id && props.logs[index].name === 'app'
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
  const indent = showTime.length + 5
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
  color: var(--terminal-fg);
  background-color: var(--terminal-bg);
  padding: 1rem 1rem;

  // 虚拟滚动的占位容器：窗口之外的日志高度全部折进上下内边距，
  // 因此容器自身高度始终等于全部日志的高度，原生滚动条与自绘滑块都不必特殊处理
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
