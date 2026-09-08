<!--
  日志列表展示组件
  负责渲染日志内容和控制最新日志追踪
-->
<template>
  <div class="logger-container">
    <button :class="['logger-follow', { visible: showFollowStatus, active: isFollowing }]" type="button" @click="toggleFollow">
      <span class="logger-follow-dot"></span>
      {{ isFollowing ? '追踪中' : '已暂停' }}
    </button>
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
      <div
        v-for="(record, index) in logs"
        :key="getLogKey(record)"
        v-memo="[getLogKey(record), index]"
        :data-log-index="index"
        :data-log-key="getLogKey(record)"
        :class="['line', `level-${record.type}`, { start: isStart(index) }]"
        @contextmenu.prevent="openLogMenu(record, $event)"
      >
        <code><span v-html="renderPrefix(record)"></span><button
          v-if="getPrimaryPath(record)"
          class="log-name"
          type="button"
          :title="`筛选 ${record.name} 的日志`"
          @click="filterByRecord(record)"
          v-html="renderName(record)"
        ></button><span v-else v-html="renderName(record)"></span><span v-html="renderContent(record)"></span></code>
        <span class="log-actions">
          <button class="log-action" type="button" title="复制整段日志" @click="copyLine(record)">
            <k-icon name="activity:copy"/>
          </button>
          <router-link
            class="log-action"
            v-if="showLink && store.config && store.packages && record.meta?.paths?.length"
            :to="'/plugins/' + record.meta.paths[0].replace(/\./, '/')"
            title="前往插件配置"
          >
            <k-icon name="arrow-right"/>
          </router-link>
        </span>
      </div>
    </div>
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
import type { PausedLogPosition } from './log-position'
import { capturePausedLogPosition, restorePausedLogPosition } from './log-position'
import { getLogKey } from './log-record'
import { vOverlayScrollbar } from './overlay-scrollbar'

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
const logList = ref<HTMLElement | null>(null)
const isFollowing = ref(true)
const isViewingLatest = ref(true)
const showFollowStatus = ref(false)
const loadingBefore = ref(false)
const loadCursor = ref<string | undefined>()
const hasMoreBefore = ref(true)
const logMenu = ref<LogMenuState | null>(null)
const logMenuElement = ref<HTMLElement | null>(null)
const logMenuStyle = ref({ left: '0px', top: '0px' })

watch(() => props.loadCursor, (cursor) => {
  loadCursor.value = cursor
})
let lastScrollTop = 0
let followStatusTimer: ReturnType<typeof setTimeout> | undefined
let pausedPosition: PausedLogPosition | undefined

const listStyle = computed(() => props.maxHeight ? { maxHeight: props.maxHeight } : {})

// 更早的日志改为手动加载：滑到顶部才会看到这个入口，点击后才继续读取磁盘
const showLoadMore = computed(() => Boolean(props.loadBefore) && hasMoreBefore.value)

function scrollToBottom() {
  if (!logList.value) return
  logList.value.scrollTop = logList.value.scrollHeight
  updateViewingLatest()
}

function updateViewingLatest() {
  const element = logList.value
  if (!element) return
  isViewingLatest.value = element.scrollTop + element.clientHeight + 64 >= element.scrollHeight
  lastScrollTop = element.scrollTop
}

function updateFollowStatusVisibility() {
  showFollowStatus.value = true
  clearTimeout(followStatusTimer)
  if (!isFollowing.value) return
  followStatusTimer = setTimeout(() => {
    showFollowStatus.value = false
  }, 1600)
}

function setFollowing(value: boolean) {
  if (isFollowing.value === value) return
  isFollowing.value = value
  if (value) pausedPosition = undefined
  updateFollowStatusVisibility()
}

function followLatest() {
  setFollowing(true)
  isViewingLatest.value = true
  nextTick(() => requestAnimationFrame(scrollToBottom))
}

function markViewingLogs() {
  emit('view-logs')
}

function toggleFollow() {
  markViewingLogs()
  if (isFollowing.value) {
    setFollowing(false)
    rememberPausedPosition()
    return
  }
  followLatest()
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

function getVisibleAnchor(element: HTMLElement) {
  const lines = Array.from(element.querySelectorAll<HTMLElement>('[data-log-index]'))
  return lines.find(line => line.offsetTop + line.offsetHeight >= element.scrollTop)
}

async function loadBeforeLogs() {
  const element = logList.value
  if (!element || !props.loadBefore || loadingBefore.value || !hasMoreBefore.value) return
  const anchor = getVisibleAnchor(element)
  const anchorIndex = anchor ? Number(anchor.dataset.logIndex) : undefined
  const anchorOffset = anchor ? anchor.offsetTop - element.scrollTop : 0
  const firstLog = props.logs[0]
  markViewingLogs()
  loadingBefore.value = true
  try {
    const page = await send('logger-plus/load-before', {
      date: props.loadDate || undefined,
      path: props.loadPath || undefined,
      type: props.loadType || undefined,
      search: props.loadSearch || undefined,
      cursor: loadCursor.value ?? (firstLog ? `${firstLog.timestamp}:${firstLog.id}` : undefined),
    }) as LogPage
    loadCursor.value = page.cursor
    hasMoreBefore.value = page.hasMore
    if (!page.logs.length) return
    emit('prepend-logs', page.logs, page.cursor)
    await nextTick()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const current = logList.value
        const currentAnchor = anchorIndex === undefined ? undefined : current?.querySelector<HTMLElement>(`[data-log-index="${anchorIndex + page.logs.length}"]`)
        if (current && currentAnchor) {
          current.scrollTop = currentAnchor.offsetTop - anchorOffset
        }
        resolve()
      })
    })
  } catch {
    message.error('加载更早日志失败')
  } finally {
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
  rememberPausedPosition()
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
  requestAnimationFrame(scrollToBottom)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('keydown', handleDocumentKeydown)
  window.addEventListener('resize', closeLogMenu)
  window.addEventListener('blur', closeLogMenu)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('keydown', handleDocumentKeydown)
  window.removeEventListener('resize', closeLogMenu)
  window.removeEventListener('blur', closeLogMenu)
  clearTimeout(followStatusTimer)
})

onActivated(() => {
  markViewingLogs()
  if (props.preservePausedPositionOnReturn && !isFollowing.value) {
    nextTick(() => requestAnimationFrame(() => {
      if (logList.value) restorePausedLogPosition(logList.value, pausedPosition)
      updateViewingLatest()
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

watch(() => props.logs.length, async () => {
  await nextTick()
  requestAnimationFrame(() => {
    if (isFollowing.value) scrollToBottom()
    updateViewingLatest()
  })
})

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

async function copyLine(record: Logger.Record) {
  await copyText(formatLine(record), '已复制日志')
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

.logger-follow {
  position: absolute;
  top: 0.75rem;
  right: 1rem;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  color: var(--terminal-fg);
  color: color-mix(in srgb, var(--terminal-fg) 82%, transparent);
  background: var(--terminal-bg-hover);
  background: color-mix(in srgb, var(--terminal-bg-hover) 58%, transparent);
  border: 1px solid var(--terminal-separator);
  border-color: color-mix(in srgb, var(--terminal-separator) 70%, var(--terminal-fg));
  border-radius: 999px;
  padding: 0.35rem 0.75rem;
  line-height: 1.25rem;
  cursor: pointer;
  opacity: 0;
  box-shadow: 0 10px 28px rgb(0 0 0 / 18%), inset 0 1px 0 rgb(255 255 255 / 8%);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;

  &.visible,
  &:hover,
  &:focus-visible {
    opacity: 1;
  }

  &:hover,
  &:focus-visible {
    color: var(--terminal-fg-hover);
    background: var(--terminal-bg-hover);
    background: color-mix(in srgb, var(--terminal-bg-hover) 72%, var(--terminal-bg));
    border-color: var(--terminal-separator);
  }

  &.active .logger-follow-dot {
    background: #22c55e;
    box-shadow: 0 0 12px #22c55e;
  }
}

.logger-follow-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: #f59e0b;
  box-shadow: 0 0 12px #f59e0b;
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
  height: 100%;
  overflow-y: auto;
  color: var(--terminal-fg);
  background-color: var(--terminal-bg);
  padding: 1rem 1rem;

  .line.start {
    margin-top: 1rem;

    &::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: -0.5rem;
      border-top: 1px solid var(--terminal-separator);
    }
  }

  .line:first-child {
    margin-top: 0;

    &::before {
      display: none;
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

    &:hover .log-actions,
    &:focus-within .log-actions {
      opacity: 1;
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

  .log-actions {
    position: absolute;
    right: 0.25rem;
    bottom: 0;
    display: inline-flex;
    align-items: center;
    opacity: 0;
    transition: opacity 0.15s ease;
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

  .log-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    color: inherit;
    background: transparent;
    border: none;
    padding: 0 0.25rem;
    cursor: pointer;
    line-height: 20px;
    text-decoration: none;

    &:hover {
      color: var(--terminal-fg-hover);
    }
  }

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
