import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from 'koishi'
import { apply } from '../src'

interface FakeConsole {
  listener?: (query?: unknown) => Promise<unknown>
  addListener(event: string, callback: (query?: unknown) => Promise<unknown>): void
  patch(): void
}

class FakeContext {
  public baseDir: string
  public console: FakeConsole
  private disposeCallbacks: (() => void)[] = []

  constructor(baseDir: string, console: FakeConsole) {
    this.baseDir = baseDir
    this.console = console
  }

  get(name: string) {
    if (name === 'console') return this.console
  }

  logger() {
    return { warn() {} }
  }

  throttle(callback: () => void) {
    return callback
  }

  on(event: string, callback: () => void) {
    if (event === 'dispose') this.disposeCallbacks.push(callback)
  }

  plugin() {}

  dispose() {
    for (const callback of this.disposeCallbacks) callback()
  }
}

function createRecord(id: number, timestamp: number, path: string): Logger.Record {
  return {
    id,
    timestamp,
    type: 'info',
    name: path,
    content: `record ${id}`,
    meta: { paths: [path] },
  } as Logger.Record
}

function createTypedRecord(id: number, timestamp: number, type: string, content: string): Logger.Record {
  return {
    id,
    timestamp,
    type,
    name: 'app',
    content,
    meta: { paths: ['plugin.alpha'] },
  } as Logger.Record
}

async function writeLogFile(root: string, date: string, records: Logger.Record[]) {
  await writeFile(join(root, `${date}-1.log`), records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
}

test('按插件筛选时即使未开启启动加载历史日志，也能读取已保存的最新日志', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'logger-plus-'))
  const root = join(baseDir, 'logs')
  const date = '2026-05-25'
  const records = [
    createRecord(1, Date.parse(`${date}T09:00:00.000Z`), 'plugin.alpha'),
    createRecord(2, Date.parse(`${date}T10:00:00.000Z`), 'plugin.beta'),
    createRecord(3, Date.parse(`${date}T11:00:00.000Z`), 'plugin.alpha'),
  ]
  const console: FakeConsole = {
    addListener(event, callback) {
      if (event === 'logger-plus/load-before') this.listener = callback
    },
    patch() {},
  }
  const ctx = new FakeContext(baseDir, console)

  try {
    await mkdir(root)
    await writeLogFile(root, date, records)
    await apply(ctx as any, {
      root: 'logs',
      maxAge: 0,
      maxSize: 1024 * 100,
      showRecentLogsOnStartup: false,
      autoUnloadHistoryLogs: true,
      preservePausedPositionOnReturn: false,
    })

    assert.ok(console.listener)
    const page = await console.listener({ path: 'plugin.alpha' }) as { logs: Logger.Record[] }

    assert.deepEqual(page.logs.map(record => record.id), [1, 3])

    const cursorPage = await console.listener({
      cursor: `${records[2].timestamp}:${records[2].id}`,
    }) as { logs: Logger.Record[] }

    assert.deepEqual(cursorPage.logs.map(record => record.id), [1, 2])
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})

test('单个文件里有十万级记录时仍能读取分页', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'logger-plus-'))
  const root = join(baseDir, 'logs')
  const date = '2026-05-25'
  const start = Date.parse(`${date}T00:00:00.000Z`)
  // 阈值实测在 10 万到 12.5 万实参之间，取 13 万确保覆盖 push(...records) 的崩溃点
  const total = 130000
  const console: FakeConsole = {
    addListener(event, callback) {
      if (event === 'logger-plus/load-before') this.listener = callback
    },
    patch() {},
  }
  const ctx = new FakeContext(baseDir, console)

  try {
    await mkdir(root)
    const lines: string[] = []
    for (let id = 1; id <= total; id++) {
      lines.push(JSON.stringify(createRecord(id, start + id, 'plugin.alpha')))
    }
    await writeFile(join(root, `${date}-1.log`), lines.join('\n') + '\n', 'utf8')
    await apply(ctx as any, {
      root: 'logs',
      maxAge: 0,
      maxSize: 1024 * 1024 * 64,
      showRecentLogsOnStartup: false,
      autoUnloadHistoryLogs: true,
      preservePausedPositionOnReturn: false,
    })

    assert.ok(console.listener)
    const page = await console.listener({ path: 'plugin.alpha' }) as {
      logs: Logger.Record[]
      hasMore: boolean
    }

    assert.equal(page.logs.length, 200)
    assert.equal(page.logs[page.logs.length - 1].id, total)
    assert.equal(page.hasMore, true)
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})

test('按等级和关键词筛选时同样读取已保存的日志', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'logger-plus-'))
  const root = join(baseDir, 'logs')
  const date = '2026-05-25'
  const records = [
    createTypedRecord(1, Date.parse(`${date}T09:00:00.000Z`), 'info', 'platform gemini ready'),
    createTypedRecord(2, Date.parse(`${date}T10:00:00.000Z`), 'error', 'Timeout waiting for platform gemini'),
    createTypedRecord(3, Date.parse(`${date}T11:00:00.000Z`), 'debug', 'gemini heartbeat'),
    createTypedRecord(4, Date.parse(`${date}T12:00:00.000Z`), 'error', 'database connection refused'),
  ]
  const console: FakeConsole = {
    addListener(event, callback) {
      if (event === 'logger-plus/load-before') this.listener = callback
    },
    patch() {},
  }
  const ctx = new FakeContext(baseDir, console)

  try {
    await mkdir(root)
    await writeLogFile(root, date, records)
    await apply(ctx as any, {
      root: 'logs',
      maxAge: 0,
      maxSize: 1024 * 100,
      showRecentLogsOnStartup: false,
      autoUnloadHistoryLogs: true,
      preservePausedPositionOnReturn: false,
    })

    assert.ok(console.listener)

    const levelPage = await console.listener({ type: 'error' }) as { logs: Logger.Record[] }
    assert.deepEqual(levelPage.logs.map(record => record.id), [2, 4])

    const debugPage = await console.listener({ type: 'debug' }) as { logs: Logger.Record[] }
    assert.deepEqual(debugPage.logs.map(record => record.id), [3])

    const searchPage = await console.listener({ search: 'TIMEOUT' }) as { logs: Logger.Record[] }
    assert.deepEqual(searchPage.logs.map(record => record.id), [2])

    const combinedPage = await console.listener({ type: 'error', search: 'gemini' }) as { logs: Logger.Record[] }
    assert.deepEqual(combinedPage.logs.map(record => record.id), [2])

    // 等级取值非法时按未筛选处理，不触发整份历史日志的读取
    const invalidPage = await console.listener({ type: 'trace' }) as { logs: Logger.Record[] }
    assert.deepEqual(invalidPage.logs.map(record => record.id), [])
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})
