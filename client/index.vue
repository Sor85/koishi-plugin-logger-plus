<template>
  <k-layout>
    <div
      ref="filterElement"
      :class="['logger-filter', { collapsed: isFilterCollapsed }]"
      @click="expandFilter"
    >
      <span class="logger-filter-dot"></span>
      <label class="logger-filter-summary" for="logger-filter-path">过滤</label>
      <PluginSelect
        id="logger-filter-path"
        v-model="selectedPath"
        :open="showPluginPicker"
        :options="plugins"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @update:open="setPluginPickerOpen"
      />
      <label for="logger-filter-date">日期</label>
      <DatePicker
        id="logger-filter-date"
        v-model="selectedDate"
        :open="showDatePicker"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @update:open="setDatePickerOpen"
      />
      <button
        v-if="selectedDate"
        class="logger-filter-clear"
        type="button"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @click="clearDate"
      >清除</button>
    </div>
    <logs
      :key="`${selectedPath}:${selectedDate}:${historyResetKey}`"
      class="layout-logger"
      :logs="filteredLogs"
      show-link
      reset-follow-on-enter
      load-before
      :load-date="selectedDate"
      :load-path="selectedPath"
      :load-cursor="selectedDate ? dateCursor : undefined"
      :preserve-paused-position-on-return="preservePausedPositionOnReturn"
      @prepend-logs="prependLoadedLogs"
      @view-logs="resetHistoryUnloadTimer"
      @filter-path="selectedPath = $event"
    ></logs>
  </k-layout>
</template>

<script lang="ts" setup>

import { send, store } from '@koishijs/client'
import Logger from 'reggol'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DatePicker from './date-picker.vue'
import Logs from './logs.vue'
import { mergeLogRecords } from './log-record'
import PluginSelect from './plugin-select.vue'

interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
}

const selectedPath = ref('')
const selectedDate = ref('')
const historyLogs = ref<Logger.Record[]>([])
const historyResetKey = ref(0)
const dateLogs = ref<Logger.Record[]>([])
const dateCursor = ref<string | undefined>()
const showPluginPicker = ref(false)
const showDatePicker = ref(false)
const filterElement = ref<HTMLElement | null>(null)
const isFilterExpanded = ref(false)
const historyUnloadDelay = 30 * 60 * 1000
let dateRequestId = 0
let historyUnloadTimer: ReturnType<typeof setTimeout> | undefined

function getPluginLabel(path: string) {
  const entry = findPluginEntry(path, store.config?.plugins)
  if (!entry) return path
  return entry.label || entry.name
}

function findPluginEntry(path: string, plugins: Record<string, any>): { name: string, label?: string } | undefined {
  if (!plugins) return
  for (let key in plugins) {
    if (key.startsWith('$')) continue
    const config = plugins[key]
    if (key.startsWith('~')) key = key.slice(1)
    const name = key.split(':', 1)[0]
    const currentPath = key.includes(':') ? key.slice(name.length + 1) : undefined
    if (currentPath === path) return { name, label: config?.$label }
    if (key.startsWith('group:')) {
      const result = findPluginEntry(path, config)
      if (result) return result
    }
  }
}

function findLoggerPlusConfig(plugins: Record<string, any>): {
  autoUnloadHistoryLogs?: boolean
  preservePausedPositionOnReturn?: boolean
} | undefined {
  if (!plugins || typeof plugins !== 'object') return
  for (let key in plugins) {
    if (key.startsWith('$')) continue
    const config = plugins[key]
    if (key.startsWith('~')) key = key.slice(1)
    const name = key.split(':', 1)[0]
    if (name === 'logger-plus') return config
    if (key.startsWith('group:')) {
      const result = findLoggerPlusConfig(config)
      if (result) return result
    }
  }
}

function getRecordPaths(record: Logger.Record) {
  return (record.meta as { paths?: string[] } | undefined)?.paths ?? []
}

const plugins = computed(() => {
  const paths = new Set<string>()
  for (const record of [...historyLogs.value, ...(store.logs ?? []), ...dateLogs.value]) {
    for (const path of getRecordPaths(record)) {
      paths.add(path)
    }
  }
  return [...paths]
    .map(path => ({ path, label: getPluginLabel(path) }))
    .sort((left, right) => left.label.localeCompare(right.label))
})

const liveLogs = computed(() => {
  const logs = historyLogs.value.length
    ? mergeLogRecords(historyLogs.value, store.logs ?? [])
    : store.logs ?? []
  if (!selectedPath.value) return logs
  return logs.filter(record => getRecordPaths(record).includes(selectedPath.value))
})

const filteredLogs = computed(() => selectedDate.value ? dateLogs.value : liveLogs.value)

const hasActiveFilter = computed(() => !!selectedPath.value || !!selectedDate.value)

const isFilterCollapsed = computed(() => !isFilterExpanded.value && !hasActiveFilter.value && !showPluginPicker.value && !showDatePicker.value)

const autoUnloadHistoryLogs = computed(() => findLoggerPlusConfig(store.config?.plugins)?.autoUnloadHistoryLogs !== false)
const preservePausedPositionOnReturn = computed(() => findLoggerPlusConfig(store.config?.plugins)?.preservePausedPositionOnReturn === true)

function hasLoadedHistoryLogs() {
  return historyLogs.value.length > 0 || dateLogs.value.length > 0 || !!dateCursor.value
}

function clearHistoryUnloadTimer() {
  clearTimeout(historyUnloadTimer)
  historyUnloadTimer = undefined
}

function unloadHistoryLogs() {
  dateRequestId++
  historyLogs.value = []
  historyResetKey.value++
  dateLogs.value = []
  dateCursor.value = undefined
  clearHistoryUnloadTimer()
  if (selectedDate.value) selectedDate.value = ''
}

function resetHistoryUnloadTimer() {
  clearHistoryUnloadTimer()
  if (!autoUnloadHistoryLogs.value || !hasLoadedHistoryLogs()) return
  historyUnloadTimer = setTimeout(unloadHistoryLogs, historyUnloadDelay)
}

async function animateFilterWidth(fromWidth: number) {
  await nextTick()
  const element = filterElement.value
  if (!element) return
  const toWidth = element.getBoundingClientRect().width
  element.getAnimations().forEach(animation => animation.cancel())
  element.animate([
    { width: `${fromWidth}px` },
    { width: `${toWidth}px` },
  ], {
    duration: 180,
    easing: 'ease-out',
  })
}

function expandFilter() {
  if (!isFilterCollapsed.value || !filterElement.value) return
  const fromWidth = filterElement.value.getBoundingClientRect().width
  isFilterExpanded.value = true
  void animateFilterWidth(fromWidth)
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (filterElement.value?.contains(event.target as Node)) return
  const fromWidth = filterElement.value?.getBoundingClientRect().width
  showPluginPicker.value = false
  showDatePicker.value = false
  if (!hasActiveFilter.value) {
    isFilterExpanded.value = false
    if (fromWidth !== undefined) void animateFilterWidth(fromWidth)
  }
}

function setPluginPickerOpen(open: boolean) {
  showPluginPicker.value = open
  if (open) showDatePicker.value = false
}

function setDatePickerOpen(open: boolean) {
  showDatePicker.value = open
  if (open) showPluginPicker.value = false
}

function clearDate() {
  selectedDate.value = ''
  showDatePicker.value = false
}

function prependLoadedLogs(logs: Logger.Record[], cursor?: string) {
  if (selectedDate.value) {
    dateLogs.value = [...logs, ...dateLogs.value]
    dateCursor.value = cursor
  } else {
    historyLogs.value = mergeLogRecords(historyLogs.value, logs)
  }
  resetHistoryUnloadTimer()
}

watch([selectedDate, selectedPath], async ([date, path]) => {
  if (date || path) isFilterExpanded.value = true
  const requestId = ++dateRequestId
  dateLogs.value = []
  dateCursor.value = undefined
  clearHistoryUnloadTimer()
  if (!date && !path) {
    resetHistoryUnloadTimer()
    return
  }
  const page = await send('logger-plus/load-before', {
    date: date || undefined,
    path: path || undefined,
  }) as LogPage
  if (requestId !== dateRequestId) return
  if (date) {
    dateLogs.value = page.logs
    dateCursor.value = page.cursor
  } else {
    historyLogs.value = mergeLogRecords(historyLogs.value, page.logs)
  }
  resetHistoryUnloadTimer()
})

watch(autoUnloadHistoryLogs, (enabled) => {
  if (enabled) {
    resetHistoryUnloadTimer()
  } else {
    clearHistoryUnloadTimer()
  }
})

onMounted(() => document.addEventListener('pointerdown', handleDocumentPointerDown))

onUnmounted(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  clearHistoryUnloadTimer()
})

</script>

<style scoped lang="scss">

.logger-filter {
  position: absolute;
  top: 0.75rem;
  left: 1rem;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--terminal-fg);
  background: var(--terminal-bg-hover);
  background: color-mix(in srgb, var(--terminal-bg-hover) 58%, transparent);
  border: 1px solid var(--terminal-separator);
  border-color: color-mix(in srgb, var(--terminal-separator) 70%, var(--terminal-fg));
  border-radius: 999px;
  box-sizing: border-box;
  width: fit-content;
  max-width: 44rem;
  min-width: 2.35rem;
  height: 2.35rem;
  min-height: 2.35rem;
  padding: 0.35rem 0.35rem 0.35rem 0.65rem;
  line-height: 1.25rem;
  box-shadow: 0 10px 28px rgb(0 0 0 / 18%), inset 0 1px 0 rgb(255 255 255 / 8%);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  transition: padding 0.18s ease-out, gap 0.18s ease-out, border-color 0.18s ease-out, box-shadow 0.18s ease-out;

  > :not(.logger-filter-dot):not(.logger-filter-summary) {
    max-width: 22rem;
    opacity: 1;
    transform: translateX(0) scale(1);
    transition: opacity 0.14s ease-out 0.04s, transform 0.18s ease-out, max-width 0.24s ease-out, margin 0.2s ease-out;
  }

  .logger-filter-summary {
    transition: color 0.16s ease, opacity 0.16s ease, transform 0.18s ease;
  }

  &.collapsed {
    width: 3.85rem;
    max-width: 44rem;
    height: 2.35rem;
    min-height: 2.35rem;
    gap: 0.4rem;
    padding: 0.35rem 0.66rem;
    overflow: hidden;
    cursor: pointer;
    border-radius: 999px;
    background: color-mix(in srgb, var(--terminal-bg-hover) 58%, transparent);
    box-shadow: 0 8px 20px rgb(0 0 0 / 28%), 0 0 0 1px color-mix(in srgb, var(--terminal-separator) 62%, transparent);

    > :not(.logger-filter-dot):not(.logger-filter-summary) {
      opacity: 0;
      pointer-events: none;
      transform: translateX(-0.35rem) scale(0.96);
    }

    .logger-filter-dot {
      width: 0.42rem;
      height: 0.42rem;
      margin: 0;
      background: color-mix(in srgb, var(--terminal-fg) 86%, transparent);
      box-shadow: 0 0 12px color-mix(in srgb, var(--terminal-fg) 46%, transparent);
    }

    .logger-filter-summary {
      max-width: 2rem;
      opacity: 1;
      color: color-mix(in srgb, var(--terminal-fg) 84%, transparent);
      white-space: nowrap;
      transform: none;
    }

    &:hover .logger-filter-dot {
      background: #22c55e;
      box-shadow: 0 0 14px color-mix(in srgb, #22c55e 78%, transparent);
    }
  }

  label {
    color: var(--terminal-fg);
    color: color-mix(in srgb, var(--terminal-fg) 78%, transparent);
    font-size: 12px;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

}

.logger-filter-dot {
  flex: 0 0 auto;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: #22c55e;
  background: color-mix(in srgb, var(--terminal-fg-hover) 75%, #22c55e);
  box-shadow: 0 0 12px #22c55e;
  box-shadow: 0 0 12px color-mix(in srgb, var(--terminal-fg-hover) 55%, #22c55e);
  transition: width 0.16s ease-out, height 0.16s ease-out, background-color 0.16s ease-out, box-shadow 0.16s ease-out;
}

.logger-filter-clear {
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 999px;
  padding: 0.15rem 0.5rem;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: var(--terminal-fg-hover);
    background: var(--terminal-bg-hover);
  }
}

</style>
