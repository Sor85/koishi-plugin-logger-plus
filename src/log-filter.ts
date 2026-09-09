/**
 * 日志筛选条件。
 *
 * 服务端读取历史日志和前端过滤实时日志必须用同一套口径：历史日志按分页从磁盘返回，
 * 实时日志只在浏览器里过滤，两边判断不一致时同一个关键词会出现「翻上去有、追踪时没有」的错位。
 */

const ansiPattern = /\u001b\[[0-9;]*m/g

export const logTypes = ['error', 'warn', 'info', 'success', 'debug'] as const

export type LogType = typeof logTypes[number]

export interface LogFilter {
  path?: string
  type?: string
  search?: string
  /**
   * 关键词命中的插件路径清单。
   *
   * 日志记录里只有插件路径（`meta.paths`，形如 `a1b2c3` 的配置项标识），插件显示名只存在于
   * 控制台配置中。因此关键词先在前端解析成路径清单，再随查询下发，让服务端与实时过滤按同一份
   * 清单判断，不必把控制台配置搬到服务端。
   */
  searchPaths?: readonly string[]
}

export interface LogRecordLike {
  name: string
  type: string
  content: string
  meta?: unknown
}

/** 关键词匹配用的小写正文，按记录缓存，见 `getSearchHaystack` */
const searchHaystacks = new WeakMap<LogRecordLike, string>()

export function stripAnsi(content: string) {
  return content.replace(ansiPattern, '')
}

export function getRecordPaths(record: { meta?: unknown }) {
  return (record.meta as { paths?: string[] } | undefined)?.paths ?? []
}

export function isLogType(type?: string): type is LogType {
  return !!type && (logTypes as readonly string[]).includes(type)
}

export function hasLogFilter(filter: LogFilter) {
  return !!filter.path || !!filter.type || !!filter.search
}

/**
 * 取记录的关键词匹配文本：来源名称加正文，剥掉 ANSI 颜色码后转小写。
 *
 * 每次实时日志推送都会把整份已加载日志重新过一遍，而正文里带 ANSI 颜色码，逐次
 * `stripAnsi` + `toLowerCase` 会在十万级记录上把每次推送变成十万次正则替换与字符串分配。
 * 记录对象本身不会被改写，于是把结果挂在 `WeakMap` 上：只有真正参与过关键词匹配的记录才
 * 占额外内存，卸载过往日志后随记录一起回收。
 *
 * 名称和正文拼成同一段文本用换行分隔。搜索框是单行输入，关键词里不可能带换行，因此不会出现
 * 跨越拼接边界的假命中。
 */
function getSearchHaystack(record: LogRecordLike) {
  const cached = searchHaystacks.get(record)
  if (cached !== undefined) return cached
  const haystack = `${record.name}\n${stripAnsi(record.content)}`.toLowerCase()
  searchHaystacks.set(record, haystack)
  return haystack
}

/**
 * 把筛选条件编译成判定函数。
 *
 * 关键词转小写、插件路径清单转 `Set` 这些准备工作只跟条件有关，跟记录无关；放在循环里做就会
 * 按记录数重复上万次。调用方应当在遍历前编译一次，再对每条记录复用同一个判定函数。
 */
export function compileLogFilter(filter: LogFilter) {
  const path = filter.path || undefined
  const type = filter.type || undefined
  const keyword = filter.search ? filter.search.toLowerCase() : undefined
  const searchPaths = filter.searchPaths?.length ? new Set(filter.searchPaths) : undefined
  return (record: LogRecordLike) => {
    if (path && !getRecordPaths(record).includes(path)) return false
    if (type && record.type !== type) return false
    if (!keyword) return true
    if (searchPaths) {
      for (const recordPath of getRecordPaths(record)) {
        if (searchPaths.has(recordPath)) return true
      }
    }
    return getSearchHaystack(record).includes(keyword)
  }
}

export function matchesLogFilter(record: LogRecordLike, filter: LogFilter) {
  return compileLogFilter(filter)(record)
}
