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
    await writeFile(join(root, `${date}-1.log`), records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
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
