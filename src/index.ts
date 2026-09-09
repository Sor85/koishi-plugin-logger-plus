import { Context, Logger, remove, Schema } from 'koishi'
import { DataService } from '@koishijs/plugin-console'
import { resolve } from 'path'
import { mkdir, readdir, rm } from 'fs/promises'
import { FileWriter } from './file'
import { createLogRecordHandler } from './record'
import { RecentLogBuffer } from './recent-log-buffer'
import { isMissingFileError, LogFileIndex } from './log-file-index'
import { compileLogFilter, hasLogFilter, isLogType, LogFilter } from './log-filter'
import { readRecordsBackward } from './log-reader'

const LOG_PAGE_SIZE = 200
const RECENT_LOG_LIMIT = 1000

interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
}

interface LogQuery extends LogFilter {
  cursor?: string
  date?: string
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

declare module '@koishijs/console' {
  interface Events {
    'logger-plus/load-before'(query?: string | LogQuery): Promise<LogPage>
  }

  namespace Console {
    interface Services {
      logs: DataService<Logger.Record[]>
    }
  }
}

export const name = 'logger-plus'

class LogProvider extends DataService<Logger.Record[]> {
  constructor(ctx: Context, private getLogs: () => Promise<Logger.Record[]>) {
    super(ctx, 'logs', { authority: 4 })

    ctx.console.addEntry(process.env.KOISHI_BASE ? [
      process.env.KOISHI_BASE + '/dist/index.js',
      process.env.KOISHI_BASE + '/dist/style.css',
    ] : {
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist'),
    })
  }

  async get() {
    return this.getLogs()
  }
}

export interface Config {
  root?: string
  maxAge?: number
  maxSize?: number
  autoUnloadHistoryLogs?: boolean
  preservePausedPositionOnReturn?: boolean
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.path({
    filters: ['directory'],
    allowCreate: true,
  }).default('data/logs').description('存放输出日志的本地目录'),
  maxAge: Schema.natural().default(30).description('日志文件保存的最大天数'),
  maxSize: Schema.natural().default(1048576).description('单个日志文件的最大大小（字节）。写满即换新文件，值太小会让日志目录里堆出海量小文件'),
  autoUnloadHistoryLogs: Schema.boolean().default(true).description('半小时未查看日志后自动卸载已加载的过往日志'),
  preservePausedPositionOnReturn: Schema.boolean().default(false).description('暂停时离开日志页，返回后保持上次暂停位置'),
})

export async function apply(ctx: Context, config: Config) {
  const root = resolve(ctx.baseDir, config.root)
  await mkdir(root, { recursive: true })

  const fileIndex = new LogFileIndex(await readdir(root))

  let writer: FileWriter
  const recentLogs = new RecentLogBuffer<Logger.Record>(RECENT_LOG_LIMIT)

  /** 文件不在了就别记日志：记一条就写一行，写满就滚动，滚动又清理，清理再报错。 */
  function reportFileError(error: unknown) {
    if (isMissingFileError(error)) return
    ctx.logger('logger-plus').warn(error)
  }

  function openFile(date: string, index: number) {
    writer = new FileWriter(date, `${root}/${date}-${index}.log`)
  }

  function rollFile(date: string) {
    writer.close()
    openFile(date, fileIndex.allocate(date))
  }

  /**
   * 清理过期日志。只在启动与跨日时各跑一次。
   *
   * 挂在按大小滚动那一步是原来的写法，代价是每写满一个文件就把所有旧日期遍历一遍并逐个 `rm`；
   * 而新的日期过期只会随着日子往前走发生，跟文件写满没有关系。清单本身保证同一批文件不会被
   * 清理两遍（见 `takeExpired`）。
   */
  async function pruneExpiredLogs(now: number) {
    for (const { date, indexes } of fileIndex.takeExpired(config.maxAge, now)) {
      for (const index of indexes) {
        await rm(`${root}/${date}-${index}.log`).catch(reportFileError)
      }
    }
  }

  /**
   * 逐条交出已经落盘的日志，顺序从新到旧。
   *
   * 不把文件读成数组再拼起来：单个文件的记录数会随 `maxSize` 上到十万级，一次查询又会跨上百个
   * 文件，整份读进内存既有 `push(...records)` 撞实参上限的 `RangeError`，也让内存占用跟历史总量
   * 成正比。改成生成器之后，调用方凑够一页就能停下，更早的文件根本不会被打开。
   */
  async function* readSavedRecords(date?: string) {
    await writer?.sync()
    for (const group of fileIndex.reverseEntries(date)) {
      for (const index of group.indexes) {
        try {
          yield* readRecordsBackward(`${root}/${group.date}-${index}.log`)
        } catch (error) {
          // 单个文件读不了不该让整页日志失败：清理刚好删掉它，或者它压根不是文件
          reportFileError(error)
        }
      }
    }
  }

  async function loadLogPage(query?: string | LogQuery) {
    const normalized = normalizeLogQuery(query)
    const { cursor, date } = normalized
    const filter = normalizeLogFilter(normalized)
    if (!cursor && !date && !hasLogFilter(filter)) return { logs: [], hasMore: false }
    if (!isValidDate(date)) return { logs: [], hasMore: false }
    const collected: Logger.Record[] = []
    // 关键词和路径清单只需准备一次；放进循环会按记录数重复上万次
    const matches = compileLogFilter(filter)
    let hasMore = false
    for await (const record of readSavedRecords(date)) {
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
    return { logs, cursor: logs[0] ? createLogCursor(logs[0]) : cursor, hasMore } satisfies LogPage
  }

  async function getLogs() {
    return recentLogs.values()
  }

  const today = new Date().toISOString().slice(0, 10)
  openFile(today, fileIndex.allocate(today))
  void pruneExpiredLogs(Date.now())

  let buffer: Logger.Record[] = []
  const update = ctx.throttle(() => {
    // Be very careful about accessing service in this callback,
    // because undeclared service access may cause infinite loop.
    ctx.get('console')?.patch('logs', buffer)
    buffer = []
  }, 100)

  const loader = ctx.get('loader')
  const handleRecord = createLogRecordHandler(loader, (record) => {
    const date = new Date(record.timestamp).toISOString().slice(0, 10)
    if (writer.date !== date) {
      rollFile(date)
      // 跨日是新日期开始过期的唯一时机，因此清理挂在这里，用这条记录的时间当作「现在」。
      void pruneExpiredLogs(record.timestamp)
    }
    writer.write(record)
    recentLogs.push(record)
    buffer.push(record)
    update()
    if (writer.size >= config.maxSize) rollFile(date)
  })
  const target: Logger.Target = {
    colors: 3,
    record: handleRecord,
  }

  Logger.targets.push(target)
  ctx.get('console')?.addListener('logger-plus/load-before', loadLogPage, { authority: 4 })
  ctx.on('dispose', () => {
    writer?.close()
    remove(Logger.targets, target)
    if (loader) {
      loader.prolog = []
    }
  })

  for (const record of loader?.prolog || []) {
    target.record(record)
  }

  ctx.plugin(LogProvider, getLogs)
}
