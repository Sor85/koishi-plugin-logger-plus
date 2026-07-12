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
  const pluginSource = await readSource('../client/plugin-select.vue')
  const dateSource = await readSource('../client/date-picker.vue')

  assert.match(indexSource, /import PluginSelect from ['"]\.\/plugin-select\.vue['"]/)
  assert.match(indexSource, /import DatePicker from ['"]\.\/date-picker\.vue['"]/)
  assert.match(pluginSource, /role="combobox"/)
  assert.match(pluginSource, /role="listbox"/)
  assert.match(pluginSource, /max-height:\s*14rem;/)
  assert.match(pluginSource, /\.plugin-select-trigger\s*\{[\s\S]*border-radius:\s*999px;/)
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
