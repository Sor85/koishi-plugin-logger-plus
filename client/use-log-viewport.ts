/**
 * LogViewport 的 Vue 外壳。
 *
 * 只做三件事：把模板 ref 接成 ViewportHost、把帧调度与 DOM 刷新注入核心、
 * 把核心抛出的状态落进 ref。协调逻辑一律不在这里，核心因此与框架无关。
 */

import type { Ref } from 'vue'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { LogViewport, LogViewportState } from './log-viewport'
import { createLogViewport } from './log-viewport'
import { createDomViewportHost } from './viewport-host'
import type { VirtualListWindow } from './virtual-list'

export interface UseLogViewportOptions {
  /** 滚动容器 */
  list: Ref<HTMLElement | null>
  /** 虚拟滚动的占位容器 */
  content: Ref<HTMLElement | null>
  /** 视口上下各多渲染的高度 */
  overscan: number
  /** 取不到实测行高时的估算值 */
  fallbackLineHeight: number
  /** 状态变化时搭车更新渲染层的细节，例如原生滚动条宽度遮罩 */
  onStateChange?(state: LogViewportState): void
}

export function useLogViewport(options: UseLogViewportOptions) {
  const logWindow = ref<VirtualListWindow>({ start: 0, end: 0, paddingTop: 0, paddingBottom: 0 })
  const isFollowing = ref(true)
  const isViewingLatest = ref(true)

  const viewport: LogViewport = createLogViewport({
    host: createDomViewportHost({
      list: () => options.list.value,
      content: () => options.content.value,
      fallbackLineHeight: options.fallbackLineHeight,
    }),
    schedule(task) {
      const frame = requestAnimationFrame(task)
      return () => cancelAnimationFrame(frame)
    },
    flush: () => nextTick(),
    fallbackViewportHeight: () => window.innerHeight,
    onStateChange(state) {
      logWindow.value = state.window
      isFollowing.value = state.isFollowing
      isViewingLatest.value = state.isViewingLatest
      options.onStateChange?.(state)
    },
    overscan: options.overscan,
    fallbackLineHeight: options.fallbackLineHeight,
  })

  let observer: ResizeObserver | undefined

  onMounted(() => {
    const element = options.list.value
    if (element && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => viewport.handleResize())
      observer.observe(element)
    }
    // 没有 ResizeObserver 时也要走一次首帧：量估算行高、贴底、备好第一屏
    requestAnimationFrame(() => viewport.handleResize())
  })

  onUnmounted(() => {
    observer?.disconnect()
    observer = undefined
    viewport.dispose()
  })

  return { viewport, logWindow, isFollowing, isViewingLatest }
}
