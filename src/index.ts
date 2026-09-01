import { Context, Logger, remove, Schema } from 'koishi'
import { DataService } from '@koishijs/plugin-console'
import { resolve } from 'path'
import { mkdir, readdir, readFile, rm } from 'fs/promises'
import { FileWriter } from './file'
import { createLogRecordHandler } from './record'
import { RecentLogBuffer } from './recent-log-buffer'
import { isMissingFileError, LogFileIndex } from './log-file-index'

const LOG_PAGE_SIZE = 200
const RECENT_LOG_LIMIT = 1000

interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
}

interface LogQuery {
  cursor?: string
  date?: string
  path?: string
}

function parseRecords(text: string): Logger.Record[] {
  return text.split('\n').map((line) => {
    try {
      return JSON.parse(line) as Logger.Record
    } catch {}
  }).filter((record): record is Logger.Record => !!record)
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

function getRecordPaths(record: Logger.Record) {
  return (record.meta as { paths?: string[] } | undefined)?.paths ?? []
}

function sortLogs(records: Logger.Record[]) {
  return records.sort(compareRecords)
}

function createLogPage(records: Logger.Record[], cursor?: string): LogPage {
  const candidates = records.filter(record => isBeforeCursor(record, cursor))
  const logs = candidates.slice(-LOG_PAGE_SIZE)
  return {
    logs,
    cursor: logs[0] ? createLogCursor(logs[0]) : cursor,
    hasMore: candidates.length > logs.length,
  }
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
  showRecentLogsOnStartup?: boolean
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
  showRecentLogsOnStartup: Schema.boolean().default(false).description('是否无限加载过往日志。日志加载过多可能影响性能，重启插件即可恢复'),
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

  async function readSavedLogs(date?: string) {
    await writer?.sync()
    const records: Logger.Record[] = []
    for (const group of fileIndex.entries(date)) {
      for (const index of group.indexes) {
        const text = await readFile(`${root}/${group.date}-${index}.log`, 'utf8').catch((error) => {
          reportFileError(error)
          return ''
        })
        records.push(...parseRecords(text))
      }
    }
    return sortLogs(records)
  }

  async function loadLogPage(query?: string | LogQuery) {
    const { cursor, date, path } = normalizeLogQuery(query)
    if (!cursor && !date && !path && !config.showRecentLogsOnStartup) return { logs: [], hasMore: false }
    if (!isValidDate(date)) return { logs: [], hasMore: false }
    const records = (await readSavedLogs(date)).filter(record => !path || getRecordPaths(record).includes(path))
    return createLogPage(records, cursor)
  }

  async function getLogs() {
    if (config.showRecentLogsOnStartup) return (await loadLogPage()).logs
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
