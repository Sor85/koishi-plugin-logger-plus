import test from 'node:test'
import assert from 'node:assert/strict'
import type { LogViewportState } from '../client/log-viewport'
import { createLogViewport } from '../client/log-viewport'
import type { ViewportHost, ViewportLine } from '../client/viewport-host'
import type { VirtualListWindow } from '../client/virtual-list'
import { scrollbarGeometry } from '../client/scrollbar-geometry'
import { createLogHeightEstimator } from '../client/log-height-estimator'
import type Logger from 'reggol'

interface HarnessOptions {
  keys: string[]
  /** 行的真实渲染高度；正文换行与跨重启的分隔行会让它偏离估算值，宽度变化也会改写它 */
  height?(key: string, width: number): number
  estimate?(key: string, width: number): number
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
  // 渲染层在提交 DOM 之前调用 setItems（Vue 的 pre-flush watcher），因此新清单先进视口核心，
  // 再随下一次渲染进入 DOM。假容器必须照这个顺序来，否则「变更前取锚点」根本测不出来
  let pendingKeys = keys
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
    keys = pendingKeys
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
    keys: () => pendingKeys,
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
      pendingKeys = [...next]
      viewport.setItems(pendingKeys, options.estimate && pendingKeys.map(key => options.estimate!(key, clientWidth)))
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
      viewport.setItems(pendingKeys, options.estimate && pendingKeys.map(key => options.estimate!(key, clientWidth)))
      viewport.handleResize()
      await advance(4)
    },
  }
}

test('恢复等待 DOM 刷新时滚轮已经移动但 scroll 事件尚未送达，不得拉回旧锚点', async () => {
  let onFlush: (() => void) | undefined
  const harness = createHarness({ keys: keysOf(1000), flush: async () => onFlush?.() })
  await harness.mount()
  harness.setScrollTop(10000)
  harness.viewport.handleScroll()
  await harness.advance(4)
  await harness.run(harness.viewport.around(() => harness.setItems(keysOf(1200))))

  for (let step = 0; step < 10; step++) {
    harness.setScrollTop(harness.scrollTop() - 40)
    harness.viewport.handleScroll()
    const expected = harness.scrollTop() - 60
    onFlush = () => {
      onFlush = undefined
      // 浏览器先更新滚动位置，再在后续事件循环派发 scroll。
      harness.setScrollTop(expected)
    }
    await harness.advance(2)
    assert.equal(harness.scrollTop(), expected)
    harness.viewport.handleScroll()
    await harness.advance(3)
    assert.equal(harness.scrollTop(), expected)
  }
})

test('最新日志不足一屏时加载历史应暂停追踪，滑到顶部后追加不能拉回底部', async () => {
  const harness = createHarness({ keys: keysOf(3, 200), height: () => 40 })
  await harness.mount()
  assert.equal(harness.state().isFollowing, true)
  await harness.run(harness.viewport.around(() => harness.setItems(keysOf(203))))
  assert.equal(harness.state().isFollowing, false)
  harness.setScrollTop(0)
  harness.viewport.handleScroll()
  await harness.advance(5)
  harness.setItems(keysOf(204))
  await harness.advance(5)
  assert.equal(harness.scrollTop(), 0)
  assert.equal(harness.state().window.start, 0)
  assert.equal(harness.state().isFollowing, false)
})

test('快速上滚越过旧窗口后不得把屏外日志记成阅读锚点', async () => {
  const harness = createHarness({ keys: keysOf(1000), height: () => 1600, scrollEvents: true })
  await harness.mount()
  await harness.advance(5)
  harness.setScrollTop(0)
  harness.viewport.handleScroll()
  assert.equal(harness.viewport.capture(), undefined)
  await harness.advance(5)
  assert.equal(harness.scrollTop(), 0)
  assert.equal(harness.state().window.start, 0)
  assert.equal(harness.topOf('0'), 10)
  assert.equal(harness.state().isFollowing, false)
})

test('加载长篇历史后快速滑到顶部，必须显示最早记录而非恢复屏外旧窗口', async () => {
  const harness = createHarness({
    keys: keysOf(100, 200),
    height: key => Number(key) < 200 ? 1600 : 20,
    scrollEvents: true,
  })
  await harness.mount()
  harness.setScrollTop(0)
  harness.viewport.handleScroll()
  await harness.advance(5)
  await harness.run(harness.viewport.around(() => harness.setItems(keysOf(300))))
  harness.setScrollTop(3000)
  harness.viewport.handleScroll()
  await harness.advance(5)

  for (let round = 0; round < 3; round++) {
    harness.setScrollTop(0)
    harness.viewport.handleScroll()
    await harness.advance(5)
    assert.equal(harness.scrollTop(), 0)
    assert.equal(harness.state().window.start, 0)
    assert.equal(harness.topOf('0'), 10)
    assert.equal(harness.state().isFollowing, false)
  }
})

test('前插已落地而请求未结束时立刻补偿位置，且只写一次', async () => {
  // 闸门只覆盖「内容已改、位置还没修」的那一段。内容一旦前插完毕，补偿不必等请求结束：
  // 关着闸门等下去，渲染窗口会冻在请求开始时的位置，用户继续滚只会滚进空白
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
  assert.equal(harness.topOf(before.key), before.top)
  release()
  await harness.run(operation)

  assert.equal(intermediateCalls, 1)
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

  const before = harness.firstVisible()!
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
  // 旧帧拿的是前插之前的布局，必须让出写入权由新帧重取锚点；
  // 写了几次不足以区分新旧，落点才能——旧帧写出来的位置一定是错的
  assert.equal(calls, 1)
  assert.equal(harness.topOf(before.key), before.top)
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

test('加载期间回到底部的意图在闸门释放后不会丢失', async () => {
  const harness = createHarness({ keys: keysOf(100) })
  await harness.mount()
  harness.setScrollTop(300)
  harness.viewport.handleScroll()
  await harness.advance(2)
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const operation = harness.viewport.around(async () => {
    await wait
    harness.setItems(keysOf(120))
  })
  harness.viewport.followLatest()
  await harness.advance(2)
  const immediateTop = harness.scrollTop()
  const immediateBottom = harness.scrollHeight() - 200
  release()
  await harness.run(operation)
  assert.equal(immediateTop, immediateBottom)
  assert.equal(harness.state().isFollowing, true)
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 200)
})

test('等待历史日志期间的新阅读位置取代旧锚点，前插后仍保持新位置', async () => {
  const harness = createHarness({ keys: keysOf(200, 100) })
  await harness.mount()
  harness.setScrollTop(300)
  harness.viewport.handleScroll()
  await harness.advance(2)
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const operation = harness.viewport.around(async () => {
    await wait
    harness.setItems([...keysOf(20, 80), ...harness.keys()])
  })
  harness.setScrollTop(1000)
  harness.viewport.handleScroll()
  await harness.advance(2)
  const latest = harness.firstVisible()!
  release()
  await harness.run(operation)
  assert.equal(harness.topOf(latest.key), latest.top)
  assert.equal(harness.state().isFollowing, false)
})

test('前插等待期间调宽立即保位，前插落地后再保一次', async () => {
  // 调宽会当场重排，实测行高全部作废：这时的保位必须立刻做，不能押后到请求回来。
  // 两次事件之间可能隔着整段网络等待，合并成一次写入只会让用户盯着错位的画面等
  const harness = createHarness({ keys: keysOf(200, 100), height: (_key, width) => width < 500 ? 60 : 20 })
  await harness.mount()
  harness.setScrollTop(1000)
  harness.viewport.handleScroll()
  await harness.advance(2)
  const before = harness.firstVisible()!
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const operation = harness.viewport.around(async () => {
    await wait
    harness.setItems([...keysOf(20, 80), ...harness.keys()])
  })
  harness.resetScrollCalls()
  harness.setWidth(400)
  harness.viewport.handleResize()
  await harness.advance(2)
  const intermediate = harness.scrollCalls()
  assert.equal(harness.topOf(before.key), before.top)
  release()
  await harness.run(operation)
  assert.equal(intermediate, 1)
  assert.equal(harness.topOf(before.key), before.top)
  assert.equal(harness.scrollCalls(), 2)
})

test('空列表通过 around 首次加载后仍会测量并贴底', async () => {
  const harness = createHarness({ keys: [], height: () => 60 })
  await harness.mount()
  await harness.run(harness.viewport.around(() => { harness.setItems(keysOf(100)) }))
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 200)
  assert.equal(harness.state().isViewingLatest, true)
})

test('闸门期间追加后变更失败，也会补做追踪而不依赖下一条日志', async () => {
  const harness = createHarness({ keys: keysOf(100) })
  await harness.mount()
  let fail!: () => void
  const pending = new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('读取失败')) })
  const operation = harness.viewport.around(() => pending)
  const rejection = assert.rejects(operation, /读取失败/)
  harness.setItems(keysOf(120))
  await harness.advance(2)
  fail()
  await rejection
  await harness.advance(3)
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 200)
  assert.equal(harness.state().isViewingLatest, true)
})

test('等待期间调宽后加载失败，仍补做调宽保位', async () => {
  const harness = createHarness({ keys: keysOf(200), height: (_key, width) => width < 500 ? 60 : 20 })
  await harness.mount()
  harness.setScrollTop(1000)
  harness.viewport.handleScroll()
  await harness.advance(2)
  const before = harness.firstVisible()!
  let fail!: () => void
  const pending = new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('读取失败')) })
  const operation = harness.viewport.around(() => pending)
  const rejection = assert.rejects(operation, /读取失败/)
  harness.setWidth(400)
  harness.viewport.handleResize()
  await harness.advance(2)
  fail()
  await rejection
  await harness.advance(4)
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

test('十万条多行日志连续上滚时，换窗不能放大滚轮位移', async () => {
  const harness = createHarness({
    keys: keysOf(100_000),
    height: key => Number(key) % 5 === 0 ? 1600 : 20,
    clientHeight: 800,
    scrollEvents: true,
  })
  await harness.mount()
  await harness.advance(6)

  for (let step = 0; step < 240; step++) {
    harness.setScrollTop(harness.scrollTop() - 100)
    // 先读滚轮移动后的真实行位置，不能用换窗后的矩形作期望值。
    const before = harness.firstVisible()!
    harness.viewport.handleScroll()
    await harness.advance(5)
    assert.equal(harness.topOf(before.key), before.top, `第 ${step + 1} 次上滚发生额外位移`)
    assert.equal(harness.state().isFollowing, false)
  }

  for (let step = 0; step < 120; step++) {
    harness.setScrollTop(harness.scrollTop() + 100)
    const before = harness.firstVisible()!
    harness.viewport.handleScroll()
    await harness.advance(5)
    assert.equal(harness.topOf(before.key), before.top, `第 ${step + 1} 次下滚发生额外位移`)
  }
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

// 大段 JSON 日志：每 7 条里有一条上千像素高，未实测前按估算值顶位，差出近 1400 像素
function tallHeight(key: string) {
  return Number(key) % 7 === 0 ? 1400 : 20
}

test('新日志与用户上滚交错到来时，换窗不得把未实测长日志的高度差变成跳动', async () => {
  // 单独上滚或单独来日志都不出问题，两者交错才暴露：滚动把换窗押后到下一帧的锚点保护里，
  // setItems 却按新位置先发布了窗口，新进窗口的长日志一渲染就把视口顶下去一大截
  const harness = createHarness({
    keys: keysOf(2000),
    height: tallHeight,
    clientHeight: 800,
    scrollEvents: true,
  })
  await harness.mount()
  await harness.advance(6)
  harness.setScrollTop(harness.scrollTop() - 400)
  harness.viewport.handleScroll()
  await harness.advance(4)
  assert.equal(harness.state().isFollowing, false)

  let total = 2000
  for (let step = 0; step < 120; step++) {
    harness.setScrollTop(harness.scrollTop() - 120)
    const before = harness.firstVisible()!
    harness.viewport.handleScroll()
    total += 2
    harness.setItems(keysOf(total))
    await harness.advance(3)
    assert.equal(harness.topOf(before.key), before.top, `第 ${step + 1} 次上滚发生额外位移`)
    assert.equal(harness.state().isFollowing, false)
  }
})

test('实时缓冲写满后每来一条就淘汰最早一条，暂停浏览的位置仍不动', async () => {
  // 清单前端被削，窗口下标没变、里面的记录却整体换人：渲染层提交 DOM 之前就要取好锚点，
  // 等到下一帧再取只会把已经发生的位移固化下来
  const limit = 1000
  let next = limit
  const harness = createHarness({
    keys: keysOf(limit),
    height: tallHeight,
    clientHeight: 800,
    scrollEvents: true,
  })
  await harness.mount()
  await harness.advance(6)
  harness.setScrollTop(Math.max(0, harness.scrollTop() - 4000))
  harness.viewport.handleScroll()
  await harness.advance(6)
  assert.equal(harness.state().isFollowing, false)

  for (let step = 0; step < 60; step++) {
    const before = harness.firstVisible()!
    harness.setItems([...harness.keys().slice(1), `${next++}`])
    await harness.advance(3)
    assert.equal(harness.topOf(before.key), before.top, `第 ${step + 1} 条新日志把位置挪走了`)
  }
})

test('等历史日志期间渲染窗口继续跟随滚动，加载完成不拉回旧位置', async () => {
  // 读一页历史要跨很多帧。闸门若覆盖整段等待，渲染窗口就冻在请求开始的位置：
  // 用户继续上滚只会滚进一片空白，请求回来还会被拉回点击时的锚点
  const harness = createHarness({
    keys: keysOf(2000),
    height: tallHeight,
    clientHeight: 800,
    scrollEvents: true,
  })
  await harness.mount()
  await harness.advance(6)
  harness.setScrollTop(harness.scrollTop() - 3000)
  harness.viewport.handleScroll()
  await harness.advance(6)

  let total = 2000
  let resolveChange!: () => void
  const pending = new Promise<void>(resolve => { resolveChange = resolve })
  const operation = harness.viewport.around(() => pending.then(() => {
    harness.setItems([...keysOf(200, 100000), ...harness.keys()])
  }))

  const starts = new Set<number>()
  for (let step = 0; step < 20; step++) {
    harness.setScrollTop(harness.scrollTop() - 200)
    harness.viewport.handleScroll()
    total += 2
    harness.setItems(keysOf(total))
    await harness.advance(2)
    assert.ok(harness.firstVisible(), `第 ${step + 1} 次滚动后视口内没有已渲染的日志`)
    starts.add(harness.state().window.start)
  }
  assert.ok(starts.size > 1, '加载期间渲染窗口冻结，没有跟随用户滚动')

  const reading = harness.firstVisible()!
  resolveChange()
  await harness.run(operation)
  assert.equal(harness.topOf(reading.key), reading.top, '加载完成后把用户拉回了旧位置')
})

test('滚动条大跳转叠加新日志不产生额外位移', async () => {
  const harness = createHarness({
    keys: keysOf(3000),
    height: tallHeight,
    clientHeight: 800,
    scrollEvents: true,
  })
  await harness.mount()
  await harness.advance(6)

  let total = 3000
  for (let step = 0; step < 40; step++) {
    harness.setScrollTop(Math.max(0, harness.scrollTop() - 4000))
    const before = harness.firstVisible()!
    harness.viewport.handleScroll()
    total += 3
    harness.setItems(keysOf(total))
    await harness.advance(4)
    const after = harness.topOf(before.key)
    if (after !== undefined) assert.equal(after, before.top, `第 ${step + 1} 次跳转发生额外位移`)
  }
})

function thumb(harness: ReturnType<typeof createHarness>) {
  return scrollbarGeometry(harness.viewport.scrollbar.metrics()!, 784)
}

for (const mixed of [false, true]) {
  test(`加载历史后连续上滚至顶再下滚到底，正文与滑块方向一致（混合行高=${mixed}）`, async () => {
    const harness = createHarness({
      keys: keysOf(2000),
      height: key => Number(key) < 0 ? (mixed && Number(key) % 7 ? 20 : 300) : 20,
      clientHeight: 800,
      scrollEvents: true,
    })
    await harness.mount()
    harness.setScrollTop(0)
    harness.viewport.handleScroll()
    await harness.advance(6)
    await harness.run(harness.viewport.around(() => harness.setItems([...keysOf(300, -300), ...harness.keys()])))

    // 用实际绘制的 top 断言，不只检查内部 progress；长短行交替还会改变滑块长度。
    let previous = thumb(harness).top
    for (let step = 0; step < 600 && harness.scrollTop() > 0; step++) {
      harness.setScrollTop(Math.max(0, harness.scrollTop() - 200))
      const before = harness.firstVisible()!
      harness.viewport.handleScroll()
      await harness.advance(4)
      assert.equal(harness.topOf(before.key), before.top, `第 ${step} 步正文额外移动`)
      const current = thumb(harness).top
      assert.ok(current <= previous + 1e-6, `第 ${step} 步滑块从 ${previous} 回退到 ${current}`)
      previous = current
    }
    assert.equal(harness.scrollTop(), 0)
    assert.equal(thumb(harness).top, 0)

    for (let step = 0; step < 1000 && thumb(harness).progress < 1 - 1e-9; step++) {
      harness.setScrollTop(harness.scrollTop() + 200)
      harness.viewport.handleScroll()
      await harness.advance(4)
      const current = thumb(harness).top
      assert.ok(current >= previous - 1e-6, `第 ${step} 步下滚时滑块倒退`)
      previous = current
    }
    assert.equal(thumb(harness).progress, 1)
  })
}

test('滑块拖拽到未测量的长日志区域，正反映射一致且支持顶底端点', async () => {
  const harness = createHarness({
    keys: keysOf(3000),
    height: key => Number(key) % 7 ? 20 : 1400,
    clientHeight: 800,
    scrollEvents: true,
  })
  await harness.mount()
  for (const progress of [0.8, 0.5, 0.1, 0, 0.6, 1]) {
    harness.viewport.scrollbar.scrollTo(progress)
    await harness.advance(8)
    assert.ok(Math.abs(thumb(harness).progress - progress) < 1e-5,
      `目标 ${progress}，实际 ${thumb(harness).progress}`)
  }
  assert.equal(harness.state().isFollowing, true)
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 800)
})

test('在长短日志区域往返及重新测量后，滑块长度保持一致', async () => {
  // 总量不能大到始终触发 28px 下限，否则会掩盖可见记录数造成的尺寸变化。
  const harness = createHarness({ keys: keysOf(100), height: key => Number(key) < 50 ? 20 : 2000, clientHeight: 800 })
  await harness.mount()
  const height = thumb(harness).height
  assert.ok(height > 28)
  for (const progress of [0, 0.1, 0.5, 0.8, 1, 0.2]) {
    harness.viewport.scrollbar.scrollTo(progress)
    await harness.advance(8)
    assert.equal(thumb(harness).height, height, `位置 ${progress} 改变了滑块长度`)
    assert.ok(Math.abs(thumb(harness).progress - progress) < 1e-5)
  }
  harness.setWidth(400)
  harness.viewport.handleResize()
  await harness.advance(8)
  assert.equal(thumb(harness).height, height)
})

test('文本预估使相同像素滚动在长短日志区产生接近一致的滑块位移', async () => {
  const records: Logger.Record[] = Array.from({ length: 300 }, (_, id) => ({
    timestamp: id, id, name: 'x', type: 'info',
    content: id < 100 ? 'hello' : Array(15).fill('hello').join('\n'),
  }))
  const estimator = createLogHeightEstimator(async () => {})
  const estimates = (await estimator.prepare(records, { columns: 80, lineHeight: 20, separatorHeight: 16 }))!
  assert.equal(estimates[0], 20)
  assert.equal(estimates[100], 300)
  const harness = createHarness({
    keys: keysOf(300),
    height: key => Number(key) < 100 ? 20 : 300,
    estimate: key => estimates[Number(key)],
    clientHeight: 800,
  })
  await harness.mount()
  const thumbHeight = thumb(harness).height
  async function movement(from: number) {
    harness.setScrollTop(from)
    harness.viewport.handleScroll()
    await harness.advance(6)
    const before = thumb(harness).top
    harness.setScrollTop(harness.scrollTop() + 200)
    harness.viewport.handleScroll()
    await harness.advance(6)
    assert.equal(thumb(harness).height, thumbHeight)
    return thumb(harness).top - before
  }
  const short = await movement(500)
  const long = await movement(5000)
  assert.ok(short > 0)
  assert.ok(Math.abs(short - long) < 1e-6, `短日志移动 ${short}，长日志移动 ${long}`)
  for (const progress of [0, 0.15, 0.5, 1]) {
    harness.viewport.scrollbar.scrollTo(progress)
    await harness.advance(8)
    assert.ok(Math.abs(thumb(harness).progress - progress) < 1e-5)
  }
})

test('预估与实测存在误差时仍不回退，且滑块尺寸不受滚动影响', async () => {
  const harness = createHarness({
    keys: keysOf(1000),
    height: key => Number(key) % 7 ? 20 : 1400,
    estimate: key => Number(key) % 7 ? 20 : 1200,
    clientHeight: 800,
    scrollEvents: true,
  })
  await harness.mount()
  const height = thumb(harness).height
  let previous = thumb(harness).top
  for (let step = 0; step < 250; step++) {
    harness.setScrollTop(harness.scrollTop() - 150)
    const anchor = harness.firstVisible()!
    harness.viewport.handleScroll()
    await harness.advance(4)
    assert.equal(harness.topOf(anchor.key), anchor.top)
    assert.equal(thumb(harness).height, height)
    const top = thumb(harness).top
    assert.ok(top <= previous + 1e-6)
    previous = top
  }
})

test('预估清单提交的贴底帧尚未结束时滚到顶部，迟到的 scroll 不能让旧帧拉回底部', async () => {
  let onFlush: (() => void) | undefined
  const harness = createHarness({
    keys: keysOf(1000), height: tallHeight, estimate: () => 200,
    clientHeight: 800, scrollEvents: true, flush: async () => onFlush?.(),
  })
  await harness.mount()
  assert.equal(harness.state().isFollowing, true)
  harness.setItems(keysOf(1010))
  onFlush = () => {
    onFlush = undefined
    // 浏览器先改变 scrollTop，scroll 事件在后续事件循环才送达。
    harness.setScrollTop(0)
  }
  await harness.advance(5)
  harness.viewport.handleScroll()
  await harness.advance(5)
  assert.equal(harness.scrollTop(), 0)
  assert.equal(harness.state().window.start, 0)
  assert.equal(harness.state().isFollowing, false)
})

test('先滚到顶部但 scroll 尚未送达时提交新预估，此后连续刷新不能重新贴底', async () => {
  const harness = createHarness({ keys: keysOf(1000), height: tallHeight, estimate: () => 200, clientHeight: 800 })
  await harness.mount()
  harness.setScrollTop(0)
  harness.setItems(keysOf(1010))
  await harness.advance(8)
  assert.equal(harness.scrollTop(), 0)
  assert.equal(harness.state().isFollowing, false)
  harness.viewport.handleScroll()
  for (let step = 0; step < 20; step++) {
    harness.setItems(keysOf(1011 + step))
    await harness.advance(3)
    assert.equal(harness.scrollTop(), 0)
    assert.equal(harness.state().window.start, 0)
    assert.equal(harness.state().isFollowing, false)
  }
})

for (const boundary of [2, 3, 4]) {
  test(`自动贴底的第 ${boundary} 个 DOM 刷新边界发生未派发的上滚，不能覆盖用户位置`, async () => {
    let flushes = 0
    let active = false
    let moved = false
    const harness = createHarness({
      keys: keysOf(1000), height: tallHeight, estimate: () => 200, clientHeight: 800,
      flush: async () => {
        if (active && ++flushes === boundary) {
          moved = true
          harness.setScrollTop(0)
        }
      },
    })
    await harness.mount()
    active = true
    harness.setItems(keysOf(1010))
    await harness.advance(10)
    assert.equal(moved, true, '必须实际经过被测试的异步边界')
    assert.equal(harness.scrollTop(), 0)
    assert.equal(harness.state().isFollowing, false)
  })
}

test('预估提交与自绘滑块拖顶交错时，旧自动贴底帧不能夺回控制权', async () => {
  let onFlush: (() => void) | undefined
  const harness = createHarness({
    keys: keysOf(1000), height: tallHeight, estimate: () => 200, clientHeight: 800,
    flush: async () => onFlush?.(),
  })
  await harness.mount()
  harness.setItems(keysOf(1010))
  onFlush = () => {
    onFlush = undefined
    harness.viewport.scrollbar.scrollTo(0)
  }
  await harness.advance(10)
  assert.equal(harness.scrollTop(), 0)
  assert.equal(thumb(harness).progress, 0)
  assert.equal(harness.state().isFollowing, false)
})

test('用户主动点击回底优先于点击前未派发的上滚，但不能压过点击后的上滚', async () => {
  let onFlush: (() => void) | undefined
  const harness = createHarness({ keys: keysOf(1000), flush: async () => onFlush?.() })
  await harness.mount()
  harness.setScrollTop(0)
  harness.viewport.followLatest()
  await harness.advance(8)
  assert.equal(harness.scrollTop(), harness.scrollHeight() - 200)
  assert.equal(harness.state().isFollowing, true)
  harness.viewport.followLatest()
  onFlush = () => {
    onFlush = undefined
    harness.setScrollTop(0)
  }
  await harness.advance(8)
  assert.equal(harness.scrollTop(), 0)
  assert.equal(harness.state().isFollowing, false)
})

test('原生位置钳制不能被迟到滚动检测误判成暂停或恢复追踪', async () => {
  for (const following of [true, false]) {
    const harness = createHarness({ keys: keysOf(1000) })
    await harness.mount()
    if (!following) {
      harness.setScrollTop(1000)
      harness.viewport.handleScroll()
      await harness.advance(4)
    }
    harness.setHeight(harness.scrollHeight() - 500)
    harness.setScrollTop(500)
    harness.viewport.handleScroll()
    assert.equal(harness.state().isFollowing, following)
    harness.viewport.handleResize()
    await harness.advance(8)
    assert.equal(harness.state().isFollowing, following)
  }
})

test('换窗测量未完成时不发布临时滑块几何', async () => {
  let held: Promise<void> | undefined
  const harness = createHarness({ keys: keysOf(3000), height: tallHeight, clientHeight: 800, flush: () => held ?? Promise.resolve() })
  await harness.mount()
  const before = harness.viewport.scrollbar.metrics()
  let resume!: () => void
  held = new Promise<void>(resolve => { resume = resolve })
  harness.viewport.scrollbar.scrollTo(0.25)
  await harness.advance(2)
  assert.deepEqual(harness.viewport.scrollbar.metrics(), before)
  held = undefined
  resume()
  await harness.advance(8)
  assert.ok(Math.abs(thumb(harness).progress - 0.25) < 1e-5)
})

test('连续拖拽以最后一次为准，销毁后停止发布滑块状态', async () => {
  const harness = createHarness({ keys: keysOf(3000), height: tallHeight, clientHeight: 800 })
  await harness.mount()
  let changes = 0
  const unsubscribe = harness.viewport.scrollbar.subscribe(() => changes++)
  for (const progress of [0.8, 0.6, 0.4, 0.2]) harness.viewport.scrollbar.scrollTo(progress)
  await harness.advance(8)
  assert.ok(Math.abs(thumb(harness).progress - 0.2) < 1e-5)
  assert.ok(changes > 0)
  unsubscribe()
  const previous = changes
  harness.viewport.scrollbar.scrollTo(0.5)
  harness.viewport.dispose()
  await harness.advance(8)
  assert.equal(changes, previous)
  assert.equal(harness.viewport.scrollbar.metrics(), undefined)
})
