import type Logger from 'reggol'

// 生成可跨重启区分日志的稳定标识
export function getLogKey(record: Logger.Record) {
  return `${record.timestamp}:${record.id}`
}

// 合并日志时按稳定标识去重，并保持时间顺序
export function mergeLogRecords(records: Logger.Record[], incoming: Logger.Record[]) {
  const entries = new Map<string, Logger.Record>()
  for (const record of [...records, ...incoming]) {
    entries.set(getLogKey(record), record)
  }
  return [...entries.values()].sort((left, right) => left.timestamp - right.timestamp || left.id - right.id)
}

export function trimLogRecords(records: Logger.Record[], limit: number) {
  if (records.length > limit) records.splice(0, records.length - limit)
  return records
}
