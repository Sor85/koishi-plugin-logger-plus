/**
 * 日志视口协调。
 *
 * 贴底追踪、按锚点复位与自绘滚动条拖拽都在这里协调，由写入闸门与代次裁决。
 * 渲染层只处理指针与滑块绘制，不再绕过核心直接写日志容器的 scrollTop。
 *
 * 核心是纯 TypeScript：只通过 ViewportHost 读写滚动几何，不引入 Vue、不碰全局的帧调度，
 * 因此测试可以拿字面量对象充当假容器、手动推进帧，在无 DOM 环境下驱动整套滚动行为。
 *
 * 六条不变量（详见 CONSTRAINTS.md）：
 *
 * 1. 同一时刻只有一处改滚动位置：按锚点复位期间挂起逐帧的高度修正。闸门只覆盖真正在写位置的
 *    那一段，不覆盖等待网络的那一段——关着闸门等请求会把渲染窗口冻在原地。
 * 2. 实测高度写回会改变占位高度，视口内容随之移动，因此锚点必须在写回之前取。
 * 3. `contentTop` 是布局值，占位只能用内边距；改用位移变换会让换算整段偏掉。
 * 4. 只有容器宽度变化才丢弃实测高度，高度变化不丢。
 * 5. 找不到锚点时不强行恢复，保持当前位置。
 * 6. 清单变化本身会移动视口内容，因此锚点要在渲染层提交 DOM 之前（即 `setItems` 当时）取，
 *    不能等到下一帧——那时视口已经跳过一次了。
 */

import type { ViewportHost } from './viewport-host'
import type { VirtualListWindow } from './virtual-list'
import { createVirtualListLayout } from './virtual-list'
import { logScrollbarMetrics, logScrollOffset } from './log-scrollbar'
import type { ScrollbarMetrics, ScrollbarSource } from './scrollbar-geometry'

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
  /** 自绘滑块的记录坐标与拖拽入口，不使用正在变化的 DOM 总高度比例 */
  scrollbar: ScrollbarSource
  /** 更新日志清单，已实测高度按标识继续沿用；须在渲染层提交 DOM 之前调用 */
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

/**
 * 清单变更前记下的阅读位置。
 *
 * 只存锚点不够：取锚点与真正复位之间隔着至少一帧，这期间用户可能又滚了一段。
 * 连同当时的滚动位置一起记，复位时按「现在滚到哪 - 当时滚到哪」把目标偏移平移过去，
 * 既撤掉清单变化造成的位移，又保留用户自己滚出来的位移。
 */
interface QueuedAnchor {
  anchor: LogAnchor
  scrollTop: number
}

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
  let queuedAnchor: QueuedAnchor | undefined
  let cancelFrame: (() => void) | undefined
  let windowPending = false
  let resizePending = false
  let disposed = false
  const pendingFrames = new Set<() => void>()
  // 不变量 1：单写者闸门。大于零表示正有一处在按锚点改滚动位置，
  // 逐帧的高度修正此时必须让路，两处同时改会互相打断
  let writers = 0
  // await 之后闸门可能已重新打开，但旧帧的锚点仍然过期；代次负责作废这类续体。
  let revision = 0
  // 用户意图代次：只有用户滚动与显式回底会推进它，内部换窗与测量补偿不算。
  // 读一页历史要跨很多帧，其间到底是「用户自己接管了位置」还是「只是逐帧补偿跑过几轮」，
  // 只能靠它分辨；revision 被内部补偿频繁推进，判不出用户意图。
  let intent = 0
  let scrollbarSnapshot: ScrollbarMetrics | undefined
  const scrollbarListeners = new Set<() => void>()

  function updateScrollbar() {
    if (disposed || isRestoring() || queuedAnchor) return
    const metrics = host.metrics()
    if (!metrics) return
    scrollbarSnapshot = logScrollbarMetrics(layout, metrics)
    for (const listener of scrollbarListeners) listener()
  }

  function isRestoring() {
    return writers > 0
  }

  function releaseWriter() {
    writers--
    updateScrollbar()
    if (!isRestoring() && windowPending) scheduleWindow()
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
    const metrics = host.metrics()
    if (!metrics) return undefined
    // 快速滚动可越过整个旧窗口；屏外行不是阅读锚点，恢复它会把用户拉回旧内容。
    const line = host.lines().find(item => item.top < metrics.clientHeight && item.top + item.height >= 0)
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

  /**
   * 不变量 6：清单变更之前先把阅读位置留下来。
   *
   * 渲染层在提交 DOM 之前调用 `setItems`，此刻读到的还是变更前的真实位置。等到下一帧再取就晚了：
   * 实时缓冲写满之后每来一条新日志就从头部淘汰最早一条，窗口下标没变、里面的内容却整体前移，
   * 视口已经先跳过一次，再取锚点只会把这次跳动固化下来。
   *
   * 闸门关着时不排队：位置归闸门持有者负责，排一个它看不见的锚点只会互相打架。
   */
  function queueAnchor() {
    if (isFollowing || queuedAnchor || isRestoring()) return
    const metrics = host.metrics()
    if (!metrics) return
    const anchor = captureAnchor()
    if (anchor) queuedAnchor = { anchor, scrollTop: metrics.scrollTop }
  }

  // 取出排队锚点并按这期间用户滚过的距离平移；取出即作废，过期锚点不留到下一帧
  function takeQueuedAnchor(): LogAnchor | undefined {
    const queued = queuedAnchor
    queuedAnchor = undefined
    if (!queued) return undefined
    const metrics = host.metrics()
    if (!metrics) return queued.anchor
    return { key: queued.anchor.key, offset: queued.anchor.offset - (metrics.scrollTop - queued.scrollTop) }
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

  async function scrollToBottom(frameRevision = revision, userRequested = false) {
    // 显式回底已递增代次，旧恢复失去写入权；不必等待网络请求结束才执行用户动作。
    // 自动贴底仍受闸门约束，二者在每次 await 后都必须持有当前代次。
    const superseded = () => disposed || frameRevision !== revision || (!userRequested && isRestoring())
    // 先渲染并测量末尾窗口，再写入最终位置。先滚后换窗会让 DOM 总高度短暂收缩，
    // 浏览器钳制 scrollTop 后发出的 scroll 曾被误判成用户上滚，导致追踪自动暂停。
    for (let round = 0; round < 3; round++) {
      const metrics = host.metrics()
      if (superseded() || !metrics) return
      syncWindow(Math.max(0, layout.totalHeight() - metrics.clientHeight))
      publish()
      await flush()
      if (superseded() || !host.metrics()) return
      if (!measureLines()) break
    }
    const metrics = host.metrics()
    if (superseded() || !metrics) return
    syncWindow(Math.max(0, layout.totalHeight() - metrics.clientHeight))
    publish()
    await flush()
    if (superseded()) return
    const current = host.metrics()
    if (!current) return
    scrollTo(Math.max(0, current.scrollHeight - current.clientHeight))
    updateViewingLatest()
    updateScrollbar()
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
    if (value) {
      pausedAnchor = undefined
      queuedAnchor = undefined
    }
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
    // 闸门在这一帧的等待期间被别处接管：本帧的测量与贴底还没做完，
    // 必须重新挂起待办等释放后补做——直接返回会把「备窗口 + 贴底」整段丢掉，
    // 而 windowPending 已经在帧开头清掉了，没人会再唤醒它
    if (disposed || frameRevision !== revision || !host.metrics()) return
    if (isRestoring()) return scheduleWindow()
    if (measureLines()) {
      syncWindow()
      publish()
      await flush()
    }
    // 闸门覆盖整个异步帧，不只是取锚点的那一刻；DOM 刷新也可能让页面失活。
    if (disposed || frameRevision !== revision || !host.metrics()) return
    if (isRestoring()) return scheduleWindow()
    if (isFollowing) {
      await scrollToBottom(frameRevision)
    } else if (anchor) {
      restoreAnchor(anchor)
      syncWindow()
    }
    updateViewingLatest()
    rememberPaused()
    publish()
    updateScrollbar()
  }

  function scheduleWindow() {
    if (disposed) return
    // 挂起不等于丢弃：帧请求保留到最后一个 writer 释放后，不能靠下一条日志唤醒。
    windowPending = true
    if (cancelFrame || isRestoring()) return
    cancelFrame = scheduleFrame(async () => {
      cancelFrame = undefined
      // 排队锚点只对紧接着的这一帧有效：闸门持有者自带锚点，让它接手时这个就该作废
      const queued = takeQueuedAnchor()
      if (disposed || isRestoring()) return
      windowPending = false
      if (resizePending) {
        resizePending = false
        if (!isFollowing && pausedAnchor) {
          await restore(pausedAnchor)
          return
        }
      }
      const frameRevision = revision
      // 不变量 1：恢复位置期间不取锚点也不改位置，让出这一帧
      // 不变量 6：清单刚变过就用变更前排下的锚点，此刻现取只会读到已经跳过的位置
      const anchor = !isFollowing ? queued ?? captureAnchor() : undefined
      // 新进入窗口的多行日志尚未实测，换窗本身就可能移动内容。
      // 必须沿用换窗前的锚点完成测量与定位，不能在换窗后重新取锚点。
      // 锚点那条日志已被淘汰出清单时 restore 不接管，此时仍要把窗口刷到当前位置，
      // 否则这一帧的待办已经清掉，窗口会一直停在旧区间
      if (anchor && await restore(anchor, true)) return
      syncWindow()
      publish()
      await flush()
      if (disposed || frameRevision !== revision) return
      // 快速滚动越过旧窗口时先按目标位置换窗，再取真正可见的日志用于测量补偿。
      await settle(!isFollowing ? captureAnchor() : undefined, frameRevision)
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

  /** 返回是否真的接管了滚动位置：锚点那条日志已不在清单里时不接管，调用方须自己把窗口刷新掉 */
  async function restore(anchor?: LogAnchor, scrolling = false) {
    const metrics = host.metrics()
    if (disposed || !metrics || !anchor || layout.indexOf(anchor.key) < 0) return false
    // 普通滚动的换窗补偿不是导航：浏览器可能先滚动、稍后才派发 scroll。
    // 仅核对 revision 不足以发现这段移动；旧帧必须让路，不能把用户拉回取锚点时的位置。
    const interrupted = () => {
      if (disposed || restoreRevision !== revision || !host.metrics() || layout.indexOf(anchor.key) < 0) return true
      if (scrolling && host.metrics()!.scrollTop !== metrics.scrollTop) {
        scheduleWindow()
        return true
      }
      return false
    }
    writers++
    const restoreRevision = ++revision
    try {
      // 锚点按标识重新定位；刷新期间清单可能变化，不能沿用旧下标。
      const targetOffset = () => layout.offsetOf(layout.indexOf(anchor.key)) - anchor.offset
      for (let round = 0; round < restoreRounds; round++) {
        syncWindow(targetOffset())
        publish()
        await flush()
        if (interrupted()) return
        if (!measureLines()) break
      }
      // 最后一轮测量也会改上下占位。先提交占位，再只按实际矩形写一次，
      // 不能先写布局估算位置又用尚未刷新的矩形精调，否则仍会二次跳动。
      syncWindow(targetOffset())
      publish()
      await flush()
      if (interrupted()) return
      restoreAnchor(anchor)
      resizePending = false
      syncWindow()
      updateViewingLatest()
      rememberPaused()
      publish()
    } finally {
      releaseWriter()
    }
    return true
  }

  async function scrollToProgress(progress: number) {
    const metrics = host.metrics()
    if (disposed || !metrics || !Number.isFinite(progress)) return
    const target = Math.max(0, Math.min(1, progress))
    const navigationRevision = ++revision
    intent++
    queuedAnchor = undefined
    setFollowing(target === 1)
    writers++
    const bottomInset = Math.max(0, metrics.scrollHeight - metrics.contentTop - layout.totalHeight())
    const superseded = () => disposed || navigationRevision !== revision || !host.metrics()
    const targetOffset = () => {
      const current = host.metrics()!
      return logScrollOffset(layout, {
        ...current,
        scrollHeight: current.contentTop + layout.totalHeight() + bottomInset,
      }, target)
    }
    try {
      // 拖到未测量的历史区时先渲染、测量、重新反算同一个记录比例。
      // 与锚点恢复一样，收敛前不写 scrollTop，避免把估算落点展示给用户。
      for (let round = 0; round < 6; round++) {
        syncWindow(targetOffset() - host.metrics()!.contentTop)
        publish()
        await flush()
        if (superseded()) return
        if (!measureLines()) break
      }
      syncWindow(targetOffset() - host.metrics()!.contentTop)
      publish()
      await flush()
      if (superseded()) return
      scrollTo(targetOffset())
      updateViewingLatest()
      rememberPaused()
      publish()
    } finally {
      releaseWriter()
    }
  }

  return {
    scrollbar: {
      subscribe(listener) {
        scrollbarListeners.add(listener)
        return () => { scrollbarListeners.delete(listener) }
      },
      // 不暴露换窗、实测与补偿之间的临时几何，否则滑块仍会闪回一次。
      metrics: () => disposed || !host.metrics() ? undefined : scrollbarSnapshot,
      scrollTo: progress => { void scrollToProgress(progress) },
    },
    setItems(keys) {
      if (disposed) return
      // 不变量 6：清单一变，窗口下标指向的记录就可能换人（实时缓冲写满后每来一条就淘汰最早一条），
      // 必须在渲染层提交 DOM 之前把当前阅读位置留下来
      queueAnchor()
      layout.setItems(keys)
      // 与 handleScroll 同理：暂停浏览时换窗要等下一帧先取锚点再补偿。
      // 新日志到达与用户滚动几乎总是交错发生，这里提前发布按新位置算出的窗口，
      // 会把刚进入窗口、尚未实测的长日志的高度差直接变成一次可见跳动
      if (isFollowing) syncWindow()
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
      intent++
      updateViewingLatest()
      // 用户往上滚就是在读日志，转入暂停；滚回底部再恢复追踪
      if (metrics.scrollTop < previousScrollTop) {
        setFollowing(false)
      } else if (isViewingLatest) {
        setFollowing(true)
      }
      // 暂停浏览时由下一帧先取旧窗口锚点，再换窗、测量和补偿。
      // 提前发布新窗口会把未实测长日志的高度差直接变成可见跳动。
      if (isFollowing) syncWindow()
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
        // 当前事务成功时合并到它的恢复；失败时由释放后的帧补做，不能丢掉调宽锚点。
        if (isRestoring()) resizePending = true
        if (anchor && !isRestoring()) {
          void restore(anchor).then(scheduleWindow)
          return
        }
      }
      scheduleWindow()
    },
    followLatest() {
      if (disposed) return
      const followRevision = ++revision
      intent++
      setFollowing(true)
      isViewingLatest = true
      queuedAnchor = undefined
      publish()
      void flush().then(() => {
        if (disposed) return
        scheduleFrame(async () => {
          if (disposed) return
          await scrollToBottom(followRevision, true)
          publish()
          scheduleWindow()
        })
      })
    },
    /**
     * 把会前插内容的变更交给它执行。
     *
     * 闸门只覆盖「内容已改、位置还没修」的那一小段，不覆盖等请求的那一大段：
     * 读一页历史要跨很多帧，关着闸门等下去，渲染窗口就冻在请求开始时的位置——
     * 用户继续滚只会滚进一片空白，请求回来还会被拉回旧锚点。请求在途期间内容尚未改变，
     * 本来就不需要独占滚动位置，逐帧的锚点补偿照常跟着用户走。
     */
    async around(change) {
      if (disposed) return
      // 不变量 2：锚点必须在内容变更之前取，否则读到的是移动后的位置，修正等于没做
      const anchor = captureAnchor()
      const wasFollowing = isFollowing
      const changeIntent = intent
      // 手动加载历史意味着要停下来读，因此立刻暂停追踪：等内容落地再暂停就晚了，
      // 中间的窗口刷新会先把视口贴到底部，用户看到的就是「跳到底再弹回来」
      if (anchor) {
        setFollowing(false)
        pausedAnchor = anchor
      }
      revision++
      try {
        await change()
      } catch (error) {
        // 加载失败时把暂停一并回滚：用户没得到历史，追踪状态就该回到点击之前
        if (wasFollowing && changeIntent === intent) {
          setFollowing(true)
          publish()
          scheduleWindow()
        }
        throw error
      }
      if (disposed) return
      // 内容已落地，从这里开始独占，避免逐帧修正与复位互相打断
      writers++
      try {
        await flush()
        if (disposed) return
        await nextFrame()
        if (disposed) return
        // 等待期间用户可能已经自己接管了位置：显式回底就不复位，改读别处就按新位置复位
        if (changeIntent !== intent) {
          if (!isFollowing) await restore(pausedAnchor ?? anchor)
        } else {
          await restore(anchor)
        }
      } finally {
        releaseWriter()
      }
    },
    capture() {
      rememberPaused()
      return pausedAnchor
    },
    restore(anchor) {
      return restore(anchor ?? pausedAnchor).then(() => {})
    },
    dispose() {
      disposed = true
      revision++
      scrollbarListeners.clear()
      queuedAnchor = undefined
      for (const cancel of pendingFrames) cancel()
      cancelFrame = undefined
    },
  }
}
