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

test('日志行把稳定标识接到渲染 key', async () => {
  const source = await readSource('../client/logs.vue')

  // 渲染 key 的模板接线仍在此断言；标识如何编码由 log-identity.test.ts 的行为测试锁定
  assert.match(source, /:key="item\.key"/)
  assert.match(source, /:data-log-key="item\.key"/)
  assert.match(source, /v-memo="\[item\.key, item\.index, item\.start\]"/)
  assert.match(source, /key: getLogKey\(record\)/)
})

test('日志列表只渲染窗口内的日志行', async () => {
  const logsSource = await readSource('../client/logs.vue')

  assert.match(logsSource, /v-for="item in visibleLogs"/)
  assert.match(logsSource, /class="log-viewport"/)
  assert.match(logsSource, /paddingTop: `\$\{logWindow\.paddingTop\}px`/)
  assert.match(logsSource, /paddingBottom: `\$\{logWindow\.paddingBottom\}px`/)
  // 占位必须走内边距：transform 不进 offsetTop，锚点换算会整段偏掉
  assert.doesNotMatch(logsSource, /translateY\(\$\{/)
  // 滚动容器要自己充当 offsetParent，日志行的 offsetTop 才等于它在滚动坐标里的位置
  assert.match(logsSource, /\.log-list\s*\{[\s\S]*position:\s*relative;/)
  // 浏览器原生锚定不能成为第二个位置写者，Firefox 的宽度重排验收覆盖实际行为。
  assert.match(logsSource, /\.log-list\s*\{[^}]*overflow-anchor:\s*none;/)
})

test('分隔行的留白用内边距，计入行高', async () => {
  const source = await readSource('../client/logs.vue')

  // 外边距既不进 offsetHeight 也不进 getBoundingClientRect，占位会比真实内容矮一截
  assert.match(source, /\.line\.start\s*\{\s*padding-top:\s*1rem;/)
  assert.doesNotMatch(source, /\.line\.start\s*\{\s*margin-top:/)
  // 窗口里的第一行不是列表的第一行，位置选择器一律不能用
  assert.doesNotMatch(source, /\.line:first-child/)
})

test('视口协调核心与框架无关', async () => {
  const coreSource = await readSource('../client/log-viewport.ts')

  // 这条边界由 import 关系直接可验证，不靠纪律维持
  assert.doesNotMatch(coreSource, /from 'vue'/)
  assert.match(coreSource, /import type \{ ViewportHost \} from '\.\/viewport-host'/)
})

test('无历史缓存时不重复合并实时日志', async () => {
  // 合并去重与「无缓存直接返回实时流」已迁入日志会话核心，由 log-session.test.ts 的行为测试覆盖
  const source = await readSource('../client/log-session.ts')

  assert.match(source, /sharedCache\.length\s*\?\s*mergeLogRecords\(sharedCache, live\)\s*:\s*live/)
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

test('筛选胶囊和回到底部按钮使用毛玻璃背景', async () => {
  const indexSource = await readSource('../client/index.vue')
  const logsSource = await readSource('../client/logs.vue')

  assert.match(indexSource, /\.logger-filter\s*\{[\s\S]*backdrop-filter:\s*blur\(18px\) saturate\(140%\);/)
  assert.match(logsSource, /\.logger-scroll-bottom\s*\{[\s\S]*backdrop-filter:\s*blur\(18px\) saturate\(140%\);/)
})

test('日志页不再显示追踪状态胶囊', async () => {
  const source = await readSource('../client/logs.vue')

  assert.doesNotMatch(source, /logger-follow/)
  assert.doesNotMatch(source, /已暂停|追踪中/)
})

test('日志行不再渲染行尾图标按钮', async () => {
  const logsSource = await readSource('../client/logs.vue')
  const iconSource = await readSource('../client/icons/index.ts')

  assert.doesNotMatch(logsSource, /log-action/)
  assert.doesNotMatch(logsSource, /k-icon/)
  assert.doesNotMatch(logsSource, /router-link/)
  assert.doesNotMatch(iconSource, /activity:copy/)
})

test('原生滚动条区域用同色遮罩铺平轨道底色', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /class="log-scrollbar-gutter"/)
  assert.match(source, /:style="\{ width: scrollbarGutterWidth \}"/)
  assert.match(source, /const scrollbarGutterWidth = computed\(\(\) => `max\(1rem, \$\{nativeScrollbarWidth\.value\}px\)`\)/)
  assert.match(source, /nativeScrollbarWidth\.value = Math\.max\(0, element\.offsetWidth - element\.clientWidth\)/)
  assert.match(source, /\.log-scrollbar-gutter\s*\{[\s\S]*background-color:\s*var\(--terminal-bg\);/)
  assert.match(source, /\.log-scrollbar-gutter\s*\{[\s\S]*pointer-events:\s*none;/)
  assert.match(source, /window\.addEventListener\('resize', updateNativeScrollbarWidth\)/)
  assert.match(source, /window\.removeEventListener\('resize', updateNativeScrollbarWidth\)/)
})

test('报错日志整行标红并给等级标记着色', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /:class="\['line', `level-\$\{item\.record\.type\}`, \{ start: item\.start \}\]"/)
  assert.match(source, /\.line\.level-error\s*\{[\s\S]*background-color:\s*color-mix\(in srgb, #f85149 16%, transparent\);/)
  assert.match(source, /\.line\.level-error\s*\{[\s\S]*&:hover\s*\{[\s\S]*background-color:\s*color-mix\(in srgb, #f85149 26%, transparent\);/)
  assert.match(source, /const levelColors: Record<string, number> = \{[\s\S]*error: 9,/)
  assert.match(source, /const level = code === undefined \? marker : renderColor\(code, marker, ';1'\)/)
})

test('离开底部时提供回到底部按钮', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /:class="\['logger-scroll-bottom', \{ visible: !isViewingLatest \}\]"/)
  assert.match(source, /@click="returnToLatest"/)
  assert.match(source, /function returnToLatest\(\) \{\s*markViewingLogs\(\)\s*viewport\.followLatest\(\)\s*\}/)
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
  assert.match(source, /const levelOptions = logTypes\.map\(type => \(\{ value: type, label: type \}\)\)/)
  assert.doesNotMatch(source, /'错误'|'警告'|'信息'|'成功'|'调试'/)
})

test('等级和关键词条件同时作用于实时日志与历史日志分页', async () => {
  const indexSource = await readSource('../client/index.vue')
  const sessionSource = await readSource('../client/log-session.ts')

  // 展示层把等级、关键词与路径清单组装成查询条件交给会话；实时过滤与分页请求由会话统一携带
  assert.match(indexSource, /type: selectedType\.value \|\| undefined,/)
  assert.match(indexSource, /search: searchKeyword\.value \|\| undefined,/)
  assert.match(indexSource, /searchPaths: searchPaths\.value,/)
  // 会话对实时与缓存合并结果按当前条件编译一次判定函数再过滤
  assert.match(sessionSource, /const matches = compileLogFilter\(filter\)/)
  assert.match(sessionSource, /merged\.filter\(record => matches\(record\)\)/)
  // 分页请求携带同一套筛选条件
  assert.match(sessionSource, /type: query\.type \|\| undefined,\s*search: query\.search \|\| undefined,/)
})

test('关键词同时覆盖插件名与日志正文', async () => {
  const indexSource = await readSource('../client/index.vue')
  const sessionSource = await readSource('../client/log-session.ts')

  // 插件名解析仍属展示层：命中路径随查询条件下发
  assert.match(indexSource, /const searchPaths = computed\(\(\) => \{/)
  assert.match(indexSource, /entry\.name\.toLowerCase\(\)\.includes\(keyword\) \|\| entry\.label\?\.toLowerCase\(\)\.includes\(keyword\)/)
  assert.match(indexSource, /searchPaths: searchPaths\.value,/)
  // 会话把命中路径清单一并带进分页请求
  assert.match(sessionSource, /searchPaths: query\.searchPaths,/)
})

test('下拉菜单铺平原生滚动条底色并完整显示插件名', async () => {
  const source = await readSource('../client/option-select.vue')

  assert.match(source, /import\s+\{\s*vOverlayScrollbar\s+\}\s+from\s+['"]\.\/overlay-scrollbar['"]/)
  assert.match(source, /<div v-if="open" v-overlay-scrollbar class="option-select-content"/)
  assert.match(source, /\.option-select-content\s*\{[\s\S]*width:\s*max-content;\s*min-width:\s*12rem;/)
  assert.doesNotMatch(source, /\.option-select-content\s*\{[\s\S]*text-overflow:\s*ellipsis;/)
  assert.match(source, /span\s*\{\s*white-space:\s*nowrap;\s*\}/)
})

test('警告日志整行标黄', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /\.line\.level-warn\s*\{[\s\S]*background-color:\s*color-mix\(in srgb, #d29922 16%, transparent\);/)
  assert.match(source, /\.line\.level-warn\s*\{[\s\S]*&:hover\s*\{[\s\S]*background-color:\s*color-mix\(in srgb, #d29922 26%, transparent\);/)
})

test('日志页不使用 k-layout，并铺满到状态栏所在位置', async () => {
  const source = await readSource('../client/index.vue')

  assert.doesNotMatch(source, /<\/?k-layout/)
  assert.match(source, /<div class="logger-page">/)
  assert.match(source, /\.logger-page\s*\{[\s\S]*position:\s*fixed;/)
  assert.match(source, /\.logger-page\s*\{[\s\S]*left:\s*var\(--activity-width, 4rem\);/)
  assert.match(source, /\.logger-page\s*\{[\s\S]*bottom:\s*0;/)
  assert.match(source, /\.logger-page\s*\{[\s\S]*z-index:\s*100;/)
})

test('根容器与右键菜单都显式声明排版基准', async () => {
  const indexSource = await readSource('../client/index.vue')
  const logsSource = await readSource('../client/logs.vue')
  const styleSource = await readSource('../client/index.scss')

  assert.match(styleSource, /--logger-font-size:\s*14px;/)
  assert.match(styleSource, /--logger-line-height:\s*20px;/)
  assert.match(styleSource, /--logger-label-font-size:\s*12px;/)
  assert.match(indexSource, /\.logger-page\s*\{[\s\S]*font-size:\s*var\(--logger-font-size\);[\s\S]*line-height:\s*var\(--logger-line-height\);/)
  assert.match(logsSource, /\.logger-menu\s*\{[\s\S]*font-size:\s*var\(--logger-font-size\);[\s\S]*line-height:\s*var\(--logger-line-height\);/)
  assert.doesNotMatch(logsSource, /\.line\s*\{[\s\S]*font-size:\s*14px;/)
})

test('滚到顶部后由按钮触发加载更早日志，不再自动预加载', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /class="log-load-more-button"/)
  assert.match(source, /@click="loadBeforeLogs"/)
  assert.match(source, /\{\{ loadingMore \? '正在加载' : '查看更多消息' \}\}/)
  // 是否还有更早记录由会话裁决，列表组件只读结果
  assert.match(source, /const canLoadMore = computed\(\(\) => Boolean\(props\.canLoadMore\)\)/)
  assert.match(source, /\.log-load-more-button\s*\{[\s\S]*height:\s*var\(--logger-line-height\);\s*margin-top:\s*-1rem;/)
  assert.doesNotMatch(source, /preloadLogThreshold/)
  assert.doesNotMatch(source, /getVisibleStartIndex/)
})

test('右键日志行弹出复制候选菜单', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /@contextmenu\.prevent="openLogMenu\(item\.record, \$event\)"/)
  assert.match(source, /<Teleport to="body">/)
  assert.match(source, /class="logger-menu"/)
  assert.match(source, /label: '复制选中文本'/)
  assert.match(source, /label: '复制整行日志'/)
  assert.match(source, /label: '复制日志正文'/)
  assert.match(source, /label: '复制来源名称'/)
  assert.match(source, /label: '复制时间'/)
  assert.match(source, /label: '前往插件配置'/)
  assert.match(source, /function handleDocumentKeydown\(event: KeyboardEvent\) \{\s*if \(event\.key === 'Escape'\) closeLogMenu\(\)/)
  assert.match(source, /document\.removeEventListener\('pointerdown', handleDocumentPointerDown\)/)
})

test('复制到剪贴板前去掉正文里的 ANSI 转义序列', async () => {
  const source = await readSource('../client/logs.vue')

  assert.match(source, /function stripAnsi\(value: string\) \{\s*return value\.replace\(\/\\u001b\\\[\[0-9;\]\*m\/g, ''\)/)
  assert.match(source, /const content = color \? record\.content : stripAnsi\(record\.content\)/)
})
