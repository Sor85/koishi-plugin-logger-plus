/**
 * 日志归档。
 *
 * 「给定查询，从已落盘日志读取一页」的全部规则收在这一个 module：查询规范化、游标判定、
 * 筛选编译、分页早停、排序、下一游标，以及读取前的写入同步与读取容错。此前这些逻辑是插件启动
 * 函数里的一组闭包，验证读取一页就必须先起整个插件、造假 console/context/logger/throttle，
 * 再从注册的监听器里取出闭包间接调用；测试面因此被抬到了整个插件启动环境。
 *
 * 核心不认识 Koishi console 运行时类型：它组合既有的文件清单（`LogFileIndex`）、倒序读取
 * （`readRecordsBackward`）与筛选编译（`compileLogFilter`）三个已验证的下层 module，构造时接收
 * 依赖——日志目录、共享的文件清单、读取前的同步动作、以及非忽略错误的上报回调，因此测试可以
 * 用真实临时目录直接驱动它，断言分页、游标、筛选、排序、早停与文件竞态容错。
 *
 * 两条封在 module 内、调用方无法漏掉的时序与容错规则：
 *
 * 1. 读取前先把尚未落盘的最新日志刷入（`sync`）。这一步封在读取入口内，装配层只提供同步的
 *    具体实现，任何读取路径都不可能跳过它。
 * 2. 缺失文件（`ENOENT`）的静默判定属于本 module：清理刚好删掉某个文件、或它压根不是文件时
 *    单独跳过，不让整页失败；只有非忽略错误才经注入的上报回调交给装配层记录。往日志里写这一条
 *    就会触发写入—滚动—清理—再报错的放大循环（见 `isMissingFileError`）。
 */

import { Logger } from 'koishi'
import { isMissingFileError, LogFileIndex } from './log-file-index'
import { compileLogFilter, hasLogFilter, isLogType, LogFilter } from './log-filter'
import { readRecordsBackward } from './log-reader'

const LOG_PAGE_SIZE = 200

/** 一页历史日志的返回契约，与 `logger-plus/load-before` 对齐 */
export interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
}

/** 一次历史日志读取的查询：筛选条件加游标与日期 */
export interface LogQuery extends LogFilter {
  cursor?: string
  date?: string
}

export interface LogArchiveOptions {
  /** 日志目录；文件读取直接作用于其中的真实文件 */
  root: string
  /**
   * 写入与读取共享的同一份文件清单。写入路径分配序号、跨日清理会修改它，读取路径只读取其倒序
   * 清单；双方必须看到同一份最新状态，读取看到的文件才与磁盘实际一致。
   */
  fileIndex: LogFileIndex
  /** 读取前的写入同步动作，由装配层提供具体实现（生产环境是刷入当前写入缓冲） */
  sync(): Promise<void> | void
  /** 非忽略错误的上报回调；ENOENT 由本 module 静默，其余错误交给装配层决定如何记录 */
  reportError(error: unknown): void
}

function compareRecords(left: Logger.Record, right: Logger.Record) {
  return left.timestamp - right.timestamp || left.id - right.id
}

function createLogCursor(record: Logger.Record) {
  return `${record.timestamp}:${record.id}`
}

function isBeforeCursor(record: Logger.Record, cursor?: string) {
  if (!cursor) return true
  const [timestamp, id] = cursor.split(':').map(Number)
  return record.timestamp < timestamp || record.timestamp === timestamp && record.id < id
}

function normalizeLogQuery(query?: string | LogQuery): LogQuery {
  if (typeof query === 'string') return { cursor: query }
  return query ?? {}
}

function isValidDate(date?: string) {
  return !date || /^\d{4}-\d{2}-\d{2}$/.test(date)
}

function normalizeLogFilter(query: LogQuery): LogFilter {
  return {
    path: query.path || undefined,
    // 等级只接受已知取值，避免前端传来的任意字符串把历史日志全部过滤成空
    type: isLogType(query.type) ? query.type : undefined,
    search: query.search?.trim() || undefined,
    searchPaths: normalizeSearchPaths(query.searchPaths),
  }
}

// 关键词命中的插件路径由前端解析后下发，跨过 JSON 边界后可能是任意结构，只取非空字符串
function normalizeSearchPaths(paths?: readonly string[]) {
  if (!Array.isArray(paths)) return undefined
  const normalized = paths.filter(path => typeof path === 'string' && path)
  return normalized.length ? normalized : undefined
}

function sortLogs(records: Logger.Record[]) {
  return records.sort(compareRecords)
}

/**
 * 已落盘历史日志的分页读取。
 *
 * 对外只暴露 `readPage` 一个入口；倒序流式读取生成器 `readSavedRecords` 是内部 seam，只服务自身
 * 实现与测试推进，不进对外 interface。
 */
export class LogArchive {
  private readonly root: string
  private readonly fileIndex: LogFileIndex
  private readonly sync: () => Promise<void> | void
  private readonly reportError: (error: unknown) => void

  constructor(options: LogArchiveOptions) {
    this.root = options.root
    this.fileIndex = options.fileIndex
    this.sync = options.sync
    this.reportError = options.reportError
  }

  /**
   * 逐条交出已经落盘的日志，顺序从新到旧。
   *
   * 不把文件读成数组再拼起来：单个文件的记录数会随 `maxSize` 上到十万级，一次查询又会跨上百个
   * 文件，整份读进内存既有 `push(...records)` 撞实参上限的 `RangeError`，也让内存占用跟历史总量
   * 成正比。改成生成器之后，调用方凑够一页就能停下，更早的文件根本不会被打开。
   *
   * 读取前先 `sync`：把尚未落盘的最新日志刷入，刚产生的日志也能被读到。这条时序封在这里，
   * 调用方无法漏掉。
   */
  private async *readSavedRecords(date?: string) {
    await this.sync()
    for (const group of this.fileIndex.reverseEntries(date)) {
      for (const index of group.indexes) {
        try {
          yield* readRecordsBackward(`${this.root}/${group.date}-${index}.log`)
        } catch (error) {
          // 单个文件读不了不该让整页日志失败：清理刚好删掉它，或者它压根不是文件。
          // ENOENT 静默留在本 module，其余错误才交给装配层上报。
          if (isMissingFileError(error)) continue
          this.reportError(error)
        }
      }
    }
  }

  /** 读取一页历史日志：按筛选与游标返回记录、下一游标与是否还有更早记录。 */
  async readPage(query?: string | LogQuery): Promise<LogPage> {
    const normalized = normalizeLogQuery(query)
    const { cursor, date } = normalized
    const filter = normalizeLogFilter(normalized)
    // 无游标、无日期、无筛选时不读盘：实时浏览不该触发无谓的历史扫描
    if (!cursor && !date && !hasLogFilter(filter)) return { logs: [], hasMore: false }
    // 非法日期返回空结果而非报错，异常输入不影响浏览
    if (!isValidDate(date)) return { logs: [], hasMore: false }
    const collected: Logger.Record[] = []
    // 关键词和路径清单只需准备一次；放进循环会按记录数重复上万次
    const matches = compileLogFilter(filter)
    let hasMore = false
    for await (const record of this.readSavedRecords(date)) {
      if (!isBeforeCursor(record, cursor)) continue
      if (!matches(record)) continue
      if (collected.length >= LOG_PAGE_SIZE) {
        // 只需要知道「还有更早的」，多读到一条就够，剩下的文件不必再打开
        hasMore = true
        break
      }
      collected.push(record)
    }
    // 收集顺序是从新到旧，先翻回落盘顺序，再按时间排一遍：进程重启会让 id 从头计数，只靠 id
    // 排不出跨重启的先后
    const logs = sortLogs(collected.reverse())
    return { logs, cursor: logs[0] ? createLogCursor(logs[0]) : cursor, hasMore }
  }
}
