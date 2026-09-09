<template>
  <div class="logger-page">
    <div
      ref="filterElement"
      :class="['logger-filter', { collapsed: isFilterCollapsed }]"
      @click="expandFilter"
    >
      <span class="logger-filter-dot"></span>
      <label class="logger-filter-summary" for="logger-filter-path">过滤</label>
      <OptionSelect
        id="logger-filter-path"
        v-model="selectedPath"
        :open="openPicker === 'plugin'"
        :options="pluginOptions"
        empty-label="全部插件"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @update:open="setPickerOpen('plugin', $event)"
      />
      <label for="logger-filter-level">等级</label>
      <OptionSelect
        id="logger-filter-level"
        v-model="selectedType"
        :open="openPicker === 'level'"
        :options="levelOptions"
        empty-label="全部等级"
        min-width="5.5rem"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @update:open="setPickerOpen('level', $event)"
      />
      <label for="logger-filter-date">日期</label>
      <DatePicker
        id="logger-filter-date"
        v-model="selectedDate"
        :open="openPicker === 'date'"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @update:open="setPickerOpen('date', $event)"
      />
      <label for="logger-filter-search">搜索</label>
      <input
        id="logger-filter-search"
        v-model="searchInput"
        class="logger-filter-search"
        type="text"
        placeholder="关键词"
        autocomplete="off"
        spellcheck="false"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @keydown.enter.prevent="applySearchKeyword"
      >
      <button
        v-if="hasActiveFilter"
        class="logger-filter-clear"
        type="button"
        title="清除全部筛选条件"
        :tabindex="isFilterCollapsed ? -1 : undefined"
        @click="clearFilters"
      >清除</button>
    </div>
    <logs
      :key="`${selectedPath}:${selectedType}:${searchKeyword}:${selectedDate}:${historyResetKey}`"
      :logs="filteredLogs"
      show-link
      reset-follow-on-enter
      load-before
      :load-date="selectedDate"
      :load-path="selectedPath"
      :load-type="selectedType"
      :load-search="searchKeyword"
      :load-search-paths="searchPaths"
      :load-cursor="selectedDate ? dateCursor : undefined"
      :preserve-paused-position-on-return="preservePausedPositionOnReturn"
      @prepend-logs="prependLoadedLogs"
      @view-logs="resetHistoryUnloadTimer"
      @filter-path="selectedPath = $event"
    ></logs>
  </div>
</template>

<script lang="ts" setup>

import { send, store } from '@koishijs/client'
import Logger from 'reggol'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import DatePicker from './date-picker.vue'
import Logs from './logs.vue'
import { mergeLogRecords } from './log-record'
import OptionSelect from './option-select.vue'
import type { LogFilter } from '../src/log-filter'
import { compileLogFilter, getRecordPaths, hasLogFilter, logTypes } from '../src/log-filter'

interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
}

interface PluginEntry {
  path: string
  name: string
  label?: string
}

type PickerName = 'plugin' | 'level' | 'date'

// 等级直接用日志记录里的英文标识，和日志行的 [E]/[W] 标记以及服务端筛选口径保持一致
const levelOptions = logTypes.map(type => ({ value: type, label: type }))

const selectedPath = ref('')
const selectedType = ref('')
const selectedDate = ref('')
const searchInput = ref('')
const searchKeyword = ref('')
const historyLogs = ref<Logger.Record[]>([])
const historyResetKey = ref(0)
const dateLogs = ref<Logger.Record[]>([])
const dateCursor = ref<string | undefined>()
const openPicker = ref<PickerName | ''>('')
const filterElement = ref<HTMLElement | null>(null)
const isFilterExpanded = ref(false)
const historyUnloadDelay = 30 * 60 * 1000
const searchDebounceDelay = 320
let dateRequestId = 0
let historyUnloadTimer: ReturnType<typeof setTimeout> | undefined
let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined

function getPluginLabel(path: string) {
  return pluginLabels.value.get(path) || path
}

/**
 * 收集控制台配置里的全部插件条目。
 *
 * 配置项的键形如 `插件名:路径`，路径才是日志记录里 `meta.paths` 的取值，插件名和自定义标签
 * 只存在于配置中。按路径逐个递归查找会让「解析每条日志的插件名」变成对配置树的重复遍历，
 * 因此一次性摊平成清单，再派生出路径到显示名的映射。
 */
function collectPluginEntries(plugins: Record<string, any>, entries: PluginEntry[] = []) {
  if (!plugins || typeof plugins !== 'object') return entries
  for (let key in plugins) {
    if (key.startsWith('$')) continue
    const config = plugins[key]
    if (key.startsWith('~')) key = key.slice(1)
    const name = key.split(':', 1)[0]
    const path = key.includes(':') ? key.slice(name.length + 1) : undefined
    if (path) entries.push({ path, name, label: config?.$label })
    if (key.startsWith('group:')) collectPluginEntries(config, entries)
  }
  return entries
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

const pluginEntries = computed(() => collectPluginEntries(store.config?.plugins))

const pluginLabels = computed(() => {
  const labels = new Map<string, string>()
  for (const entry of pluginEntries.value) {
    labels.set(entry.path, entry.label || entry.name)
  }
  return labels
})

const pluginOptions = computed(() => {
  const paths = new Set<string>()
  for (const record of [...historyLogs.value, ...(store.logs ?? []), ...dateLogs.value]) {
    for (const path of getRecordPaths(record)) {
      paths.add(path)
    }
  }
  return [...paths]
    .map(path => ({ value: path, label: getPluginLabel(path) }))
    .sort((left, right) => left.label.localeCompare(right.label))
})

/**
 * 关键词命中的插件路径。
 *
 * 搜索要同时覆盖插件名与日志正文，而日志记录里只有插件路径；插件名先在配置里比一遍，
 * 命中的路径随查询一起下发，服务端读历史日志时按同一份清单判断。
 * 清单只跟关键词和配置有关，与日志条数无关，因此不会随日志量增长而变慢。
 */
const searchPaths = computed(() => {
  const keyword = searchKeyword.value.toLowerCase()
  if (!keyword) return [] as string[]
  return pluginEntries.value
    .filter(entry => entry.name.toLowerCase().includes(keyword) || entry.label?.toLowerCase().includes(keyword))
    .map(entry => entry.path)
})

const recordFilter = computed<LogFilter>(() => ({
  path: selectedPath.value || undefined,
  type: selectedType.value || undefined,
  search: searchKeyword.value || undefined,
  searchPaths: searchPaths.value,
}))

const liveLogs = computed(() => {
  const logs = historyLogs.value.length
    ? mergeLogRecords(historyLogs.value, store.logs ?? [])
    : store.logs ?? []
  if (!hasLogFilter(recordFilter.value)) return logs
  // 实时日志每 100ms 推送一次就要把整份已加载日志重过一遍，判定函数必须在循环外编译好
  const matches = compileLogFilter(recordFilter.value)
  return logs.filter(record => matches(record))
})

const filteredLogs = computed(() => selectedDate.value ? dateLogs.value : liveLogs.value)

const hasActiveFilter = computed(() => !!selectedPath.value || !!selectedType.value || !!selectedDate.value || !!searchInput.value)

const isFilterCollapsed = computed(() => !isFilterExpanded.value && !hasActiveFilter.value && !openPicker.value)

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

function applySearchKeyword() {
  clearTimeout(searchDebounceTimer)
  searchDebounceTimer = undefined
  searchKeyword.value = searchInput.value.trim()
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
  openPicker.value = ''
  if (!hasActiveFilter.value) {
    isFilterExpanded.value = false
    if (fromWidth !== undefined) void animateFilterWidth(fromWidth)
  }
}

function setPickerOpen(name: PickerName, open: boolean) {
  if (open) {
    openPicker.value = name
  } else if (openPicker.value === name) {
    openPicker.value = ''
  }
}

function clearFilters() {
  selectedPath.value = ''
  selectedType.value = ''
  selectedDate.value = ''
  searchInput.value = ''
  applySearchKeyword()
  openPicker.value = ''
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

// 关键词会触发服务端读取已保存日志，逐字输入必须先合并成一次请求
watch(searchInput, () => {
  clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(applySearchKeyword, searchDebounceDelay)
})

// 插件名命中的路径清单随配置变化，取拼接结果当侦听源：配置每次推送都会重算出新数组，
// 只按引用比较会让同一份清单反复触发历史日志查询
watch([selectedDate, selectedPath, selectedType, searchKeyword, () => searchPaths.value.join('\n')], async ([date, path, type, search]) => {
  if (date || path || type || search) isFilterExpanded.value = true
  const requestId = ++dateRequestId
  dateLogs.value = []
  dateCursor.value = undefined
  clearHistoryUnloadTimer()
  if (!date && !path && !type && !search) {
    resetHistoryUnloadTimer()
    return
  }
  const page = await send('logger-plus/load-before', {
    date: date || undefined,
    path: path || undefined,
    type: type || undefined,
    search: search || undefined,
    searchPaths: searchPaths.value,
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
  clearTimeout(searchDebounceTimer)
})

</script>

<style scoped lang="scss">

// 不使用 k-layout：顶栏由它生成，去掉即可。底部状态栏是控制台的全局固定元素（z-index 50），
// 不在本页 DOM 里，因此这里铺到 bottom: 0 并抬高层级把它盖住。
// 左边界仍需避让固定活动栏，不能从视口 left: 0 开始。
.logger-page {
  position: fixed;
  z-index: 100;
  top: 0;
  right: 0;
  bottom: 0;
  left: var(--activity-width, 4rem);
  box-sizing: border-box;
  overflow: hidden;
  background-color: var(--terminal-bg);
  font-size: var(--logger-font-size);
  line-height: var(--logger-line-height);
}

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
  max-width: 48rem;
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
    max-width: 48rem;
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
    font-size: var(--logger-label-font-size);
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

.logger-filter-search {
  box-sizing: border-box;
  flex: 0 1 auto;
  width: 8rem;
  min-width: 5rem;
  height: 1.65rem;
  color: inherit;
  background: color-mix(in srgb, var(--terminal-bg) 70%, transparent);
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0 0.6rem;
  font: inherit;

  &::placeholder {
    color: color-mix(in srgb, var(--terminal-fg) 45%, transparent);
  }

  &:hover,
  &:focus-visible {
    color: var(--terminal-fg-hover);
    background: color-mix(in srgb, var(--terminal-bg-hover) 72%, var(--terminal-bg));
    border-color: var(--terminal-separator);
    outline: none;
  }
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
