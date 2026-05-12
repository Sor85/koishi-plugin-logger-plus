<template>
  <k-layout>
    <div class="logger-filter">
      <span class="logger-filter-dot"></span>
      <label for="logger-filter-path">过滤</label>
      <select id="logger-filter-path" v-model="selectedPath">
        <option value="">全部插件</option>
        <option v-for="plugin in plugins" :key="plugin.path" :value="plugin.path">
          {{ plugin.label }}
        </option>
      </select>
      <label for="logger-filter-date">日期</label>
      <button id="logger-filter-date" class="logger-date-trigger" type="button" @click="toggleDatePicker">
        <span>{{ selectedDateLabel }}</span>
        <span class="logger-date-icon"></span>
      </button>
      <button v-if="selectedDate" class="logger-filter-clear" type="button" @click="clearDate">清除</button>
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
      :key="`${selectedPath}:${selectedDate}`"
      class="layout-logger"
      :logs="filteredLogs"
      show-link
      reset-follow-on-enter
      :load-before="!selectedPath || !!selectedDate"
      :load-date="selectedDate"
      :load-path="selectedPath"
      :load-cursor="dateCursor"
      @prepend-logs="prependDateLogs"
    ></logs>
  </k-layout>
</template>

<script lang="ts" setup>

import { send, store } from '@koishijs/client'
import Logger from 'reggol'
import { computed, ref, watch } from 'vue'
import Logs from './logs.vue'

interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
}

const selectedPath = ref('')
const selectedDate = ref('')
const dateLogs = ref<Logger.Record[]>([])
const dateCursor = ref<string | undefined>()
const showDatePicker = ref(false)
const visibleMonth = ref(new Date())
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const todayDate = formatDate(new Date())
let dateRequestId = 0

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

function getRecordPaths(record: Logger.Record) {
  return (record.meta as { paths?: string[] } | undefined)?.paths ?? []
}

const plugins = computed(() => {
  const paths = new Set<string>()
  for (const record of [...store.logs ?? [], ...dateLogs.value]) {
    for (const path of getRecordPaths(record)) {
      paths.add(path)
    }
  }
  return [...paths]
    .map(path => ({ path, label: getPluginLabel(path) }))
    .sort((left, right) => left.label.localeCompare(right.label))
})

const liveLogs = computed(() => {
  if (!selectedPath.value) return store.logs ?? []
  return (store.logs ?? []).filter(record => getRecordPaths(record).includes(selectedPath.value))
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

function prependDateLogs(logs: Logger.Record[]) {
  dateLogs.value = [...logs, ...dateLogs.value]
}

watch([selectedDate, selectedPath], async ([date, path]) => {
  const requestId = ++dateRequestId
  dateLogs.value = []
  dateCursor.value = undefined
  if (!date) return
  const page = await send('logger-plus/load-before', {
    date,
    path: path || undefined,
  }) as LogPage
  if (requestId !== dateRequestId) return
  dateLogs.value = page.logs
  dateCursor.value = page.cursor
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
  padding: 0.35rem 0.45rem 0.35rem 0.65rem;
  line-height: 1.25rem;
  box-shadow: 0 10px 28px rgb(0 0 0 / 18%), inset 0 1px 0 rgb(255 255 255 / 8%);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);

  label {
    color: var(--terminal-fg);
    color: color-mix(in srgb, var(--terminal-fg) 78%, transparent);
    font-size: 12px;
    letter-spacing: 0.04em;
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
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: #22c55e;
  background: color-mix(in srgb, var(--terminal-fg-hover) 75%, #22c55e);
  box-shadow: 0 0 12px #22c55e;
  box-shadow: 0 0 12px color-mix(in srgb, var(--terminal-fg-hover) 55%, #22c55e);
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
