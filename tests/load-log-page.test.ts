import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from 'koishi'
import { apply } from '../src'

// 读取一页的分页、游标、筛选、排序、早停与文件竞态断言已下沉到 tests/log-archive.test.ts，
// 直接驱动日志归档 module。这里只保留一条装配层接线测试，证明事件监听器把请求转交日志归档
// 并原样返回其结果——即历史读取确实经过了 apply 注册的那个 adapter。

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

test('事件监听器把请求转交日志归档并返回其读取结果', async () => {
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
    await writeFile(
      join(root, `${date}-1.log`),
      records.map(record => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    )
    await apply(ctx as any, {
      root: 'logs',
      maxAge: 0,
      maxSize: 1024 * 100,
      autoUnloadHistoryLogs: true,
      preservePausedPositionOnReturn: false,
    })

    assert.ok(console.listener)
    // 装配层注册的 adapter 返回的正是日志归档按当前筛选读到的一页
    const page = await console.listener({ path: 'plugin.alpha' }) as {
      logs: Logger.Record[]
      cursor?: string
      hasMore: boolean
    }
    assert.deepEqual(page.logs.map(record => record.id), [1, 3])
    assert.equal(page.cursor, `${records[0].timestamp}:1`)
    assert.equal(page.hasMore, false)
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})
