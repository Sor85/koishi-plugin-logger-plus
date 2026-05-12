import { Context, Dict, Logger, remove, Schema, Time } from 'koishi'
import { DataService } from '@koishijs/plugin-console'
import { resolve } from 'path'
import { mkdir, readdir, readFile, rm } from 'fs/promises'
import { FileWriter } from './file'
import zhCN from './locales/zh-CN'

const LOG_PAGE_SIZE = 200

interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
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
    'logger-plus/load-before'(cursor?: string): Promise<LogPage>
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
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.path({
    filters: ['directory'],
    allowCreate: true,
  }).default('data/logs'),
  maxAge: Schema.natural().default(30),
  maxSize: Schema.natural().default(1024 * 100),
  showRecentLogsOnStartup: Schema.boolean().default(false),
}).i18n({
  'zh-CN': zhCN,
})

export async function apply(ctx: Context, config: Config) {
  const root = resolve(ctx.baseDir, config.root)
  await mkdir(root, { recursive: true })

  const files: Dict<number[]> = {}
  for (const filename of await readdir(root)) {
    const capture = /^(\d{4}-\d{2}-\d{2})-(\d+)\.log$/.exec(filename)
    if (!capture) continue
    files[capture[1]] ??= []
    files[capture[1]].push(+capture[2])
  }

  let writer: FileWriter
  async function createFile(date: string, index: number) {
    writer = new FileWriter(date, `${root}/${date}-${index}.log`)

    const { maxAge } = config
    if (!maxAge) return

    const now = Date.now()
    for (const date of Object.keys(files)) {
      if (now - +new Date(date) < maxAge * Time.day) continue
      for (const index of files[date]) {
        await rm(`${root}/${date}-${index}.log`).catch((error) => {
          ctx.logger('logger-plus').warn(error)
        })
      }
      delete files[date]
    }
  }

  async function readSavedLogs() {
    await writer?.task
    const records: Logger.Record[] = []
    for (const [date, indexes] of Object.entries(files)) {
      for (const index of indexes) {
        const text = await readFile(`${root}/${date}-${index}.log`, 'utf8').catch((error) => {
          ctx.logger('logger-plus').warn(error)
          return ''
        })
        records.push(...parseRecords(text))
      }
    }
    return sortLogs(records)
  }

  async function loadLogPage(cursor?: string) {
    if (!config.showRecentLogsOnStartup) return { logs: [], hasMore: false }
    return createLogPage(await readSavedLogs(), cursor)
  }

  async function getLogs() {
    if (config.showRecentLogsOnStartup) return (await loadLogPage()).logs
    return writer ? writer.read() : []
  }

  const date = new Date().toISOString().slice(0, 10)
  const index = Math.max(...files[date] ?? [0]) + 1
  files[date] ??= []
  files[date].push(index)
  createFile(date, index)

  let buffer: Logger.Record[] = []
  const update = ctx.throttle(() => {
    // Be very careful about accessing service in this callback,
    // because undeclared service access may cause infinite loop.
    ctx.get('console')?.patch('logs', buffer)
    buffer = []
  }, 100)

  const loader = ctx.get('loader')
  const target: Logger.Target = {
    colors: 3,
    record: (record: Logger.Record) => {
      record.meta ||= {}
      const scope = record.meta[Context.current]?.scope
      if (loader && scope) {
        record.meta['paths'] = loader.paths(scope)
      }
      const date = new Date(record.timestamp).toISOString().slice(0, 10)
      if (writer.date !== date) {
        writer.close()
        const nextIndex = Math.max(...files[date] ?? [0]) + 1
        files[date] ??= []
        files[date].push(nextIndex)
        createFile(date, nextIndex)
      }
      writer.write(record)
      buffer.push(record)
      update()
      if (writer.size >= config.maxSize) {
        writer.close()
        const nextIndex = Math.max(...files[date] ?? [0]) + 1
        files[date] ??= []
        files[date].push(nextIndex)
        createFile(date, nextIndex)
      }
    },
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
