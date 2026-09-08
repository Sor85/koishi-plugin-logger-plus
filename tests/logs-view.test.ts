import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function readSource(path: string) {
  try {
    return await readFile(new URL(path, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

test('日志行使用时间戳和 id 作为稳定渲染 key', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /:key="getLogKey\(record\)"/)
  assert.match(source, /:data-log-key="getLogKey\(record\)"/)
  assert.match(source, /v-memo="\[getLogKey\(record\), index\]"/)
})

test('没有历史日志时不重复合并实时日志', async () => {
  const source = await readSource('../client/index.vue')

  assert.match(source, /historyLogs\.value\.length\s*\?\s*mergeLogRecords\(historyLogs\.value, store\.logs \?\? \[\]\)\s*:\s*store\.logs \?\? \[\]/)
})

test('日志列表使用 overlay 自绘滚动条', async () => {
  const logsSource = await readSource('../client/logs.vue')
  const indexSource = await readSource('../client/index.ts')
  const styleSource = await readSource('../client/overlay-scrollbar.scss')

  assert.match(logsSource, /import\s+\{\s*vOverlayScrollbar\s+\}\s+from\s+['"]\.\/overlay-scrollbar['"]/)
  assert.match(logsSource, /v-overlay-scrollbar/)
  assert.match(indexSource, /import\s+['"]\.\/overlay-scrollbar\.scss['"]/)
  assert.match(styleSource, /\[data-overlay-scrollbar="true"\]\s*\{[\s\S]*scrollbar-width:\s*none;/)
  assert.match(styleSource, /\.overlay-scrollbar__thumb/)
  assert.match(styleSource, /\.overlay-scrollbar__thumb\s*\{[\s\S]*background:\s*#8b8b8b;/)
  assert.doesNotMatch(logsSource, /--overlay-scrollbar-accent/)
})

test('日志列表滚动容器使用 border-box 计算 padding', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /\.log-list\s*\{[\s\S]*box-sizing:\s*border-box;/)
})

test('点击日志名称时复用插件路径筛选', async () => {
  const logsSource = await readSource('../client/logs.vue')
  const indexSource = await readSource('../client/index.vue')

  assert.match(logsSource, /class="log-name"/)
  assert.match(logsSource, /emit\('filter-path', path\)/)
  assert.match(indexSource, /@filter-path="selectedPath = \$event"/)
})

test('筛选控件使用紧凑的 Vue 下拉菜单和日历', async () => {
  const indexSource = await readSource('../client/index.vue')
  const optionSource = await readSource('../client/option-select.vue')
  const dateSource = await readSource('../client/date-picker.vue')

  assert.match(indexSource, /import OptionSelect from ['"]\.\/option-select\.vue['"]/)
  assert.match(indexSource, /import DatePicker from ['"]\.\/date-picker\.vue['"]/)
  assert.match(optionSource, /role="combobox"/)
  assert.match(optionSource, /role="listbox"/)
  assert.match(optionSource, /max-height:\s*14rem;/)
  assert.match(optionSource, /\.option-select-trigger\s*\{[\s\S]*border-radius:\s*999px;/)
  assert.match(dateSource, /class="date-picker-content"/)
  assert.match(dateSource, /grid-template-columns:\s*repeat\(7, 1fr\);/)
  assert.match(dateSource, /\.date-picker-trigger\s*\{[\s\S]*border-radius:\s*999px;/)
  assert.match(indexSource, /\.logger-filter\s*\{[\s\S]*width:\s*fit-content;/)
  assert.doesNotMatch(indexSource, /interpolate-size:/)
  assert.match(indexSource, /element\.animate\(\[\s*\{ width: `\$\{fromWidth\}px` \}/)
})

test('筛选和追踪胶囊使用毛玻璃背景', async () => {
  const indexSource = await readSource('../client/index.vue')
  const logsSource = await readSource('../client/logs.vue')

  assert.match(indexSource, /\.logger-filter\s*\{[\s\S]*backdrop-filter:\s*blur\(18px\) saturate\(140%\);/)
  assert.match(logsSource, /\.logger-follow\s*\{[\s\S]*backdrop-filter:\s*blur\(18px\) saturate\(140%\);/)
})

test('报错日志整行标红并给等级标记着色', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /:class="\['line', `level-\$\{record\.type\}`, \{ start: isStart\(index\) \}\]"/)
  assert.match(source, /\.line\.level-error\s*\{[\s\S]*background-color:\s*color-mix\(in srgb, #f85149 16%, transparent\);/)
  assert.match(source, /\.line\.level-error\s*\{[\s\S]*&:hover\s*\{[\s\S]*background-color:\s*color-mix\(in srgb, #f85149 26%, transparent\);/)
  assert.match(source, /const levelColors: Record<string, number> = \{[\s\S]*error: 9,/)
  assert.match(source, /const level = code === undefined \? marker : renderColor\(code, marker, ';1'\)/)
})

test('离开底部时提供回到底部按钮', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /:class="\['logger-scroll-bottom', \{ visible: !isViewingLatest \}\]"/)
  assert.match(source, /@click="returnToLatest"/)
  assert.match(source, /function returnToLatest\(\) \{\s*markViewingLogs\(\)\s*followLatest\(\)\s*\}/)
  assert.match(source, /\.logger-scroll-bottom\s*\{[\s\S]*pointer-events:\s*none;/)
  assert.match(source, /\.logger-scroll-bottom\s*\{[\s\S]*&\.visible\s*\{[\s\S]*pointer-events:\s*auto;/)
})

test('过滤胶囊提供关键词搜索并合并连续输入', async () => {
  const source = await readSource('../client/index.vue')

  assert.match(source, /class="logger-filter-search"/)
  assert.match(source, /v-model="searchInput"/)
  assert.match(source, /@keydown\.enter\.prevent="applySearchKeyword"/)
  assert.match(source, /searchDebounceTimer = setTimeout\(applySearchKeyword, searchDebounceDelay\)/)
  assert.match(source, /searchKeyword\.value = searchInput\.value\.trim\(\)/)
  assert.match(source, /clearTimeout\(searchDebounceTimer\)/)
})

test('过滤胶囊提供日志等级筛选', async () => {
  const source = await readSource('../client/index.vue')

  assert.match(source, /id="logger-filter-level"/)
  assert.match(source, /v-model="selectedType"/)
  assert.match(source, /empty-label="全部等级"/)
  assert.match(source, /const levelLabels: Record<LogType, string> = \{[\s\S]*debug: '调试',/)
  assert.match(source, /const levelOptions = logTypes\.map\(type => \(\{ value: type, label: levelLabels\[type\] \}\)\)/)
})

test('等级和关键词条件同时作用于实时日志与历史日志分页', async () => {
  const indexSource = await readSource('../client/index.vue')
  const logsSource = await readSource('../client/logs.vue')

  assert.match(indexSource, /matchesLogFilter\(record, recordFilter\.value\)/)
  assert.match(indexSource, /:load-type="selectedType"/)
  assert.match(indexSource, /:load-search="searchKeyword"/)
  assert.match(indexSource, /watch\(\[selectedDate, selectedPath, selectedType, searchKeyword\]/)
  assert.match(logsSource, /type: props\.loadType \|\| undefined,\s*search: props\.loadSearch \|\| undefined,/)
})
