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
}

export interface LogRecordLike {
  name: string
  type: string
  content: string
  meta?: unknown
}

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

export function matchesLogFilter(record: LogRecordLike, filter: LogFilter) {
  if (filter.path && !getRecordPaths(record).includes(filter.path)) return false
  if (filter.type && record.type !== filter.type) return false
  if (!filter.search) return true
  const keyword = filter.search.toLowerCase()
  // 日志内容带 ANSI 颜色码，先剥掉再匹配，否则关键词会被中间的转义序列切断
  return stripAnsi(record.content).toLowerCase().includes(keyword)
    || record.name.toLowerCase().includes(keyword)
}
