import type { VirtualListLayout } from './virtual-list'
import type { ViewportMetrics } from './viewport-host'
import { clampProgress, scrollbarGeometry } from './scrollbar-geometry'

/**
 * 原生像素坐标仍用于正文锚点补偿；滑块使用记录坐标。
 * 未测量历史行从 20px 展开成数百像素时，scrollTop 和 scrollHeight 都会增长，
 * 其比值会倒退；「第几条 + 行内比例」则只随实际阅读位置改变。
 */
export function logScrollbarMetrics(layout: VirtualListLayout, metrics: ViewportMetrics) {
  const top = layout.positionAt(metrics.scrollTop - metrics.contentTop)
  const bottom = layout.positionAt(metrics.scrollTop + metrics.clientHeight - metrics.contentTop)
  // 位置需要真实可见记录范围，尺寸却不能随一屏中的记录数变化。
  // 用总条数与统一估算行高决定长度，逐行测量只修正位置；最多占半条轨道，
  // 避免仅一条超长日志时，估算不足一屏却把可拖动轨道全部占满。
  const thumbRatio = metrics.clientHeight / Math.max(metrics.clientHeight * 2, layout.estimatedTotalHeight(), 1)
  return { offset: top, viewport: bottom - top, total: layout.positionAt(Infinity), thumbRatio }
}

/** 正反映射使用同一坐标系；实测行高更新后重新求解，不能把记录比例直接乘像素总高度。 */
export function logScrollOffset(layout: VirtualListLayout, metrics: ViewportMetrics, progress: number) {
  const target = clampProgress(progress)
  let low = 0
  let high = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  if (target === 0) return low
  if (target === 1) return high
  for (let round = 0; round < 40; round++) {
    const middle = (low + high) / 2
    const logical = logScrollbarMetrics(layout, { ...metrics, scrollTop: middle })
    const current = scrollbarGeometry(logical, 1, 0).progress
    if (current < target) low = middle
    else high = middle
  }
  return (low + high) / 2
}
