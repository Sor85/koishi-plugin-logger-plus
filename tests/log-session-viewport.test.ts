import test from 'node:test'
import assert from 'node:assert/strict'
import { Logger } from 'koishi'
import { createLogSession } from '../client/log-session'
import type { LogPage, LogPageRequest } from '../client/log-session'
import { createLogViewport } from '../client/log-viewport'
import type { LogViewportState } from '../client/log-viewport'
import type { ViewportHost, ViewportLine } from '../client/viewport-host'
import type { VirtualListWindow } from '../client/virtual-list'
import { getLogKey } from '../client/log-record'

/**
 * 会话与视口的协作测试。
 *
 * 生产接线是 `logs.vue` 里的 `viewport.around(() => session.loadMore())`：前插的取一页与写记录
 * 整体交给 around 保护阅读位置，会话在写入前核对请求仍属于当前查询。这里用真实会话 + 真实视口
 * 复现「加载更早记录时切换查询」，验证旧操作既不把过期数据写进新查询，也不对新查询施加过期的
 * 位置恢复；沿用现有视口测试 seam，不新增 DOM seam。
 */

function createRecord(id: number): Logger.Record {
  return { id, timestamp: id * 1000, type: 'info', name: 'app', content: `${id}`, meta: {} } as Logger.Record
}

function keysOf(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => `${(index + offset + 1) * 1000}:${index + offset + 1}`)
}

// 复用视口测试床的假滚动容器：按窗口与实测高度算几何，全程不碰 DOM
function createViewportHarness(keys: string[], lineHeight = 100) {
  let list = [...keys]
  const clientHeight = 200
  const contentTop = 10
  let scrollTop = 0
  let scrollCalls = 0
  let rendered: VirtualListWindow = { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 }
  let state: LogViewportState | undefined
  const frames: Array<() => void> = []

  function renderedHeight() {
    return (rendered.end - rendered.start) * lineHeight
  }
  function scrollHeight() {
    return contentTop + rendered.paddingTop + renderedHeight() + rendered.paddingBottom
  }
  function maxScrollTop() {
    return Math.max(0, scrollHeight() - clientHeight)
  }
  function lines(): ViewportLine[] {
    const result: ViewportLine[] = []
    let offset = rendered.paddingTop
    for (let index = rendered.start; index < rendered.end; index++) {
      result.push({ key: list[index], height: lineHeight, top: contentTop + offset - scrollTop })
      offset += lineHeight
    }
    return result
  }

  const host: ViewportHost = {
    metrics: () => ({ scrollTop, clientHeight, clientWidth: 600, scrollHeight: scrollHeight(), contentTop }),
    lines,
    scrollTo(value) {
      scrollCalls++
      scrollTop = Math.min(Math.max(value, 0), maxScrollTop())
    },
    estimatedLineHeight: () => lineHeight,
  }

  const viewport = createLogViewport({
    host,
    schedule(task) {
      frames.push(task)
      return () => {
        const index = frames.indexOf(task)
        if (index >= 0) frames.splice(index, 1)
      }
    },
    async flush() {
      render()
    },
    fallbackViewportHeight: () => clientHeight,
    onStateChange(next) { state = next },
    overscan: 600,
    fallbackLineHeight: lineHeight,
  })

  function render() {
    if (state) rendered = state.window
  }
  async function advance(times = 1) {
    for (let round = 0; round < times; round++) {
      render()
      for (const task of frames.splice(0)) task()
      await new Promise<void>(resolve => setImmediate(resolve))
      render()
    }
  }

  // 等一个异步动作跑完，其间不断推进帧；动作本身要等帧才会继续
  async function run(action: Promise<void>, limit = 30) {
    let done = false
    const settled = action.then(() => { done = true }, () => { done = true })
    for (let round = 0; round < limit && !done; round++) await advance(1)
    await settled
    await advance(2)
  }

  return {
    viewport,
    advance,
    run,
    setItems(next: string[]) {
      list = [...next]
      viewport.setItems(list)
    },
    setScrollTop(value: number) { scrollTop = Math.min(Math.max(value, 0), maxScrollTop()) },
    scrollCalls: () => scrollCalls,
    resetScrollCalls() { scrollCalls = 0 },
    firstVisible: () => lines().find(line => line.top + line.height >= 0),
    topOf(key: string) { return lines().find(line => line.key === key)?.top },
    async mount() {
      viewport.setItems(list)
      viewport.handleResize()
      await advance(4)
    },
  }
}

function tick() {
  return new Promise<void>(resolve => setImmediate(resolve))
}

test('加载更早记录时切换查询：旧页不写入新查询，也不施加过期位置恢复', async () => {
  // 非日期浏览，已展示较新的日志
  const initial = Array.from({ length: 200 }, (_, index) => createRecord(index + 101))
  let records = [...initial]
  const view = createViewportHarness(initial.map(getLogKey))
  await view.mount()

  const pending: Array<{ request: LogPageRequest; resolve(page: LogPage): void }> = []
  const session = createLogSession({
    loadPage: (request) => new Promise<LogPage>(resolve => { pending.push({ request, resolve }) }),
    getLiveLogs: () => records,
    onResult(result) {
      // 生产里 records 是响应式 prop；这里同步落库并驱动视口 setItems
      records = result.records
    },
    onError() {},
    onQueryReset() {},
    onDateCleared() {},
    schedule() { return () => {} },
    autoUnloadDelay: 1000,
  })
  session.setQuery({})

  // 上滚进入暂停，记下当前阅读位置
  view.setScrollTop(310)
  view.viewport.handleScroll()
  await view.advance(2)
  const before = view.firstVisible()!
  view.resetScrollCalls()

  // 开始加载更早记录：整段交给 around，内部 loadMore 发出请求后挂起
  const operation = view.viewport.around(async () => {
    await session.loadMore()
    view.setItems(records.map(getLogKey))
  })
  await view.advance(2)

  // 请求在途时切换查询：旧请求应失效。切到仍能匹配全部实时记录的非日期筛选，
  // 使新查询的展示保持基于实时流，从而干净地验证旧页既不写数据也不施加过期位置恢复
  session.setQuery({ type: 'info' })
  await tick()

  // 队首是前插的 loadMore 请求（切查询前发出）；现在才返回，它属于已失效的查询，不能写入当前展示
  pending[0].resolve({ logs: [createRecord(1), createRecord(2)], cursor: '1000:1', hasMore: true })
  await view.run(operation)

  // 旧页的记录没有混进来
  assert.equal(records.some(record => record.id === 1), false)
  // 旧操作未对新查询施加过期的位置恢复：阅读位置保持不变
  assert.equal(view.topOf(before.key), before.top)
})
