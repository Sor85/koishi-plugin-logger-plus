<template>
  <k-layout>
    <div
      ref="filterElement"
      :class="['logger-filter', { collapsed: isFilterCollapsed }]"
      @click="expandFilter"
    >
      <span class="logger-filter-dot"></span>
      <label class="logger-filter-summary" for="logger-filter-path">过滤</label>
      <select id="logger-filter-path" v-model="selectedPath" :tabindex="isFilterCollapsed ? -1 : undefined">
        <option value="">全部插件</option>
        <option v-for="plugin in plugins" :key="plugin.path" :value="plugin.path">
          {{ plugin.label }}
        </option>
      </select>
      <label for="logger-filter-date">日期</label>
      <button
        id="logger-filter-date"
        class="logger-date-trigger"
        type="button"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @click="toggleDatePicker"
      >
        <span>{{ selectedDateLabel }}</span>
        <span class="logger-date-icon"></span>
      </button>
      <button
        v-if="selectedDate"
        class="logger-filter-clear"
        type="button"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @click="clearDate"
      >清除</button>
      <div v-if="showDatePicker" class="logger-date-popover">
        <div class="logger-date-header">
          <button type="button" @click="shiftMonth(-1)">‹</button>
          <strong>{{ calendarTitle }}</strong>
          <button type="button" @click="shiftMonth(1)">›</button>
        </div>
        <div class="logger-date-weekdays">
          <span v-for="weekday in weekdays" :key="weekday">{{ weekday }}</span>
        </div>
        <div class="logger-date-grid">
          <button
            v-for="day in calendarDays"
            :key="day.key"
            :class="{ muted: !day.currentMonth, today: day.date === todayDate, selected: day.date === selectedDate }"
            type="button"
            @click="selectDate(day.date)"
          >
            {{ day.day }}
          </button>
        </div>
      </div>
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
    ></logs>
  </k-layout>
</template>

<script lang="ts" setup>

import { send, store } from '@koishijs/client'
import Logger from 'reggol'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Logs from './logs.vue'
import { mergeLogRecords } from './log-record'

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
const showDatePicker = ref(false)
const filterElement = ref<HTMLElement | null>(null)
const isFilterExpanded = ref(false)
const visibleMonth = ref(new Date())
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const todayDate = formatDate(new Date())
const historyUnloadDelay = 30 * 60 * 1000
let dateRequestId = 0
let historyUnloadTimer: ReturnType<typeof setTimeout> | undefined

function formatDate(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function createDate(year: number, month: number, day: number) {
  return new Date(year, month, day)
}

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
  const logs = mergeLogRecords(historyLogs.value, store.logs ?? [])
  if (!selectedPath.value) return logs
  return logs.filter(record => getRecordPaths(record).includes(selectedPath.value))
})

const selectedDateLabel = computed(() => selectedDate.value || '选择日期')

const calendarTitle = computed(() => `${visibleMonth.value.getFullYear()} 年 ${visibleMonth.value.getMonth() + 1} 月`)

const calendarDays = computed(() => {
  const year = visibleMonth.value.getFullYear()
  const month = visibleMonth.value.getMonth()
  const firstDay = createDate(year, month, 1)
  const startOffset = (firstDay.getDay() + 6) % 7
  const start = createDate(year, month, 1 - startOffset)
  return Array.from({ length: 42 }, (_, index) => {
    const date = createDate(start.getFullYear(), start.getMonth(), start.getDate() + index)
    const value = formatDate(date)
    return {
      key: value,
      date: value,
      day: date.getDate(),
      currentMonth: date.getMonth() === month,
    }
  })
})

const filteredLogs = computed(() => selectedDate.value ? dateLogs.value : liveLogs.value)

const hasActiveFilter = computed(() => !!selectedPath.value || !!selectedDate.value)

const isFilterCollapsed = computed(() => !isFilterExpanded.value && !hasActiveFilter.value && !showDatePicker.value)

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

function expandFilter() {
  if (isFilterCollapsed.value) isFilterExpanded.value = true
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (filterElement.value?.contains(event.target as Node)) return
  showDatePicker.value = false
  if (!hasActiveFilter.value) isFilterExpanded.value = false
}

function toggleDatePicker() {
  showDatePicker.value = !showDatePicker.value
}

function shiftMonth(offset: number) {
  visibleMonth.value = createDate(visibleMonth.value.getFullYear(), visibleMonth.value.getMonth() + offset, 1)
}

function selectDate(date: string) {
  selectedDate.value = date
  const [year, month] = date.split('-').map(Number)
  visibleMonth.value = createDate(year, month - 1, 1)
  showDatePicker.value = false
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
  background: color-mix(in srgb, var(--terminal-bg-hover) 86%, transparent);
  border: 1px solid var(--terminal-separator);
  border-color: color-mix(in srgb, var(--terminal-separator) 70%, var(--terminal-fg));
  border-radius: 999px;
  box-sizing: border-box;
  width: 28rem;
  max-width: 44rem;
  min-width: 2.35rem;
  height: 2.35rem;
  min-height: 2.35rem;
  padding: 0.35rem 0.45rem 0.35rem 0.65rem;
  line-height: 1.25rem;
  box-shadow: 0 10px 28px rgb(0 0 0 / 18%), inset 0 1px 0 rgb(255 255 255 / 8%);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  transition: width 0.18s ease-out, padding 0.18s ease-out, gap 0.18s ease-out, border-color 0.18s ease-out, box-shadow 0.18s ease-out;

  > :not(.logger-filter-dot):not(.logger-filter-summary) {
    max-width: 14rem;
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
    background: color-mix(in srgb, var(--terminal-bg-hover) 82%, transparent);
    box-shadow: 0 8px 20px rgb(0 0 0 / 28%), 0 0 0 1px color-mix(in srgb, var(--terminal-separator) 62%, transparent);

    > :not(.logger-filter-dot):not(.logger-filter-summary) {
      min-width: 0;
      max-width: 0;
      width: 0;
      opacity: 0;
      margin: 0;
      padding-left: 0;
      padding-right: 0;
      border-width: 0;
      overflow: hidden;
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

  select,
  .logger-date-trigger {
    min-width: 7.5rem;
    max-width: 12rem;
    color: inherit;
    background: var(--terminal-bg);
    background: color-mix(in srgb, var(--terminal-bg) 70%, transparent);
    border: 1px solid transparent;
    border-radius: 999px;
    outline: none;
    padding: 0.15rem 0.6rem;
    cursor: pointer;
    transition: border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease;

    &:hover,
    &:focus-visible {
      color: var(--terminal-fg-hover);
      background: var(--terminal-bg-hover);
      background: color-mix(in srgb, var(--terminal-bg-hover) 72%, var(--terminal-bg));
      border-color: var(--terminal-separator);
    }
  }

  select {
    padding-right: 1.5rem;
  }
}

.logger-date-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.55rem;
  font: inherit;
}

.logger-date-icon {
  position: relative;
  width: 0.85rem;
  height: 0.85rem;
  border: 1px solid currentColor;
  border-radius: 0.2rem;
  opacity: 0.78;

  &::before {
    content: '';
    position: absolute;
    top: 0.18rem;
    left: -1px;
    right: -1px;
    border-top: 1px solid currentColor;
  }
}

.logger-date-popover {
  position: absolute;
  top: calc(100% + 0.55rem);
  left: 8.75rem;
  width: 18rem;
  color: var(--terminal-fg);
  background: var(--terminal-bg-hover);
  background: color-mix(in srgb, var(--terminal-bg-hover) 92%, transparent);
  border: 1px solid var(--terminal-separator);
  border-color: color-mix(in srgb, var(--terminal-separator) 78%, var(--terminal-fg));
  border-radius: 1.1rem;
  padding: 0.8rem;
  box-shadow: 0 20px 60px rgb(0 0 0 / 34%), inset 0 1px 0 rgb(255 255 255 / 8%);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.logger-date-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.7rem;

  strong {
    font-size: 0.95rem;
    letter-spacing: 0.04em;
  }

  button {
    width: 2rem;
    height: 2rem;
    color: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 999px;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;

    &:hover,
    &:focus-visible {
      color: var(--terminal-fg-hover);
      background: color-mix(in srgb, var(--terminal-bg) 72%, transparent);
      border-color: var(--terminal-separator);
    }
  }
}

.logger-date-weekdays,
.logger-date-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0.25rem;
}

.logger-date-weekdays {
  margin-bottom: 0.35rem;
  color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
  font-size: 0.75rem;
  text-align: center;
}

.logger-date-grid button {
  aspect-ratio: 1;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.65rem;
  font: inherit;
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease, background-color 0.12s ease, color 0.12s ease;

  &:hover,
  &:focus-visible {
    color: var(--terminal-fg-hover);
    background: color-mix(in srgb, var(--terminal-bg) 76%, transparent);
    border-color: var(--terminal-separator);
  }

  &.muted {
    color: color-mix(in srgb, var(--terminal-fg) 40%, transparent);
  }

  &.today {
    border-color: color-mix(in srgb, var(--terminal-fg-hover) 65%, transparent);
  }

  &.selected {
    color: var(--terminal-bg);
    background: var(--terminal-fg-hover);
    border-color: var(--terminal-fg-hover);
    box-shadow: 0 0 18px color-mix(in srgb, var(--terminal-fg-hover) 32%, transparent);
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
