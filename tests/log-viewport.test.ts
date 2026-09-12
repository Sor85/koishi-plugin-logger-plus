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
  flush?(): Promise<void>
  scrollEvents?: boolean
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
  let clientHeight = options.clientHeight ?? 200
  let connected = true

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
    metrics: () => connected ? { scrollTop, clientHeight, clientWidth, scrollHeight: scrollHeight(), contentTop } : undefined,
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
    async flush() {
      await (options.flush?.() ?? Promise.resolve())
      render()
    },
    fallbackViewportHeight: () => clientHeight,
    onStateChange(next) {
      state = next
    },
    overscan: options.overscan ?? 600,
    fallbackLineHeight: estimated,
  })

  function render() {
    if (state) rendered = state.window
    if (options.scrollEvents && scrollTop > maxScrollTop()) {
      scrollTop = maxScrollTop()
      // DOM 高度收缩会先钳制 scrollTop，再异步派发 scroll。
      queueMicrotask(() => viewport.handleScroll())
    }
  }

  // Vue 先提交上一轮状态，再执行帧回调；回调里的 nextTick 会再次提交 DOM。
  async function advance(times = 1) {
    for (let round = 0; round < times; round++) {
      render()
      for (const task of frames.splice(0)) task()
      await new Promise<void>(resolve => setImmediate(resolve))
      render()
    }
  }

  // 等一个异步动作跑完，其间不断推进帧；动作本身要等帧才会继续
  async function run(action: Promise<void>, limit = 20) {
    let done = false
    const settled = action.then(() => { done = true }, () => { done = true })
    for (let round = 0; round < limit && !done; round++) await advance(1)
    assert.equal(done, true, `异步动作在 ${limit} 帧内未完成`)
    await settled
    await action
    await advance(2)
  }

  return {
    host,
    viewport,
    render,
    advance,
    run,
    pendingFrames: () => frames.length,
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
    setHeight(height: number) {
      clientHeight = height
    },
    setConnected(value: boolean) {
      connected = value
    },
    // 模仿组件挂载：ResizeObserver 立刻回调一次，量下容器宽度与估算行高
    async mount() {
      viewport.setItems(keys)
      viewport.handleResize()
      await advance(4)
    },
  }
}

test('异步前插尚未完成时逐帧修正不得提前写滚动位置', async () => {
  const harness = createHarness({ keys: keysOf(30, 100), height: () => 100 })
  await harness.mount()
  const before = harness.firstVisible()!
  harness.resetScrollCalls()

  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const operation = harness.viewport.around(async () => {
    harness.setItems([...keysOf(20, 80), ...harness.keys()])
    await pending
  })
  await harness.advance(2)
  const intermediateCalls = harness.scrollCalls()
  release()
  await harness.run(operation)

  assert.equal(intermediateCalls, 0)
  assert.equal(harness.topOf(before.key), before.top)
  assert.equal(harness.scrollCalls(), 1)
})

test('卸载后未完成的前插不能恢复位置或发布状态', async () => {
  const harness = createHarness({ keys: keysOf(200, 100) })
  await harness.mount()
  harness.setScrollTop(310)
  harness.viewport.handleScroll()
  await harness.advance(2)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const operation = harness.viewport.around(async () => {
    harness.setItems([...keysOf(20, 80), ...harness.keys()])
    await pending
  })
  harness.viewport.dispose()
  const state = harness.state()
  harness.resetScrollCalls()
  release()
  await harness.run(operation)
  assert.equal(harness.scrollCalls(), 0)
  assert.equal(harness.state(), state)
})

test('已取锚点的旧帧在等待刷新期间遇到前插，应让出写入权', async () => {
  let held: Promise<void> | undefined
  const harness = createHarness({ keys: keysOf(200, 100), flush: () => held ?? Promise.resolve() })
  await harness.mount()
  harness.setScrollTop(310)
  harness.viewport.handleScroll()
  let resumeFrame!: () => void
  held = new Promise<void>(resolve => { resumeFrame = resolve })
  await harness.advance()

  let finishChange!: () => void
  const pending = new Promise<void>(resolve => { finishChange = resolve })
  harness.resetScrollCalls()
  const operation = harness.viewport.around(async () => {
    harness.setItems([...keysOf(20, 80), ...harness.keys()])
    await pending
  })
  held = undefined
  resumeFrame()
  await harness.advance(2)
  const calls = harness.scrollCalls()
  finishChange()
  await harness.run(operation)
  assert.equal(calls, 0)
  assert.equal(harness.scrollCalls(), 1)
})

test('变高窗口刷新导致浏览器钳制位置时不能误判为用户暂停', async () => {
  const harness = createHarness({ keys: keysOf(1000), height: key => 20 + Number(key) % 5 * 60, scrollEvents: true })
  await harness.mount()
  harness.viewport.followLatest()
  await harness.advance(10)
  assert.equal(harness.state().isFollowing, true)
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 200)
})

test('卸载取消贴底帧与前插等待帧，并结束等待中的操作', async () => {
  const harness = createHarness({ keys: keysOf(50) })
  await harness.mount()
  harness.viewport.followLatest()
  const operation = harness.viewport.around(() => {})
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(harness.pendingFrames() > 0)
  harness.viewport.dispose()
  assert.equal(harness.pendingFrames(), 0)
  await operation
})

test('容器断开时保留最后稳定锚点，恢复与缺失锚点均不写位置', async () => {
  const harness = createHarness({ keys: keysOf(200) })
  await harness.mount()
  harness.setScrollTop(310)
  harness.viewport.handleScroll()
  await harness.advance(2)
  const saved = harness.viewport.capture()!
  harness.setConnected(false)
  harness.setScrollTop(0)
  harness.viewport.handleScroll()
  assert.deepEqual(harness.viewport.capture(), saved)
  harness.resetScrollCalls()
  await harness.viewport.restore(saved)
  assert.equal(harness.scrollCalls(), 0)
  harness.setConnected(true)
  await harness.viewport.restore({ key: '已卸载的日志', offset: -5 })
  assert.equal(harness.scrollCalls(), 0)
})

test('异步变更失败后传播错误并释放闸门，下一次贴底正常', async () => {
  const harness = createHarness({ keys: keysOf(200) })
  await harness.mount()
  await assert.rejects(harness.viewport.around(async () => { throw new Error('读取失败') }), /读取失败/)
  harness.setItems(keysOf(220))
  await harness.advance(4)
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 200)
})

test('变高锚点滑出窗口后恢复只写一次最终位置', async () => {
  const harness = createHarness({ keys: keysOf(1000), height: key => 20 + Number(key) % 7 * 40 })
  await harness.mount()
  harness.setScrollTop(5000)
  harness.viewport.handleScroll()
  await harness.advance(3)
  const anchor = harness.viewport.capture()!
  harness.setScrollTop(0)
  harness.viewport.handleScroll()
  await harness.advance(3)
  harness.resetScrollCalls()
  await harness.run(harness.viewport.restore(anchor))
  assert.equal(harness.topOf(anchor.key), anchor.offset)
  assert.equal(harness.scrollCalls(), 1)
})

test('宽度改变后窗口外旧实测高度也回落估算，不残留旧换行缓存', async () => {
  const harness = createHarness({ keys: keysOf(200), clientWidth: 400, height: (_key, width) => width < 500 ? 60 : 20 })
  await harness.mount()
  harness.setScrollTop(1000)
  harness.viewport.handleScroll()
  await harness.advance(3)
  assert.ok(harness.scrollHeight() > 4010)
  const before = harness.firstVisible()!
  harness.setWidth(800)
  harness.viewport.handleResize()
  await harness.advance(5)
  assert.equal(harness.scrollHeight(), 4010)
  assert.equal(harness.topOf(before.key), before.top)
})

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
  harness.render()

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

  // 浏览器先按新宽度重排，ResizeObserver 才回调；保住的应是重排前的阅读位置。
  const before = harness.firstVisible()!
  harness.setWidth(400)
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

  harness.setHeight(160)
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
