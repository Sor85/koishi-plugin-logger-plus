import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from 'koishi'
import { LogArchive, LogPage, LogQuery } from '../src/log-archive'
import { LogFileIndex } from '../src/log-file-index'

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

interface Harness {
  root: string
  cleanup(): Promise<void>
  /** 用当前磁盘上的文件清单构造归档；记录 sync 调用次数与非忽略错误上报 */
  openArchive(): Promise<{
    readPage(query?: string | LogQuery): Promise<LogPage>
    syncCalls: number
    errors: unknown[]
  }>
}

async function createHarness(): Promise<Harness> {
  const baseDir = await mkdtemp(join(tmpdir(), 'logger-plus-'))
  const root = join(baseDir, 'logs')
  await mkdir(root)
  return {
    root,
    async cleanup() {
      await rm(baseDir, { recursive: true, force: true })
    },
    async openArchive() {
      // 读取路径只读取共享文件清单的倒序视图；这里用真实目录列表构造，与生产一致
      const fileIndex = new LogFileIndex(await readdir(root))
      const state = { syncCalls: 0, errors: [] as unknown[] }
      const archive = new LogArchive({
        root,
        fileIndex,
        sync: () => { state.syncCalls++ },
        reportError: (error) => { state.errors.push(error) },
      })
      return {
        readPage: (query) => archive.readPage(query),
        get syncCalls() { return state.syncCalls },
        get errors() { return state.errors },
      }
    },
  }
}

test('按插件与游标分页，返回记录、下一游标与是否还有更早记录', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  const records = [
    createRecord(1, Date.parse(`${date}T09:00:00.000Z`), 'plugin.alpha'),
    createRecord(2, Date.parse(`${date}T10:00:00.000Z`), 'plugin.beta'),
    createRecord(3, Date.parse(`${date}T11:00:00.000Z`), 'plugin.alpha'),
  ]
  try {
    await writeLogFile(harness.root, date, 1, records)
    const archive = await harness.openArchive()

    const page = await archive.readPage({ path: 'plugin.alpha' })
    assert.deepEqual(page.logs.map(record => record.id), [1, 3])

    const cursorPage = await archive.readPage({ cursor: `${records[2].timestamp}:${records[2].id}` })
    assert.deepEqual(cursorPage.logs.map(record => record.id), [1, 2])
  } finally {
    await harness.cleanup()
  }
})

test('单个文件里有十万级记录时仍能读取分页，不展开大数组', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  const start = Date.parse(`${date}T00:00:00.000Z`)
  // 阈值实测在 10 万到 12.5 万实参之间，取 13 万确保覆盖 push(...records) 的崩溃点
  const total = 130000
  try {
    const lines: string[] = []
    for (let id = 1; id <= total; id++) {
      lines.push(JSON.stringify(createRecord(id, start + id, 'plugin.alpha')))
    }
    await writeFile(join(harness.root, `${date}-1.log`), lines.join('\n') + '\n', 'utf8')
    const archive = await harness.openArchive()

    const page = await archive.readPage({ path: 'plugin.alpha' })
    assert.equal(page.logs.length, 200)
    assert.equal(page.logs[page.logs.length - 1].id, total)
    assert.equal(page.hasMore, true)
  } finally {
    await harness.cleanup()
  }
})

test('一页日志跨多个文件时按时间顺序拼接，游标可继续加载更早一页', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  const start = Date.parse(`${date}T00:00:00.000Z`)
  const createRange = (from: number, to: number) => Array.from(
    { length: to - from + 1 },
    (_, offset) => createRecord(from + offset, start + from + offset, 'plugin.alpha'),
  )
  try {
    await writeLogFile(harness.root, date, 1, createRange(1, 150))
    await writeLogFile(harness.root, date, 2, createRange(151, 300))
    const archive = await harness.openArchive()

    // 一页 200 条，需要读完新文件的 150 条再往前接上旧文件的 50 条
    const page = await archive.readPage({ path: 'plugin.alpha' })
    assert.deepEqual(page.logs.map(record => record.id), createRange(101, 300).map(record => record.id))
    assert.equal(page.hasMore, true)
    assert.equal(page.cursor, `${start + 101}:101`)

    const olderPage = await archive.readPage({ path: 'plugin.alpha', cursor: page.cursor })
    assert.deepEqual(olderPage.logs.map(record => record.id), createRange(1, 100).map(record => record.id))
    assert.equal(olderPage.hasMore, false)
  } finally {
    await harness.cleanup()
  }
})

test('凑够一页就停下，不再打开更早的日志文件', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  const start = Date.parse(`${date}T00:00:00.000Z`)
  try {
    // 1 号「文件」故意做成目录：一旦被打开读取就会报 EISDIR，从而在上报里留下痕迹。
    // 这是断言早停的手段——真实故障是把上百个文件全读进内存，而内存占用本身不好直接断言。
    await mkdir(join(harness.root, `${date}-1.log`))
    await writeFile(join(harness.root, `${date}-1.log`, 'filler'), 'x', 'utf8')
    await writeLogFile(harness.root, date, 2, Array.from(
      { length: 250 },
      (_, offset) => createRecord(offset + 1, start + offset + 1, 'plugin.alpha'),
    ))
    const archive = await harness.openArchive()

    const page = await archive.readPage({ path: 'plugin.alpha' })
    assert.equal(page.logs.length, 200)
    assert.equal(page.logs[0].id, 51)
    assert.equal(page.hasMore, true)
    assert.deepEqual(archive.errors, [])

    // 反向对照：关键词一条都不匹配时必须扫到 1 号，证明上面的空上报确实来自早停而不是目录能读
    const emptyPage = await archive.readPage({ search: '不存在的关键词' })
    assert.deepEqual(emptyPage.logs, [])
    assert.equal(archive.errors.length, 1)
    assert.equal((archive.errors[0] as NodeJS.ErrnoException).code, 'EISDIR')
  } finally {
    await harness.cleanup()
  }
})

test('等级与关键词组合筛选，非法等级按未筛选处理', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  const records = [
    createTypedRecord(1, Date.parse(`${date}T09:00:00.000Z`), 'info', 'platform gemini ready'),
    createTypedRecord(2, Date.parse(`${date}T10:00:00.000Z`), 'error', 'Timeout waiting for platform gemini'),
    createTypedRecord(3, Date.parse(`${date}T11:00:00.000Z`), 'debug', 'gemini heartbeat'),
    createTypedRecord(4, Date.parse(`${date}T12:00:00.000Z`), 'error', 'database connection refused'),
  ]
  try {
    await writeLogFile(harness.root, date, 1, records)
    const archive = await harness.openArchive()

    const levelPage = await archive.readPage({ type: 'error' })
    assert.deepEqual(levelPage.logs.map(record => record.id), [2, 4])

    const debugPage = await archive.readPage({ type: 'debug' })
    assert.deepEqual(debugPage.logs.map(record => record.id), [3])

    // 关键词大小写不敏感，同时覆盖正文
    const searchPage = await archive.readPage({ search: 'TIMEOUT' })
    assert.deepEqual(searchPage.logs.map(record => record.id), [2])

    const combinedPage = await archive.readPage({ type: 'error', search: 'gemini' })
    assert.deepEqual(combinedPage.logs.map(record => record.id), [2])

    // 等级取值非法时按未筛选处理，不触发整份历史日志的读取
    const invalidPage = await archive.readPage({ type: 'trace' })
    assert.deepEqual(invalidPage.logs.map(record => record.id), [])
  } finally {
    await harness.cleanup()
  }
})

test('关键词同时覆盖插件名/标签命中的路径', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  const base = Date.parse(`${date}T09:00:00.000Z`)
  // 正文里没有关键词，命中只能来自前端解析后下发的 searchPaths
  const record = { ...createRecord(1, base, 'a1b2c3'), name: 'runtime', content: 'started' } as Logger.Record
  try {
    await writeLogFile(harness.root, date, 1, [record])
    const archive = await harness.openArchive()

    const hit = await archive.readPage({ search: 'gpt', searchPaths: ['a1b2c3'] })
    assert.deepEqual(hit.logs.map(r => r.id), [1])

    const miss = await archive.readPage({ search: 'gpt', searchPaths: ['other'] })
    assert.deepEqual(miss.logs.map(r => r.id), [])
  } finally {
    await harness.cleanup()
  }
})

test('无游标、无日期、无筛选时不读盘也不同步', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  try {
    await writeLogFile(harness.root, date, 1, [createRecord(1, Date.parse(`${date}T09:00:00.000Z`), 'plugin.alpha')])
    const archive = await harness.openArchive()

    const page = await archive.readPage({})
    assert.deepEqual(page.logs, [])
    assert.equal(page.hasMore, false)
    // 早返回发生在打开生成器之前，同步动作根本不会被调用
    assert.equal(archive.syncCalls, 0)
  } finally {
    await harness.cleanup()
  }
})

test('非法日期返回空结果而非报错', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  try {
    await writeLogFile(harness.root, date, 1, [createRecord(1, Date.parse(`${date}T09:00:00.000Z`), 'plugin.alpha')])
    const archive = await harness.openArchive()

    const page = await archive.readPage({ date: '2026/05/25' })
    assert.deepEqual(page.logs, [])
    assert.equal(page.hasMore, false)
    assert.equal(archive.syncCalls, 0)
  } finally {
    await harness.cleanup()
  }
})

test('读取历史前先完成写入同步', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  try {
    await writeLogFile(harness.root, date, 1, [createRecord(1, Date.parse(`${date}T09:00:00.000Z`), 'plugin.alpha')])
    const archive = await harness.openArchive()

    const page = await archive.readPage({ path: 'plugin.alpha' })
    assert.deepEqual(page.logs.map(record => record.id), [1])
    // 触发读盘的查询必须先同步一次，刚产生的日志才能被读到
    assert.equal(archive.syncCalls, 1)
  } finally {
    await harness.cleanup()
  }
})

test('按日期读取只返回该日期的记录', async () => {
  const harness = await createHarness()
  try {
    await writeLogFile(harness.root, '2026-05-24', 1, [createRecord(1, Date.parse('2026-05-24T09:00:00.000Z'), 'plugin.alpha')])
    await writeLogFile(harness.root, '2026-05-25', 1, [createRecord(2, Date.parse('2026-05-25T09:00:00.000Z'), 'plugin.alpha')])
    const archive = await harness.openArchive()

    const page = await archive.readPage({ date: '2026-05-24' })
    assert.deepEqual(page.logs.map(record => record.id), [1])
  } finally {
    await harness.cleanup()
  }
})

test('单个文件读取失败时跳过该文件，其余文件仍组成一页', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  const start = Date.parse(`${date}T00:00:00.000Z`)
  try {
    // 2 号（较新）做成目录使其读取报 EISDIR；1 号是正常文件
    await writeLogFile(harness.root, date, 1, [createRecord(1, start + 1, 'plugin.alpha')])
    await mkdir(join(harness.root, `${date}-2.log`))
    const archive = await harness.openArchive()

    const page = await archive.readPage({ path: 'plugin.alpha' })
    assert.deepEqual(page.logs.map(record => record.id), [1])
    assert.equal(archive.errors.length, 1)
    assert.equal((archive.errors[0] as NodeJS.ErrnoException).code, 'EISDIR')
  } finally {
    await harness.cleanup()
  }
})

test('读取过程中文件恰好被删除时不产生任何上报', async () => {
  const harness = await createHarness()
  const date = '2026-05-25'
  const start = Date.parse(`${date}T00:00:00.000Z`)
  try {
    // 清单里登记了 1、2 两号，但 2 号从未落盘：读取时相当于文件刚被清理删掉
    await writeLogFile(harness.root, date, 1, [createRecord(1, start + 1, 'plugin.alpha')])
    const fileIndex = new LogFileIndex([`${date}-1.log`, `${date}-2.log`])
    const errors: unknown[] = []
    const archive = new LogArchive({
      root: harness.root,
      fileIndex,
      sync: () => {},
      reportError: (error) => { errors.push(error) },
    })

    const page = await archive.readPage({ path: 'plugin.alpha' })
    assert.deepEqual(page.logs.map(record => record.id), [1])
    // ENOENT 静默：缺失文件不上报，避免写入—滚动—清理—再报错的放大循环
    assert.deepEqual(errors, [])
  } finally {
    await harness.cleanup()
  }
})
