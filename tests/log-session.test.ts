import test from 'node:test'
import assert from 'node:assert/strict'
import { Logger } from 'koishi'
import { createLogSession } from '../client/log-session'
import type { LogPage, LogPageRequest, LogSessionResult } from '../client/log-session'
import { getLogKey } from '../client/log-record'

function createRecord(id: number, timestamp = id * 1000, extra: Partial<Logger.Record> = {}): Logger.Record {
  return {
    id,
    timestamp,
    type: 'info',
    name: 'app',
    content: `${timestamp}:${id}`,
    meta: {},
    ...extra,
  } as Logger.Record
}

interface PendingRequest {
  request: LogPageRequest
  resolve(page: LogPage): void
  reject(error?: unknown): void
}

/**
 * 会话测试床：一个内存请求 adapter 加可推进的时钟，全程不碰 DOM 与真实计时器。
 *
 * loadPage 不立即返回，而是把每次请求推进队列，测试显式决定它成功、失败与返回顺序，
 * 以稳定复现响应乱序、失败重试与卸载交叠。时钟按注入的 schedule 累计延时，advance 到期才触发。
 */
function createHarness(options: { liveLogs?: Logger.Record[]; autoUnloadDelay?: number } = {}) {
  const pending: PendingRequest[] = []
  let live = options.liveLogs ?? []
  let result: LogSessionResult = { records: [], loadedRecords: [], canLoadMore: false, loadingMore: false }
  const errors: string[] = []
  let queryResets = 0
  let dateCleared = 0

  // 可推进的时钟：schedule 登记到期时间点，advance 把时间往前拨，到期回调按序触发一次
  let clockNow = 0
  interface Timer { at: number; task: () => void; cancelled: boolean }
  let timers: Timer[] = []

  const session = createLogSession({
    loadPage(request) {
      return new Promise<LogPage>((resolve, reject) => pending.push({ request, resolve, reject }))
    },
    getLiveLogs: () => live,
    onResult(next) {
      result = next
    },
    onError(message) {
      errors.push(message)
    },
    onQueryReset() {
      queryResets++
    },
    onDateCleared() {
      dateCleared++
    },
    schedule(task, delay) {
      const timer: Timer = { at: clockNow + delay, task, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    autoUnloadDelay: options.autoUnloadDelay ?? 1000,
  })

  return {
    session,
    result: () => result,
    records: () => result.records.map(getLogKey),
    errors: () => errors,
    queryResets: () => queryResets,
    dateCleared: () => dateCleared,
    pendingCount: () => pending.length,
    lastRequest: () => pending[pending.length - 1]?.request,
    setLive(next: Logger.Record[]) {
      live = next
      session.liveLogsChanged()
    },
    // 解决队首请求，模拟服务端一页返回
    async resolveNext(page: LogPage) {
      const entry = pending.shift()
      assert.ok(entry, '没有待解决的请求')
      entry.resolve(page)
      await tick()
    },
    // 解决指定序号请求，用于制造响应乱序
    async resolveAt(index: number, page: LogPage) {
      const entry = pending.splice(index, 1)[0]
      assert.ok(entry, `没有序号为 ${index} 的请求`)
      entry.resolve(page)
      await tick()
    },
    async rejectNext() {
      const entry = pending.shift()
      assert.ok(entry, '没有待解决的请求')
      entry.reject(new Error('读取失败'))
      await tick()
    },
    async rejectAt(index: number) {
      const entry = pending.splice(index, 1)[0]
      assert.ok(entry, `没有序号为 ${index} 的请求`)
      entry.reject(new Error('读取失败'))
      await tick()
    },
    // 把时间往前拨，触发到期计时器
    advance(delay: number) {
      clockNow += delay
      const due = timers.filter(timer => !timer.cancelled && timer.at <= clockNow)
      timers = timers.filter(timer => !timer.cancelled && timer.at > clockNow)
      for (const timer of due) timer.task()
    },
    hasTimer: () => timers.some(timer => !timer.cancelled),
  }
}

// 让已 resolve/reject 的 Promise 续体跑完
function tick() {
  return new Promise<void>(resolve => setImmediate(resolve))
}

const R = createRecord

test('无筛选初始化只显示实时数据，不自动读取历史', async () => {
  const harness = createHarness({ liveLogs: [R(1), R(2)] })
  harness.session.setQuery({})
  await tick()
  assert.equal(harness.pendingCount(), 0)
  assert.deepEqual(harness.records(), ['1000:1', '2000:2'])
})

test('无筛选手动加载使用当前展示最早一条作起点', async () => {
  const harness = createHarness({ liveLogs: [R(3), R(4)] })
  harness.session.setQuery({})
  const loading = harness.session.loadMore()
  await tick()
  assert.equal(harness.lastRequest()?.cursor, '3000:3')
  await harness.resolveNext({ logs: [R(1), R(2)], cursor: '1000:1', hasMore: true })
  await loading
  assert.deepEqual(harness.records(), ['1000:1', '2000:2', '3000:3', '4000:4'])
})

test('有效筛选加载第一页，等价查询不因数组引用变化重复请求', async () => {
  const harness = createHarness()
  harness.session.setQuery({ path: 'a', searchPaths: ['a'] })
  await tick()
  assert.equal(harness.pendingCount(), 1)
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: false })
  // 内容相同、仅数组引用变化，不应再触发请求
  harness.session.setQuery({ path: 'a', searchPaths: ['a'] })
  await tick()
  assert.equal(harness.pendingCount(), 0)
})

test('第一页加载中重复触发不并发请求同一查询的下一页', async () => {
  const harness = createHarness()
  harness.session.setQuery({ path: 'a' })
  await tick()
  assert.equal(harness.pendingCount(), 1)
  void harness.session.loadMore()
  void harness.session.loadMore()
  await tick()
  // 第一页在途，后续 loadMore 全部被挡
  assert.equal(harness.pendingCount(), 1)
})

test('第一页 hasMore 为 false 后不可继续分页', async () => {
  const harness = createHarness()
  harness.session.setQuery({ path: 'a' })
  await tick()
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: false })
  assert.equal(harness.result().canLoadMore, false)
  await harness.session.loadMore()
  assert.equal(harness.pendingCount(), 0)
})

test('空结果第一页正确结束', async () => {
  const harness = createHarness()
  harness.session.setQuery({ date: '2026-09-19' })
  await tick()
  await harness.resolveNext({ logs: [], hasMore: false })
  assert.deepEqual(harness.records(), [])
  assert.equal(harness.result().canLoadMore, false)
})

test('后续页使用当前查询的服务端游标', async () => {
  const harness = createHarness()
  // 用 type 筛选触发第一页：所有测试记录都是 info，展示层再过滤时全部命中
  harness.session.setQuery({ type: 'info' })
  await tick()
  await harness.resolveNext({ logs: [R(5)], cursor: '5000:5', hasMore: true })
  const loading = harness.session.loadMore()
  await tick()
  assert.equal(harness.lastRequest()?.cursor, '5000:5')
  await harness.resolveNext({ logs: [R(3)], cursor: '3000:3', hasMore: false })
  await loading
  assert.deepEqual(harness.records(), ['3000:3', '5000:5'])
})

test('共享缓存含较早记录时新筛选仍从第一页建立进度，不跳过缺失区间', async () => {
  const harness = createHarness()
  // 先加载过滤 a 的历史，缓存里留下较早记录
  harness.session.setQuery({ path: 'a' })
  await tick()
  await harness.resolveNext({ logs: [R(1), R(2)], cursor: '1000:1', hasMore: true })
  // 切到过滤 b：第一页游标必须为空，从最新匹配处扫描，而不是沿用缓存里的 1000:1
  harness.session.setQuery({ path: 'b' })
  await tick()
  assert.equal(harness.lastRequest()?.cursor, undefined)
  assert.equal(harness.lastRequest()?.path, 'b')
})

test('切换非日期筛选保留缓存并重置分页，清除筛选后缓存仍可展示', async () => {
  const harness = createHarness({ liveLogs: [] })
  harness.session.setQuery({ path: 'a' })
  await tick()
  await harness.resolveNext({ logs: [R(1, 1000, { meta: { paths: ['a'] } })], cursor: '1000:1', hasMore: false })
  // 切到过滤 b
  harness.session.setQuery({ path: 'b' })
  await tick()
  await harness.resolveNext({ logs: [R(2, 2000, { meta: { paths: ['b'] } })], cursor: '2000:2', hasMore: false })
  // 清除筛选：缓存里 a、b 两条历史仍可展示
  harness.session.setQuery({})
  await tick()
  assert.deepEqual(harness.records(), ['1000:1', '2000:2'])
})

test('日期结果独立，实时到达不混入日期结果', async () => {
  const harness = createHarness({ liveLogs: [R(9)] })
  harness.session.setQuery({ date: '2026-09-19' })
  await tick()
  await harness.resolveNext({ logs: [R(1), R(2)], cursor: '1000:1', hasMore: false })
  assert.deepEqual(harness.records(), ['1000:1', '2000:2'])
  // 实时日志到来不改变日期展示
  harness.setLive([R(9), R(10)])
  assert.deepEqual(harness.records(), ['1000:1', '2000:2'])
})

test('切换日期清空上一日期展示', async () => {
  const harness = createHarness()
  harness.session.setQuery({ date: '2026-09-19' })
  await tick()
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: false })
  harness.session.setQuery({ date: '2026-09-18' })
  await tick()
  // 新日期第一页尚未返回时不残留旧日期记录
  assert.deepEqual(harness.records(), [])
})

test('查询切换使旧的第一页响应失效，成功也不污染新查询', async () => {
  const harness = createHarness()
  // 用日期查询隔离展示，避免非日期展示层的路径过滤干扰断言
  harness.session.setQuery({ date: '2026-09-19' })
  await tick()
  harness.session.setQuery({ date: '2026-09-18' })
  await tick()
  // 队列里有 A、B 两个请求；先让旧的 A 成功，不能写进 B
  await harness.resolveAt(0, { logs: [R(1)], cursor: '1000:1', hasMore: true })
  assert.deepEqual(harness.records(), [])
  await harness.resolveNext({ logs: [R(2)], cursor: '2000:2', hasMore: false })
  assert.deepEqual(harness.records(), ['2000:2'])
})

test('后续页在途时切换查询，旧后续页失败不改新查询加载状态', async () => {
  const harness = createHarness()
  harness.session.setQuery({ date: '2026-09-19' })
  await tick()
  await harness.resolveNext({ logs: [R(5)], cursor: '5000:5', hasMore: true })
  void harness.session.loadMore()
  await tick()
  // 后续页在途时切到另一天
  harness.session.setQuery({ date: '2026-09-18' })
  await tick()
  const beforeErrors = harness.errors().length
  // 旧后续页失败：不得写错误也不得改动新查询的加载状态
  await harness.rejectAt(0)
  assert.equal(harness.errors().length, beforeErrors)
  assert.equal(harness.result().loadingMore, true)
})

test('非日期第一页失败保留可用记录并允许重试第一页', async () => {
  const harness = createHarness({ liveLogs: [R(8)] })
  harness.session.setQuery({ type: 'info' })
  await tick()
  await harness.rejectNext()
  assert.deepEqual(harness.errors(), ['加载日志失败'])
  // 失败保留实时记录
  assert.deepEqual(harness.records(), ['8000:8'])
  // 重试仍为第一页：游标为空
  const retry = harness.session.loadMore()
  await tick()
  assert.equal(harness.lastRequest()?.cursor, undefined)
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: false })
  await retry
  assert.deepEqual(harness.records(), ['1000:1', '8000:8'])
})

test('日期第一页失败保持空结果并允许重试', async () => {
  const harness = createHarness({ liveLogs: [R(8)] })
  harness.session.setQuery({ date: '2026-09-19' })
  await tick()
  await harness.rejectNext()
  assert.deepEqual(harness.records(), [])
  const retry = harness.session.loadMore()
  await tick()
  assert.equal(harness.lastRequest()?.date, '2026-09-19')
  assert.equal(harness.lastRequest()?.cursor, undefined)
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: false })
  await retry
  assert.deepEqual(harness.records(), ['1000:1'])
})

test('后续页失败保留原页与游标，重试请求同一页且不当作正常结束', async () => {
  const harness = createHarness()
  harness.session.setQuery({ type: 'info' })
  await tick()
  await harness.resolveNext({ logs: [R(5)], cursor: '5000:5', hasMore: true })
  const failing = harness.session.loadMore()
  await tick()
  await harness.rejectNext()
  await failing
  assert.deepEqual(harness.errors(), ['加载更早日志失败'])
  // 失败不改为正常结束
  assert.equal(harness.result().canLoadMore, true)
  assert.deepEqual(harness.records(), ['5000:5'])
  // 重试仍请求同一逻辑页：沿用 5000:5 游标
  const retry = harness.session.loadMore()
  await tick()
  assert.equal(harness.lastRequest()?.cursor, '5000:5')
  await harness.resolveNext({ logs: [R(3)], cursor: '3000:3', hasMore: false })
  await retry
  assert.deepEqual(harness.records(), ['3000:3', '5000:5'])
})

test('自动卸载只在有已加载历史时调度', async () => {
  const harness = createHarness({ autoUnloadDelay: 1000 })
  harness.session.setQuery({})
  await tick()
  // 无已加载历史不排程
  assert.equal(harness.hasTimer(), false)
  const loading = harness.session.loadMore()
  await tick()
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: true })
  await loading
  assert.equal(harness.hasTimer(), true)
})

test('浏览保活延后卸载', async () => {
  const harness = createHarness({ autoUnloadDelay: 1000 })
  harness.session.setQuery({ type: 'info' })
  await tick()
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: false })
  harness.advance(600)
  harness.session.keepAlive()
  harness.advance(600)
  // 保活后重新计时，1200 累计未触发卸载
  assert.deepEqual(harness.records(), ['1000:1'])
  harness.advance(500)
  assert.deepEqual(harness.records(), [])
})

test('实时推送不无限保活', async () => {
  const harness = createHarness({ autoUnloadDelay: 1000, liveLogs: [R(9)] })
  harness.session.setQuery({ path: 'a' })
  await tick()
  await harness.resolveNext({ logs: [R(1, 1000, { meta: { paths: ['a'] } })], cursor: '1000:1', hasMore: false })
  harness.advance(600)
  // 实时推送不算浏览活动，不重置计时
  harness.setLive([R(9), R(10)])
  harness.advance(500)
  assert.deepEqual(harness.records(), [])
})

test('关闭自动卸载取消计时，重开按条件恢复', async () => {
  const harness = createHarness({ autoUnloadDelay: 1000 })
  harness.session.setQuery({ type: 'info' })
  await tick()
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: false })
  harness.session.setAutoUnload(false)
  assert.equal(harness.hasTimer(), false)
  harness.advance(2000)
  assert.deepEqual(harness.records(), ['1000:1'])
  // 重开恢复调度
  harness.session.setAutoUnload(true)
  assert.equal(harness.hasTimer(), true)
})

test('反复保活不积累多个有效卸载回调', async () => {
  const harness = createHarness({ autoUnloadDelay: 1000 })
  harness.session.setQuery({ type: 'info' })
  await tick()
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: false })
  harness.session.keepAlive()
  harness.session.keepAlive()
  harness.session.keepAlive()
  // 只保留一个有效计时器
  let count = 0
  harness.advance(1000)
  count = harness.records().length
  assert.equal(count, 0)
})

test('到期卸载清空历史和分页，保留实时数据，并使在途请求失效', async () => {
  const harness = createHarness({ autoUnloadDelay: 1000, liveLogs: [R(9)] })
  harness.session.setQuery({ path: 'a' })
  await tick()
  await harness.resolveNext({ logs: [R(1, 1000, { meta: { paths: ['a'] } })], cursor: '1000:1', hasMore: true })
  // 后续页在途时卸载
  void harness.session.loadMore()
  await tick()
  harness.advance(1000)
  // 卸载后迟到成功不能把历史填回
  await harness.resolveNext({ logs: [R(0)], cursor: '0:0', hasMore: true })
  // 实时数据保留，历史清空（R(9) 不带 path a，被过滤）
  assert.deepEqual(harness.records(), [])
})

test('日期卸载返回实时模式且保留其他筛选，不立即请求历史', async () => {
  const harness = createHarness({ autoUnloadDelay: 1000, liveLogs: [] })
  harness.session.setQuery({ date: '2026-09-19', path: 'a' })
  await tick()
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: false })
  const pendingBefore = harness.pendingCount()
  harness.advance(1000)
  // 通知适配器清除日期
  assert.equal(harness.dateCleared(), 1)
  // 卸载不立即回填历史
  assert.equal(harness.pendingCount(), pendingBefore)
})

test('卸载后手动加载可重新启动正确的历史加载', async () => {
  const harness = createHarness({ autoUnloadDelay: 1000 })
  harness.session.setQuery({ type: 'info' })
  await tick()
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: true })
  harness.advance(1000)
  // 卸载后仍有有效筛选，loadMore 重新从第一页扫描，不沿用已清除的游标
  const loading = harness.session.loadMore()
  await tick()
  assert.equal(harness.lastRequest()?.cursor, undefined)
  assert.equal(harness.lastRequest()?.type, 'info')
  await harness.resolveNext({ logs: [R(2)], cursor: '2000:2', hasMore: false })
  await loading
  assert.deepEqual(harness.records(), ['2000:2'])
})

test('销毁后请求返回与计时回调都不发布状态', async () => {
  const harness = createHarness({ autoUnloadDelay: 1000, liveLogs: [R(9)] })
  harness.session.setQuery({ path: 'a' })
  await tick()
  harness.session.dispose()
  const snapshot = harness.records()
  await harness.resolveNext({ logs: [R(1)], cursor: '1000:1', hasMore: true })
  assert.deepEqual(harness.records(), snapshot)
  harness.advance(2000)
  assert.deepEqual(harness.records(), snapshot)
})

test('合并后的日志按时间与身份去重排序', async () => {
  const harness = createHarness({ liveLogs: [R(2), R(4)] })
  harness.session.setQuery({})
  const loading = harness.session.loadMore()
  await tick()
  // 返回含与实时重叠的一条 R(2)
  await harness.resolveNext({ logs: [R(1), R(2)], cursor: '1000:1', hasMore: true })
  await loading
  assert.deepEqual(harness.records(), ['1000:1', '2000:2', '4000:4'])
})
