import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from 'koishi'
import { apply, Config } from '../src'

interface FakeConsole {
  listener?: (query?: unknown) => Promise<unknown>
  addListener(event: string, callback: (query?: unknown) => Promise<unknown>): void
  patch(): void
}

class FakeContext {
  public console: FakeConsole
  /** 清理与读取路径上的每一条 warn 都记下来：本轮的核心断言就是它一条都不该有。 */
  public warnings: unknown[] = []
  private disposeCallbacks: (() => void)[] = []

  constructor(public baseDir: string) {
    const self = this
    this.console = {
      addListener(event, callback) {
        if (event === 'logger-plus/load-before') this.listener = callback
      },
      patch() {},
    }
    this.logger = () => ({ warn: (error: unknown) => void self.warnings.push(error) })
  }

  public logger: () => { warn(error: unknown): void }

  get(name: string) {
    if (name === 'console') return this.console
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

const baseConfig: Config = {
  root: 'logs',
  maxAge: 30,
  maxSize: 200,
  showRecentLogsOnStartup: false,
  autoUnloadHistoryLogs: true,
  preservePausedPositionOnReturn: false,
}

function createRecord(id: number, timestamp: number): Logger.Record {
  return {
    id,
    timestamp,
    type: 'info',
    name: 'test',
    content: `record ${id} ${'x'.repeat(120)}`,
    meta: {},
  } as Logger.Record
}

/** 清理是不可等待的后台任务，因此按结果轮询而不是猜一个固定的等待时长。 */
async function waitFor(assertion: () => Promise<void> | void, timeout = 2000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      return await assertion()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

async function setup(files: Record<string, string> = {}) {
  const baseDir = await mkdtemp(join(tmpdir(), 'logger-plus-prune-'))
  const root = join(baseDir, 'logs')
  await mkdir(root)
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(join(root, filename), content, 'utf8')
  }
  return { baseDir, root, ctx: new FakeContext(baseDir) }
}

/** apply 把自己挂进全局 Logger.targets，取最后一个就是本次挂上去的那个。 */
function lastTarget() {
  return Logger.targets[Logger.targets.length - 1]
}

test('启动时删掉过期日志，并且不写任何日志', async () => {
  const { baseDir, root, ctx } = await setup({
    '2020-01-01-1.log': '',
    '2020-01-01-2.log': '',
  })

  try {
    await apply(ctx as never, baseConfig)

    await waitFor(async () => {
      const remaining = (await readdir(root)).filter(name => name.startsWith('2020-01-01'))
      assert.deepEqual(remaining, [])
    })
    assert.deepEqual(ctx.warnings, [])
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})

test('清理还在进行时不断滚动文件，不会把同一批文件清理两遍', async () => {
  // 清理是不可等待的后台任务：旧写法在删完全部文件之后才把日期从清单里摘掉，因此滚动触发的
  // 第二次清理会看到同一批文件、再删一遍，第二遍全是「文件不存在」——正是刷屏的起点。
  const expired = Object.fromEntries(
    Array.from({ length: 40 }, (_, offset) => [`2020-01-01-${offset + 1}.log`, '']),
  )
  const { baseDir, root, ctx } = await setup(expired)

  try {
    await apply(ctx as never, baseConfig)

    // 刻意不等启动清理结束，让滚动与清理交叠。
    const target = lastTarget()
    for (let id = 0; id < 30; id++) target.record(createRecord(id, Date.now()))

    await waitFor(async () => {
      const remaining = (await readdir(root)).filter(name => name.startsWith('2020-01-01'))
      assert.deepEqual(remaining, [])
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    assert.deepEqual(ctx.warnings, [])
    // 30 条 120 字节以上的记录、上限 200 字节，确实滚动过多次。
    assert.ok((await readdir(root)).filter(name => name.endsWith('.log')).length > 5)
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})

test('跨日滚动时清理这一刻才过期的日志', async () => {
  // 2029-12-01 相对真实时间还在未来，启动时不算过期；相对下面那条 2030-01-15 的记录已经过期 45 天。
  const expired = '2029-12-01-1.log'
  const { baseDir, root, ctx } = await setup({ [expired]: '' })

  try {
    await apply(ctx as never, baseConfig)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await readdir(root)).includes(expired), true)

    lastTarget().record(createRecord(1, Date.parse('2030-01-15T00:00:00.000Z')))

    await waitFor(async () => assert.equal((await readdir(root)).includes(expired), false))
    assert.deepEqual(ctx.warnings, [])
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})

test('读取时文件已经不在也不写日志', async () => {
  const today = new Date().toISOString().slice(0, 10)
  const missing = `${today}-5.log`
  const record = createRecord(1, Date.now())
  const { baseDir, root, ctx } = await setup({ [missing]: JSON.stringify(record) + '\n' })

  try {
    await apply(ctx as never, baseConfig)
    await rm(join(root, missing))

    const page = await ctx.console.listener!({ date: today }) as { logs: Logger.Record[] }

    assert.deepEqual(page.logs, [])
    assert.deepEqual(ctx.warnings, [])
  } finally {
    ctx.dispose()
    await rm(baseDir, { recursive: true, force: true })
  }
})
