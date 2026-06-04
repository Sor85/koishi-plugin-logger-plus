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
      ref="logList"
      class="log-list k-text-selectable"
      :style="listStyle"
      @scroll="handleScroll"
      @wheel.passive="markViewingLogs"
      @pointerdown="markViewingLogs"
    >
      <div
        v-for="(record, index) in logs"
        :key="getLogKey(record)"
        :data-log-index="index"
        :data-log-key="getLogKey(record)"
        :class="{ line: true, start: isStart(index) }"
      >
        <code v-html="renderLine(record)"></code>
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
  </div>
</template>

<script lang="ts" setup>

import { Time, message, send, store } from '@koishijs/client'
import {} from '@koishijs/plugin-config'
import Logger from 'reggol'
import ansi from 'ansi_up'
import { computed, nextTick, onActivated, onDeactivated, onMounted, ref, watch } from 'vue'
import type { PausedLogPosition } from './log-position'
import { capturePausedLogPosition, restorePausedLogPosition } from './log-position'
import { getLogKey } from './log-record'

const props = defineProps<{
  logs: Logger.Record[],
  showLink?: boolean,
  maxHeight?: string,
  resetFollowOnEnter?: boolean,
  preservePausedPositionOnReturn?: boolean,
  loadBefore?: boolean,
  loadDate?: string,
  loadPath?: string,
  loadCursor?: string,
}>()

const emit = defineEmits<{
  (name: 'prepend-logs', logs: Logger.Record[], cursor?: string): void
  (name: 'view-logs'): void
}>()

interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
}

// this package does not have consistent exports in different environments
const converter = new (ansi['default'] || ansi)()
converter.escape_for_html = true

function renderColor(code: number, value: any, decoration = '') {
  return `\u001b[3${code < 8 ? code : '8;5;' + code}${decoration}m${value}\u001b[0m`
}

const showTime = 'yyyy-MM-dd hh:mm:ss'
const preloadLogThreshold = 150
const logList = ref<HTMLElement | null>(null)
const isFollowing = ref(true)
const isViewingLatest = ref(true)
const showFollowStatus = ref(false)
const loadingBefore = ref(false)
const loadCursor = ref<string | undefined>()
const hasMoreBefore = ref(true)

watch(() => props.loadCursor, (cursor) => {
  loadCursor.value = cursor
})
let lastScrollTop = 0
let followStatusTimer: ReturnType<typeof setTimeout> | undefined
let pausedPosition: PausedLogPosition | undefined

const listStyle = computed(() => props.maxHeight ? { maxHeight: props.maxHeight } : {})

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

function getVisibleStartIndex(element: HTMLElement) {
  const anchor = getVisibleAnchor(element)
  return anchor ? Number(anchor.dataset.logIndex) : props.logs.length
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
  if (getVisibleStartIndex(element) <= preloadLogThreshold) {
    loadBeforeLogs()
  }
  if (element.scrollTop < previousScrollTop) {
    setFollowing(false)
  } else if (isViewingLatest.value) {
    setFollowing(true)
  }
  rememberPausedPosition()
}

onMounted(() => {
  requestAnimationFrame(scrollToBottom)
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

function formatLine(record: Logger.Record, color = false) {
  const prefix = `[${record.type[0].toUpperCase()}]`
  const space = ' '
  let indent = 3 + space.length, output = ''
  indent += showTime.length + space.length
  output += (color ? renderColor(8, Time.template(showTime, new Date(record.timestamp))) : Time.template(showTime, new Date(record.timestamp))) + space
  const code = Logger.code(record.name, { colors: 3 })
  const label = color ? renderColor(code, record.name, ';1') : record.name
  const padLength = label.length - record.name.length
  output += prefix + space + label.padEnd(padLength) + space
  output += record.content.replace(/\n/g, '\n' + ' '.repeat(indent))
  return output
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

async function copyLine(record: Logger.Record) {
  try {
    await writeClipboard(formatLine(record))
    message.success('已复制日志')
  } catch {
    message.error('复制失败')
  }
}

function renderLine(record: Logger.Record) {
  return converter.ansi_to_html(formatLine(record, true))
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
  background: color-mix(in srgb, var(--terminal-bg-hover) 86%, transparent);
  border: 1px solid var(--terminal-separator);
  border-color: color-mix(in srgb, var(--terminal-separator) 70%, var(--terminal-fg));
  border-radius: 999px;
  padding: 0.35rem 0.75rem;
  line-height: 1.25rem;
  cursor: pointer;
  opacity: 0;
  box-shadow: 0 10px 28px rgb(0 0 0 / 18%), inset 0 1px 0 rgb(255 255 255 / 8%);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
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

.log-list {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  color: var(--terminal-fg);
  background-color: var(--terminal-bg);
  padding: 1rem 1rem;
  scrollbar-width: auto;
  scrollbar-color: var(--terminal-separator) transparent;
  scrollbar-color: color-mix(in srgb, var(--terminal-fg) 36%, var(--terminal-bg)) transparent;

  &::-webkit-scrollbar {
    width: 1rem;
    height: 1rem;
  }

  &::-webkit-scrollbar-track,
  &::-webkit-scrollbar-corner {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--terminal-separator);
    background: color-mix(in srgb, var(--terminal-fg) 36%, var(--terminal-bg));
    border: 0.25rem solid transparent;
    border-radius: 999px;
    background-clip: content-box;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: var(--terminal-fg);
    background: color-mix(in srgb, var(--terminal-fg) 55%, var(--terminal-bg));
    background-clip: content-box;
  }

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
    font-size: 14px;
    line-height: 20px;
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

  .log-actions {
    position: absolute;
    right: 0.25rem;
    bottom: 0;
    display: inline-flex;
    align-items: center;
    opacity: 0;
    transition: opacity 0.15s ease;
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

</style>
