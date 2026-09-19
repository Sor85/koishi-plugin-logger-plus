import type Logger from 'reggol'
import { compareLogRecords, encodeLogIdentity } from '../src/log-identity'

// 生成可跨重启区分日志的稳定标识；编码收口在共享的日志身份 module，与服务端游标同口径
export function getLogKey(record: Logger.Record) {
  return encodeLogIdentity(record)
}

// 合并日志时按稳定标识去重，并保持时间顺序；先后比较复用共享身份语义
export function mergeLogRecords(records: Logger.Record[], incoming: Logger.Record[]) {
  const entries = new Map<string, Logger.Record>()
  for (const record of [...records, ...incoming]) {
    entries.set(getLogKey(record), record)
  }
  return [...entries.values()].sort(compareLogRecords)
}

export function trimLogRecords(records: Logger.Record[], limit: number) {
  if (records.length > limit) records.splice(0, records.length - limit)
  return records
}
