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

import type { PausedLogPosition } from './log-position'
import { capturePausedLogPosition, restorePausedLogPosition } from './log-position'
import type { ViewportHost } from './viewport-host'
import { asAnchorElement } from './viewport-host'
import type { VirtualListWindow } from './virtual-list'
import { createVirtualListLayout } from './virtual-list'

/** 视口内第一条可见日志的稳定标识与相对偏移 */
export type LogAnchor = PausedLogPosition

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
  // 不变量 1：单写者闸门。大于零表示正有一处在按锚点改滚动位置，
  // 逐帧的高度修正此时必须让路，两处同时改会互相打断
  let writers = 0

  function isRestoring() {
    return writers > 0
  }

  // 状态去重：窗口四字段与两项追踪状态全等就不再往外抛，
  // 否则「窗口没变」也会变成一次渲染层写入
  function publish() {
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
    const metrics = host.metrics()
    if (!metrics || metrics.scrollTop === scrollTop) return
    host.scrollTo(scrollTop)
  }

  function captureAnchor() {
    const element = asAnchorElement(host)
    return element ? capturePausedLogPosition(element) : undefined
  }

  // 不变量 5：找不到锚点时保持当前位置，不强行恢复
  function restoreAnchor(anchor?: LogAnchor) {
    const element = asAnchorElement(host)
    return element ? restorePausedLogPosition(element, anchor) : false
  }

  // 按当前滚动位置算出要渲染的日志区间。窗口吃的是内容坐标而非滚动位置：
  // 占位容器之前还有「查看更多消息」和顶部内边距，先减掉再交给布局换算
  function syncWindow() {
    const metrics = host.metrics()
    let scrollOffset: number
    let viewportHeight: number
    if (metrics) {
      scrollOffset = metrics.scrollTop - metrics.contentTop
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

  function scrollToBottom() {
    const metrics = host.metrics()
    if (!metrics) return
    scrollTo(metrics.scrollHeight)
    syncWindow()
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
  async function settle(anchor?: LogAnchor) {
    if (!host.metrics()) return
    if (measureLines()) {
      syncWindow()
      await flush()
    }
    if (isFollowing && !isRestoring()) {
      scrollToBottom()
    } else if (anchor) {
      restoreAnchor(anchor)
      syncWindow()
    }
    updateViewingLatest()
    publish()
  }

  function scheduleWindow() {
    if (cancelFrame || disposed) return
    cancelFrame = schedule(async () => {
      cancelFrame = undefined
      if (disposed) return
      // 不变量 1：恢复位置期间不取锚点也不改位置，让出这一帧
      const anchor = !isFollowing && !isRestoring() ? captureAnchor() : undefined
      syncWindow()
      publish()
      await flush()
      if (disposed) return
      await settle(anchor)
    })
  }

  function nextFrame() {
    return new Promise<void>((resolve) => {
      schedule(() => resolve())
    })
  }

  /**
   * 把视口滚回锚点所在的日志。
   *
   * 锚点那条日志可能落在渲染窗口之外，此时 DOM 里根本没有它：先按布局偏移粗定位，
   * 等窗口渲染出来并量过高度，再用锚点的实际位置精调一次。
   */
  async function restore(anchor?: LogAnchor) {
    const metrics = host.metrics()
    if (!metrics || !anchor) return
    writers++
    try {
      const index = layout.indexOf(anchor.key)
      if (index >= 0) {
        scrollTo(metrics.contentTop + layout.offsetOf(index) - anchor.offset)
        syncWindow()
        publish()
        await flush()
        measureLines()
        syncWindow()
        publish()
        await flush()
      }
      restoreAnchor(anchor)
      syncWindow()
      updateViewingLatest()
      publish()
    } finally {
      writers--
    }
  }

  return {
    setItems(keys) {
      layout.setItems(keys)
      syncWindow()
      publish()
      scheduleWindow()
    },
    handleScroll() {
      const metrics = host.metrics()
      if (!metrics) return
      const previousScrollTop = lastScrollTop
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
      const metrics = host.metrics()
      if (!metrics) return
      // 不变量 4：宽度一变换行结果全部失效，清空重量；高度变化不清
      if (metrics.clientWidth !== listWidth) {
        listWidth = metrics.clientWidth
        layout.forgetHeights()
      }
      layout.setEstimatedHeight(host.estimatedLineHeight())
      scheduleWindow()
    },
    followLatest() {
      setFollowing(true)
      isViewingLatest = true
      publish()
      void flush().then(() => {
        if (disposed) return
        schedule(() => {
          if (disposed) return
          scrollToBottom()
          publish()
          scheduleWindow()
        })
      })
    },
    async around(change) {
      // 不变量 2：锚点必须在内容变更之前取，否则读到的是移动后的位置，修正等于没做
      const anchor = captureAnchor()
      await change()
      writers++
      try {
        await flush()
        await nextFrame()
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
      cancelFrame?.()
      cancelFrame = undefined
    },
  }
}
