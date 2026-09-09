/**
 * 滚动容器的 DOM 访问口。
 *
 * 视口协调只通过这四个方法读写滚动几何，因此协调逻辑不认识 HTMLElement，
 * 也不认识 `data-log-key` 这个渲染约定：测试可以拿字面量对象充当假容器，
 * 在无 DOM 环境下驱动整套滚动行为。
 */

export interface ViewportMetrics {
  scrollTop: number
  clientHeight: number
  clientWidth: number
  scrollHeight: number
  /** 占位容器相对滚动容器内边距盒的顶部偏移；「查看更多消息」按钮与顶部内边距都算在它前面 */
  contentTop: number
}

export interface ViewportLine {
  /** 稳定标识，前插历史日志后仍然指向同一条 */
  key: string
  /** 实测高度，行间留白已计入 */
  height: number
  /** 相对滚动容器视口顶部的偏移 */
  top: number
}

export interface ViewportHost {
  /** 滚动容器几何；容器不存在或已离开 DOM 时返回 undefined */
  metrics(): ViewportMetrics | undefined
  /** 当前渲染出来的行；一次性满足锚点捕获与锚点恢复两边的需求 */
  lines(): ViewportLine[]
  scrollTo(scrollTop: number): void
  estimatedLineHeight(): number
}

export interface DomViewportHostOptions {
  /** 滚动容器 */
  list(): HTMLElement | null | undefined
  /** 虚拟滚动的占位容器，日志行都在它里面 */
  content(): HTMLElement | null | undefined
  /** 取不到实测行高时的估算值 */
  fallbackLineHeight: number
}

export function createDomViewportHost(options: DomViewportHostOptions): ViewportHost {
  // 已离开 DOM 的容器读数不稳定，一律当作没有几何，调用方因此不必单独判断 isConnected
  function connectedList() {
    const element = options.list()
    if (!element || !element.isConnected) return undefined
    return element
  }

  return {
    metrics() {
      const element = connectedList()
      if (!element) return undefined
      return {
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        // offsetTop 是布局值：占位只能用内边距，改用位移变换的话这里会整段偏掉
        contentTop: options.content()?.offsetTop ?? 0,
      }
    },
    lines() {
      const element = connectedList()
      const content = options.content()
      if (!element || !content) return []
      const listTop = element.getBoundingClientRect().top
      const lines: ViewportLine[] = []
      for (const line of content.querySelectorAll<HTMLElement>('[data-log-key]')) {
        const key = line.dataset.logKey
        if (!key) continue
        const rect = line.getBoundingClientRect()
        lines.push({ key, height: rect.height, top: rect.top - listTop })
      }
      return lines
    },
    scrollTo(scrollTop) {
      const element = connectedList()
      if (element) element.scrollTop = scrollTop
    },
    estimatedLineHeight() {
      const element = connectedList()
      if (!element) return options.fallbackLineHeight
      return Number.parseFloat(getComputedStyle(element).lineHeight) || options.fallbackLineHeight
    },
  }
}

/**
 * 临时桥接：暂停位置 module 仍按 HTMLElement 的形状读写滚动几何。
 *
 * `lines()` 给出的偏移已经相对滚动容器视口顶部，因此容器矩形的 top 取 0；
 * 写 scrollTop 转发给 host。该 module 并入协调核心之后这个函数一并删除。
 */
export function asAnchorElement(host: ViewportHost): HTMLElement | undefined {
  const metrics = host.metrics()
  if (!metrics) return undefined
  const lines = host.lines().map(line => ({
    dataset: { logKey: line.key },
    getBoundingClientRect: () => ({ top: line.top, bottom: line.top + line.height }),
  }))
  return {
    isConnected: true,
    get scrollTop() {
      return host.metrics()?.scrollTop ?? metrics.scrollTop
    },
    set scrollTop(value: number) {
      // 位置没变就不下发：修正量为零时不该记成一次滚动写入
      if (host.metrics()?.scrollTop === value) return
      host.scrollTo(value)
    },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => lines,
  } as unknown as HTMLElement
}
