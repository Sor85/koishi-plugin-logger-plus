/**
 * 日志视口协调。
 *
 * 滚动位置有四个写者：贴底追踪、按锚点复位、按布局粗定位，以及自绘滚动条拖拽。
 * 前三个全部收在这里，由单写者闸门裁决；拖拽不改内容，留在渲染层。
 *
 * 核心是纯 TypeScript：只通过 ViewportHost 读写滚动几何，不引入 Vue、不碰全局的帧调度，
 * 因此测试可以拿字面量对象充当假容器、手动推进帧，在无 DOM 环境下驱动整套滚动行为。
 *
 * 五条不变量（详见 CONSTRAINTS.md）：
 *
 * 1. 同一时刻只有一处改滚动位置：`around` 与 `restore` 执行期间挂起逐帧的高度修正。
 * 2. 实测高度写回会改变占位高度，视口内容随之移动，因此锚点必须在写回之前取。
 * 3. `contentTop` 是布局值，占位只能用内边距；改用位移变换会让换算整段偏掉。
 * 4. 只有容器宽度变化才丢弃实测高度，高度变化不丢。
 * 5. 找不到锚点时不强行恢复，保持当前位置。
 */

import type { ViewportHost } from './viewport-host'
import type { VirtualListWindow } from './virtual-list'
import { createVirtualListLayout } from './virtual-list'

/**
 * 视口内第一条可见日志的稳定标识与相对偏移。
 *
 * 只存 `scrollTop` 在前插内容、容器布局变化、跨页面往返之后都会偏掉，
 * 因此位置一律按「哪条日志 + 它离视口顶部多远」来记。
 */
export interface LogAnchor {
  key: string
  offset: number
}

export interface LogViewportState {
  /** 需要渲染的日志区间与上下占位高度 */
  window: VirtualListWindow
  /** 是否在追踪最新日志 */
  isFollowing: boolean
  /** 是否停在最新日志附近 */
  isViewingLatest: boolean
}

export interface LogViewportOptions {
  host: ViewportHost
  /** 下一帧执行，返回取消函数；生产环境是 requestAnimationFrame */
  schedule(task: () => void): () => void
  /** 等宿主把 DOM 刷新完；生产环境是 Vue 的 nextTick */
  flush(): Promise<void>
  /** 窗口与两项追踪状态一起流出，只在真正变化时触发 */
  onStateChange(state: LogViewportState): void
  /** 拿不到容器几何时用来先备一屏的高度；生产环境是浏览器视口高度 */
  fallbackViewportHeight(): number
  /** 视口上下各多渲染的高度 */
  overscan: number
  /** 取不到实测行高时的估算值 */
  fallbackLineHeight: number
}

export interface LogViewport {
  /** 更新日志清单，已实测高度按标识继续沿用 */
  setItems(keys: string[]): void
  handleScroll(): void
  handleResize(): void
  /** 回到最新日志并恢复追踪 */
  followLatest(): void
  /** 把会前插内容的变更交给它执行：先取锚点 → 执行 change → 等 DOM 刷新 → 按锚点复位 */
  around(change: () => void | Promise<void>): Promise<void>
  /** 取当前暂停位置，供跨页面往返使用 */
  capture(): LogAnchor | undefined
  /** 把视口滚回锚点所在的日志 */
  restore(anchor?: LogAnchor): Promise<void>
  dispose(): void
}

// 停在离底部这个距离之内就算「正在看最新日志」，滚动条不必压到最底
const latestThreshold = 64

export function createLogViewport(options: LogViewportOptions): LogViewport {
  const { host, schedule, flush, onStateChange } = options
  const layout = createVirtualListLayout(options.fallbackLineHeight)

  let logWindow: VirtualListWindow = { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 }
  let isFollowing = true
  let isViewingLatest = true
  let published: LogViewportState | undefined
  let lastScrollTop = 0
  let listWidth = 0
  let pausedAnchor: LogAnchor | undefined
  let cancelFrame: (() => void) | undefined
  let disposed = false
  const pendingFrames = new Set<() => void>()
  // 不变量 1：单写者闸门。大于零表示正有一处在按锚点改滚动位置，
  // 逐帧的高度修正此时必须让路，两处同时改会互相打断
  let writers = 0
  // await 之后闸门可能已重新打开，但旧帧的锚点仍然过期；代次负责作废这类续体。
  let revision = 0

  function isRestoring() {
    return writers > 0
  }

  // 状态去重：窗口四字段与两项追踪状态全等就不再往外抛，
  // 否则「窗口没变」也会变成一次渲染层写入
  function publish() {
    if (disposed) return
    if (published
      && published.window.start === logWindow.start
      && published.window.end === logWindow.end
      && published.window.paddingTop === logWindow.paddingTop
      && published.window.paddingBottom === logWindow.paddingBottom
      && published.isFollowing === isFollowing
      && published.isViewingLatest === isViewingLatest) return
    published = { window: logWindow, isFollowing, isViewingLatest }
    onStateChange(published)
  }

  // 位置没变就不下发：闸门只管「谁能改」，这里再挡掉一次无谓的写入
  function scrollTo(scrollTop: number) {
    if (disposed) return
    const metrics = host.metrics()
    if (!metrics || metrics.scrollTop === scrollTop) return
    host.scrollTo(scrollTop)
  }

  // 取视口内第一条可见日志：它的下沿还没滑出容器顶部就算可见。
  // 容器已离开 DOM 时 metrics() 给不出几何，此时读到的位置不稳定，不能记
  function captureAnchor(): LogAnchor | undefined {
    if (!host.metrics()) return undefined
    const line = host.lines().find(item => item.top + item.height >= 0)
    if (!line) return undefined
    return { key: line.key, offset: line.top }
  }

  // 按「当前相对偏移 - 记录时的相对偏移」把位置挪回去。
  // 不变量 5：锚点那条日志已经不在渲染窗口里时保持当前位置，不强行恢复
  function restoreAnchor(anchor?: LogAnchor) {
    const metrics = host.metrics()
    if (!metrics || !anchor) return false
    const line = host.lines().find(item => item.key === anchor.key)
    if (!line) return false
    scrollTo(metrics.scrollTop + line.top - anchor.offset)
    return true
  }

  // 按当前滚动位置算出要渲染的日志区间。窗口吃的是内容坐标而非滚动位置：
  // 占位容器之前还有「查看更多消息」和顶部内边距，先减掉再交给布局换算
  function syncWindow(overrideOffset?: number) {
    const metrics = host.metrics()
    let scrollOffset: number
    let viewportHeight: number
    if (metrics) {
      scrollOffset = overrideOffset ?? metrics.scrollTop - metrics.contentTop
      viewportHeight = metrics.clientHeight
    } else {
      // 首帧还拿不到滚动容器，先备一屏；追踪最新日志时备的是末尾那一屏
      viewportHeight = options.fallbackViewportHeight()
      scrollOffset = isFollowing ? Math.max(0, layout.totalHeight() - viewportHeight) : 0
    }
    const next = layout.getWindow(scrollOffset, viewportHeight, options.overscan)
    if (next.start === logWindow.start && next.end === logWindow.end
      && next.paddingTop === logWindow.paddingTop && next.paddingBottom === logWindow.paddingBottom) return
    logWindow = next
  }

  function updateViewingLatest() {
    const metrics = host.metrics()
    if (!metrics) return
    isViewingLatest = metrics.scrollTop + metrics.clientHeight + latestThreshold >= metrics.scrollHeight
    lastScrollTop = metrics.scrollTop
  }

  async function scrollToBottom(frameRevision = revision) {
    // 先渲染并测量末尾窗口，再写入最终位置。先滚后换窗会让 DOM 总高度短暂收缩，
    // 浏览器钳制 scrollTop 后发出的 scroll 曾被误判成用户上滚，导致追踪自动暂停。
    for (let round = 0; round < 3; round++) {
      const metrics = host.metrics()
      if (disposed || isRestoring() || frameRevision !== revision || !metrics) return
      syncWindow(Math.max(0, layout.totalHeight() - metrics.clientHeight))
      publish()
      await flush()
      if (disposed || isRestoring() || frameRevision !== revision || !host.metrics()) return
      if (!measureLines()) break
    }
    const metrics = host.metrics()
    if (disposed || isRestoring() || frameRevision !== revision || !metrics) return
    syncWindow(Math.max(0, layout.totalHeight() - metrics.clientHeight))
    publish()
    await flush()
    if (disposed || isRestoring() || frameRevision !== revision) return
    const current = host.metrics()
    if (!current) return
    scrollTo(Math.max(0, current.scrollHeight - current.clientHeight))
    updateViewingLatest()
  }

  // 量窗口内各行的真实高度，返回偏移是否需要重算
  function measureLines() {
    let changed = false
    for (const line of host.lines()) {
      if (layout.measure(line.key, line.height)) changed = true
    }
    return changed
  }

  function setFollowing(value: boolean) {
    if (isFollowing === value) return
    isFollowing = value
    if (value) pausedAnchor = undefined
  }

  // 用户仍停留在页面且处于暂停状态时持续刷新最后稳定位置：
  // 等到失活再取就已经读不到稳定读数了
  function rememberPaused() {
    if (isFollowing) return
    const anchor = captureAnchor()
    if (anchor) pausedAnchor = anchor
  }

  /**
   * 实测高度改变了占位高度，视口内容随之上下移动，因此按锚点把位置挪回去。
   *
   * 不变量 2：锚点由调用方在改动之前取好传进来；追踪最新日志时不需要锚点，重新贴底即可。
   */
  async function settle(anchor: LogAnchor | undefined, frameRevision: number) {
    if (disposed || isRestoring() || frameRevision !== revision || !host.metrics()) return
    if (measureLines()) {
      syncWindow()
      publish()
      await flush()
    }
    // 闸门覆盖整个异步帧，不只是取锚点的那一刻；DOM 刷新也可能让页面失活。
    if (disposed || isRestoring() || frameRevision !== revision || !host.metrics()) return
    if (isFollowing) {
      await scrollToBottom(frameRevision)
    } else if (anchor) {
      restoreAnchor(anchor)
      syncWindow()
    }
    updateViewingLatest()
    rememberPaused()
    publish()
  }

  function scheduleWindow() {
    if (cancelFrame || disposed) return
    cancelFrame = scheduleFrame(async () => {
      cancelFrame = undefined
      if (disposed || isRestoring()) return
      const frameRevision = revision
      // 不变量 1：恢复位置期间不取锚点也不改位置，让出这一帧
      const anchor = !isFollowing ? captureAnchor() : undefined
      syncWindow()
      publish()
      await flush()
      if (disposed) return
      await settle(anchor, frameRevision)
    })
  }

  function scheduleFrame(task: () => void, onCancel?: () => void) {
    if (disposed) {
      onCancel?.()
      return () => {}
    }
    const cancel = () => {
      cancelScheduled()
      pendingFrames.delete(cancel)
      onCancel?.()
    }
    const cancelScheduled = schedule(() => {
      pendingFrames.delete(cancel)
      if (!disposed) task()
    })
    pendingFrames.add(cancel)
    return cancel
  }

  function nextFrame() {
    // 取消 RAF 也必须唤醒等待者，否则 around 的 Promise 会永久悬挂。
    return new Promise<void>(resolve => scheduleFrame(resolve, resolve))
  }

  /**
   * 把视口滚回锚点所在的日志。
   *
   * 锚点那条日志可能落在渲染窗口之外，此时 DOM 里根本没有它，只能按布局偏移换算位置；
   * 而未量过的行按估算值顶位，算出来的偏移必然是错的。因此先把窗口换到目标附近、
   * 量过高度再重算，反复逼近，**整个过程不写滚动位置**：写一次就是用户看得见的一次跳动，
   * 「先跳到一处再弹到另一处」正是这么来的。收敛之后只落一次。
   */
  const restoreRounds = 3

  async function restore(anchor?: LogAnchor) {
    const metrics = host.metrics()
    if (disposed || !metrics || !anchor || layout.indexOf(anchor.key) < 0) return
    writers++
    const restoreRevision = ++revision
    try {
      // 锚点按标识重新定位；刷新期间清单可能变化，不能沿用旧下标。
      const targetOffset = () => layout.offsetOf(layout.indexOf(anchor.key)) - anchor.offset
      for (let round = 0; round < restoreRounds; round++) {
        syncWindow(targetOffset())
        publish()
        await flush()
        if (disposed || restoreRevision !== revision || !host.metrics() || layout.indexOf(anchor.key) < 0) return
        if (!measureLines()) break
      }
      // 最后一轮测量也会改上下占位。先提交占位，再只按实际矩形写一次，
      // 不能先写布局估算位置又用尚未刷新的矩形精调，否则仍会二次跳动。
      syncWindow(targetOffset())
      publish()
      await flush()
      if (disposed || restoreRevision !== revision || !host.metrics() || layout.indexOf(anchor.key) < 0) return
      restoreAnchor(anchor)
      syncWindow()
      updateViewingLatest()
      rememberPaused()
      publish()
    } finally {
      writers--
    }
  }

  return {
    setItems(keys) {
      if (disposed) return
      layout.setItems(keys)
      syncWindow()
      publish()
      scheduleWindow()
    },
    handleScroll() {
      if (disposed) return
      const metrics = host.metrics()
      if (!metrics) return
      const previousScrollTop = lastScrollTop
      // 模块刚写入的位置会异步产生 scroll，不能把自己的事件当成用户恢复追踪。
      if (metrics.scrollTop === previousScrollTop) return
      revision++
      updateViewingLatest()
      // 用户往上滚就是在读日志，转入暂停；滚回底部再恢复追踪
      if (metrics.scrollTop < previousScrollTop) {
        setFollowing(false)
      } else if (isViewingLatest) {
        setFollowing(true)
      }
      // 滚动当帧先按已有高度换出新窗口，避免等到下一帧才补上内容
      syncWindow()
      rememberPaused()
      publish()
      scheduleWindow()
    },
    handleResize() {
      if (disposed) return
      const metrics = host.metrics()
      if (!metrics) return
      layout.setEstimatedHeight(host.estimatedLineHeight())
      // 不变量 4：宽度一变换行结果全部失效，清空重量；高度变化不清
      if (metrics.clientWidth !== listWidth) {
        listWidth = metrics.clientWidth
        // 不变量 2：丢弃实测高度会让占位整段回落到估算值，锚点必须在此之前取。
        // 回落之后滚动位置指向的内容坐标已经变了，锚点那条日志往往连渲染窗口都出不来，
        // 因此走完整的两阶段恢复，而不是指望逐帧的高度修正把它找回来
        // ResizeObserver 执行前浏览器已经重排，当前首行可能变了甚至整窗滑出视口；
        // 优先用重排前持续保存的稳定锚点，不能把新矩形当成原阅读位置。
        const anchor = isFollowing ? undefined : pausedAnchor ?? captureAnchor()
        layout.forgetHeights()
        if (anchor) {
          void restore(anchor).then(scheduleWindow)
          return
        }
      }
      scheduleWindow()
    },
    followLatest() {
      if (disposed) return
      const followRevision = ++revision
      setFollowing(true)
      isViewingLatest = true
      publish()
      void flush().then(() => {
        if (disposed) return
        scheduleFrame(async () => {
          if (disposed) return
          await scrollToBottom(followRevision)
          publish()
          scheduleWindow()
        })
      })
    },
    async around(change) {
      if (disposed) return
      // 不变量 2：锚点必须在内容变更之前取，否则读到的是移动后的位置，修正等于没做
      const anchor = captureAnchor()
      // change 可以跨越多帧，闸门必须在调用它之前关闭，异常时也要释放。
      writers++
      revision++
      try {
        await change()
        if (disposed) return
        await flush()
        if (disposed) return
        await nextFrame()
        if (disposed) return
        await restore(anchor)
      } finally {
        writers--
      }
    },
    capture() {
      rememberPaused()
      return pausedAnchor
    },
    restore(anchor) {
      return restore(anchor ?? pausedAnchor)
    },
    dispose() {
      disposed = true
      revision++
      for (const cancel of pendingFrames) cancel()
      cancelFrame = undefined
    },
  }
}
