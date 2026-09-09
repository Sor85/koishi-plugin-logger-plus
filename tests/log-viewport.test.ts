import test from 'node:test'
import assert from 'node:assert/strict'
import type { LogViewportState } from '../client/log-viewport'
import { createLogViewport } from '../client/log-viewport'
import type { ViewportHost, ViewportLine } from '../client/viewport-host'
import type { VirtualListWindow } from '../client/virtual-list'

interface HarnessOptions {
  keys: string[]
  /** 行的真实渲染高度；正文换行与跨重启的分隔行会让它偏离估算值，宽度变化也会改写它 */
  height?(key: string, width: number): number
  estimated?: number
  clientHeight?: number
  clientWidth?: number
  /** 占位容器之前的「查看更多消息」按钮与顶部内边距 */
  contentTop?: number
  overscan?: number
}

/**
 * 假滚动容器：一个字面量对象，按窗口与实测高度算出行的几何，全程不碰 DOM。
 *
 * 它模仿浏览器的两条事实：渲染出来的行永远是真实高度；窗口之外的高度由上下占位顶出来，
 * 而占位来自布局的估算。两者不一致时视口内容就会移动，这正是要测的东西。
 */
function createHarness(options: HarnessOptions) {
  const estimated = options.estimated ?? 20
  const contentTop = options.contentTop ?? 10
  const heightOf = options.height ?? (() => estimated)
  const clientHeight = options.clientHeight ?? 200

  let keys = [...options.keys]
  let clientWidth = options.clientWidth ?? 600
  let scrollTop = 0
  let scrollCalls = 0
  let rendered: VirtualListWindow = { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 }
  let state: LogViewportState | undefined
  const frames: Array<() => void> = []

  function renderedHeight() {
    let total = 0
    for (let index = rendered.start; index < rendered.end; index++) {
      total += heightOf(keys[index], clientWidth)
    }
    return total
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
      const key = keys[index]
      const height = heightOf(key, clientWidth)
      result.push({ key, height, top: contentTop + offset - scrollTop })
      offset += height
    }
    return result
  }

  const host: ViewportHost = {
    metrics: () => ({ scrollTop, clientHeight, clientWidth, scrollHeight: scrollHeight(), contentTop }),
    lines,
    scrollTo(value) {
      scrollCalls++
      scrollTop = Math.min(Math.max(value, 0), maxScrollTop())
    },
    estimatedLineHeight: () => estimated,
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
    flush: () => Promise.resolve(),
    fallbackViewportHeight: () => clientHeight,
    onStateChange(next) {
      state = next
      rendered = next.window
    },
    overscan: options.overscan ?? 600,
    fallbackLineHeight: estimated,
  })

  // 帧由测试手动推进：跑完这一批帧再把微任务排空，等价于浏览器里一帧走完
  async function advance(times = 1) {
    for (let round = 0; round < times; round++) {
      for (const task of frames.splice(0)) task()
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  // 等一个异步动作跑完，其间不断推进帧；动作本身要等帧才会继续
  async function run(action: Promise<void>, limit = 20) {
    let done = false
    const settled = action.then(() => { done = true }, () => { done = true })
    for (let round = 0; round < limit && !done; round++) await advance(1)
    await settled
    await action
    await advance(2)
  }

  return {
    host,
    viewport,
    advance,
    run,
    keys: () => keys,
    state: () => state!,
    scrollTop: () => scrollTop,
    scrollHeight,
    scrollCalls: () => scrollCalls,
    resetScrollCalls() {
      scrollCalls = 0
    },
    lines,
    firstVisible: () => lines().find(line => line.top + line.height >= 0),
    topOf(key: string) {
      return lines().find(line => line.key === key)?.top
    },
    setItems(next: string[]) {
      keys = [...next]
      viewport.setItems(keys)
    },
    setScrollTop(value: number) {
      scrollTop = Math.min(Math.max(value, 0), maxScrollTop())
    },
    setWidth(width: number) {
      clientWidth = width
    },
    // 模仿组件挂载：ResizeObserver 立刻回调一次，量下容器宽度与估算行高
    async mount() {
      viewport.setItems(keys)
      viewport.handleResize()
      await advance(4)
    },
  }
}

function keysOf(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => `${index + offset}`)
}

test('追踪最新日志时新日志不断到来仍停在底部', async () => {
  const harness = createHarness({ keys: keysOf(50) })
  await harness.mount()

  assert.equal(harness.state().isFollowing, true)
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 200)

  harness.setItems(keysOf(70))
  await harness.advance(4)

  assert.equal(harness.state().isFollowing, true)
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 200)
})

test('向上滚动后转入暂停，此后追加日志阅读位置不动', async () => {
  const harness = createHarness({ keys: keysOf(200) })
  await harness.mount()

  harness.setScrollTop(harness.scrollTop() - 600)
  harness.viewport.handleScroll()
  await harness.advance(4)

  assert.equal(harness.state().isFollowing, false)

  const before = harness.firstVisible()!
  const scrollTop = harness.scrollTop()

  harness.setItems(keysOf(240))
  await harness.advance(4)

  assert.equal(harness.state().isFollowing, false)
  assert.equal(harness.scrollTop(), scrollTop)
  assert.equal(harness.topOf(before.key), before.top)
})

test('前插更早的日志后视口第一条仍停在原处', async () => {
  const harness = createHarness({ keys: keysOf(200, 100) })
  await harness.mount()

  harness.setScrollTop(harness.scrollTop() - 800)
  harness.viewport.handleScroll()
  await harness.advance(4)

  const before = harness.firstVisible()!

  await harness.run(harness.viewport.around(() => {
    harness.setItems([...keysOf(20, 80), ...harness.keys()])
  }))

  assert.equal(harness.topOf(before.key), before.top)
})

test('实测高度覆盖估算高度后视口第一条的相对偏移不变', async () => {
  // 正文换行让真实行高是估算值的三倍：首次量到之前占位一直按估算顶位
  const harness = createHarness({ keys: keysOf(200), height: () => 60 })
  await harness.mount()

  harness.setScrollTop(harness.scrollTop() - 900)
  harness.viewport.handleScroll()

  const before = harness.firstVisible()!

  await harness.advance(8)

  assert.equal(harness.topOf(before.key), before.top)
})

test('锚点滑出渲染窗口后仍能恢复到原来的相对偏移', async () => {
  const harness = createHarness({ keys: keysOf(400) })
  await harness.mount()

  harness.setScrollTop(harness.scrollTop() - 1200)
  harness.viewport.handleScroll()
  await harness.advance(4)

  const anchor = harness.viewport.capture()!
  assert.ok(anchor)

  // 滚到很远处，锚点那条日志已经不在渲染窗口里
  harness.setScrollTop(0)
  harness.viewport.handleScroll()
  await harness.advance(4)

  assert.equal(harness.topOf(anchor.key), undefined)

  await harness.run(harness.viewport.restore(anchor))

  assert.equal(harness.topOf(anchor.key), anchor.offset)
})

test('容器宽度变化后丢弃实测高度重量，当前位置保持不变', async () => {
  // 宽度一变换行结果全部失效：窄容器里每行要占两倍高度，两者都不等于估算值
  const harness = createHarness({
    keys: keysOf(200),
    height: (_key, width) => width < 500 ? 60 : 30,
  })
  await harness.mount()

  harness.setScrollTop(harness.scrollTop() - 900)
  harness.viewport.handleScroll()
  await harness.advance(6)

  const wideHeight = harness.scrollHeight()

  // 浏览器先按新宽度重排，ResizeObserver 才回调；此刻的位置就是要保住的位置
  harness.setWidth(400)
  const before = harness.firstVisible()!
  harness.viewport.handleResize()
  await harness.advance(10)

  assert.equal(harness.topOf(before.key), before.top)
  // 实测高度被丢弃后按新宽度重量，总高度随之抬高
  assert.ok(harness.scrollHeight() > wideHeight, `总高度仍是 ${harness.scrollHeight()}`)
})

test('容器只有高度变化时不丢弃实测高度', async () => {
  const harness = createHarness({ keys: keysOf(200), height: () => 60 })
  await harness.mount()

  harness.setScrollTop(harness.scrollTop() - 600)
  harness.viewport.handleScroll()
  await harness.advance(6)

  const before = harness.firstVisible()!
  const scrollTop = harness.scrollTop()

  harness.viewport.handleResize()
  await harness.advance(4)

  assert.equal(harness.scrollTop(), scrollTop)
  assert.equal(harness.topOf(before.key), before.top)
})

test('回到底部后立刻停在最新日志并恢复追踪', async () => {
  const harness = createHarness({ keys: keysOf(200) })
  await harness.mount()

  harness.setScrollTop(0)
  harness.viewport.handleScroll()
  await harness.advance(4)

  assert.equal(harness.state().isFollowing, false)

  harness.viewport.followLatest()
  await harness.advance(6)

  assert.equal(harness.state().isFollowing, true)
  assert.equal(harness.state().isViewingLatest, true)
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 200)
})

test('前插期间只有一处改滚动位置', async () => {
  // 「查看更多消息」只有滑到顶部才够得着，因此前插总是发生在清单前端；
  // 真实行高是估算值的五倍，前插的那批量到之前占位会短一大截
  const harness = createHarness({ keys: keysOf(200, 100), height: () => 100 })
  await harness.mount()

  harness.setScrollTop(310)
  harness.viewport.handleScroll()
  await harness.advance(8)

  const before = harness.firstVisible()!
  harness.resetScrollCalls()

  await harness.run(harness.viewport.around(() => {
    harness.setItems([...keysOf(40, 60), ...harness.keys()])
  }))

  assert.equal(harness.topOf(before.key), before.top)
  assert.equal(harness.scrollCalls(), 1, `滚动位置被改了 ${harness.scrollCalls()} 次`)
})

test('前插期间逐帧的贴底修正让路，不与复位争抢滚动位置', async () => {
  // 日志不多时「查看更多消息」和最新一条会同屏，此时仍在追踪最新日志；
  // 前插一旦开始，逐帧的贴底修正就必须让路，否则它和复位会互相打断
  const harness = createHarness({ keys: keysOf(30, 100), height: () => 100 })
  await harness.mount()

  assert.equal(harness.state().isFollowing, true)

  const before = harness.firstVisible()!
  harness.resetScrollCalls()

  await harness.run(harness.viewport.around(() => {
    harness.setItems([...keysOf(40, 60), ...harness.keys()])
  }))

  assert.equal(harness.topOf(before.key), before.top)
  assert.equal(harness.scrollCalls(), 1, `滚动位置被改了 ${harness.scrollCalls()} 次`)
})
