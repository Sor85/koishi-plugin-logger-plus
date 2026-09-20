import type { VirtualListLayout } from './virtual-list'
import type { ViewportMetrics } from './viewport-host'
import { clampProgress, scrollbarGeometry } from './scrollbar-geometry'

/**
 * 原生像素坐标仍用于正文锚点补偿；滑块使用按文本预估高度加权的记录坐标。
 * 长 JSON 不再与一行短消息占据相同距离。实测只改变像素到行内比例的换算，
 * 不改变每条记录的预估权重，因此屏外测量不会使阅读进度倒退。
 */
export function logScrollbarMetrics(layout: VirtualListLayout, metrics: ViewportMetrics) {
  const position = (offset: number) => layout.estimatedOffsetAt(layout.positionAt(offset))
  const top = position(metrics.scrollTop - metrics.contentTop)
  const bottom = position(metrics.scrollTop + metrics.clientHeight - metrics.contentTop)
  // 长度只取整份清单的预估高度，不随当前可见行的实测结果忽大忽小。
  const total = layout.estimatedTotalHeight()
  const thumbRatio = metrics.clientHeight / Math.max(metrics.clientHeight * 2, total, 1)
  return { offset: top, viewport: bottom - top, total, thumbRatio }
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
