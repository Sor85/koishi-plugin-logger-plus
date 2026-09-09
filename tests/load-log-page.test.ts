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
  /** 记下插件报的告警，用来断言某个日志文件到底有没有被打开。 */
  public warnings: unknown[] = []
  private disposeCallbacks: (() => void)[] = []

  constructor(baseDir: string, console: FakeConsole) {
    this.baseDir = baseDir
    this.console = console
  }

  get(name: string) {
    if (name === 'console') return this.console
  }

  logger() {
    return {
      warn: (error: unknown) => {
        this.warnings.push(error)
      },
    }
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

async function writeLogFile(root: string, date: string, index: number, records: Logger.Record[]) {
  await writeFile(join(root, `${date}-${index}.log`), records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
}

function createConsole(): FakeConsole {
  return {
    addListener(event, callback) {
      if (event === 'logger-plus/load-before') this.listener = callback
    },
    patch() {},
  }
}

const baseConfig = {
  root: 'logs',
  maxAge: 0,
  maxSize: 1024 * 100,
  autoUnloadHistoryLogs: true,
  preservePausedPositionOnReturn: false,
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
    await writeLogFile(root, date, 1, records)
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
    await writeLogFile(root, date, 1, records)
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

test('一页日志跨多个文件时按时间顺序拼接', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'logger-plus-'))
  const root = join(baseDir, 'logs')
  const date = '2026-05-25'
  const start = Date.parse(`${date}T00:00:00.000Z`)
  const createRange = (from: number, to: number) => Array.from(
    { length: to - from + 1 },
    (_, offset) => createRecord(from + offset, start + from + offset, 'plugin.alpha'),
  )
  const console = createConsole()
  const ctx = new FakeContext(baseDir, console)

  try {
    await mkdir(root)
    await writeLogFile(root, date, 1, createRange(1, 150))
    await writeLogFile(root, date, 2, createRange(151, 300))
    await apply(ctx as any, baseConfig)

    assert.ok(console.listener)
    const page = await console.listener({ path: 'plugin.alpha' }) as {
      logs: Logger.Record[]
      cursor?: string
      hasMore: boolean
    }

    // 一页 200 条，需要读完新文件的 150 条再往前接上旧文件的 50 条
    assert.deepEqual(page.logs.map(record => record.id), createRange(101, 300).map(record => record.id))
    assert.equal(page.hasMore, true)
    assert.equal(page.cursor, `${start + 101}:101`)

    const olderPage = await console.listener({ path: 'plugin.alpha', cursor: page.cursor }) as {
      logs: Logger.Record[]
      hasMore: boolean
    }

    assert.deepEqual(olderPage.logs.map(record => record.id), createRange(1, 100).map(record => record.id))
    assert.equal(olderPage.hasMore, false)
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})

test('凑够一页就停下，不再打开更早的日志文件', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'logger-plus-'))
  const root = join(baseDir, 'logs')
  const date = '2026-05-25'
  const start = Date.parse(`${date}T00:00:00.000Z`)
  const console = createConsole()
  const ctx = new FakeContext(baseDir, console)

  try {
    await mkdir(root)
    // 1 号「文件」故意做成目录：一旦被打开读取就会报 EISDIR，从而在告警里留下痕迹。
    // 这是断言早停的手段——真实故障是把上百个文件全读进内存，而内存占用本身不好直接断言。
    await mkdir(join(root, `${date}-1.log`))
    await writeFile(join(root, `${date}-1.log`, 'filler'), 'x', 'utf8')
    await writeLogFile(root, date, 2, Array.from(
      { length: 250 },
      (_, offset) => createRecord(offset + 1, start + offset + 1, 'plugin.alpha'),
    ))
    await apply(ctx as any, baseConfig)

    assert.ok(console.listener)
    const page = await console.listener({ path: 'plugin.alpha' }) as {
      logs: Logger.Record[]
      hasMore: boolean
    }

    assert.equal(page.logs.length, 200)
    assert.equal(page.logs[0].id, 51)
    assert.equal(page.hasMore, true)
    assert.deepEqual(ctx.warnings, [])

    // 反向对照：关键词一条都不匹配时必须扫到 1 号，证明上面的空告警确实来自早停而不是目录能读
    const emptyPage = await console.listener({ search: '不存在的关键词' }) as { logs: Logger.Record[] }

    assert.deepEqual(emptyPage.logs, [])
    assert.equal(ctx.warnings.length, 1)
    assert.equal((ctx.warnings[0] as NodeJS.ErrnoException).code, 'EISDIR')
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})
