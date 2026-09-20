export interface ScrollbarMetrics {
  /** 已滚过的距离；像素或虚拟列表的记录单位，三项必须同单位 */
  offset: number
  viewport: number
  total: number
  /** 可选的独立尺寸比例；虚拟列表的可见记录数不能同时用来计算滑块长度 */
  thumbRatio?: number
}

export interface ScrollbarSource {
  subscribe(listener: () => void): () => void
  metrics(): ScrollbarMetrics | undefined
  /** 滑块在可移动轨道中的比例，范围 0–1 */
  scrollTo(progress: number): void
}

export function clampProgress(value: number) {
  return Math.min(1, Math.max(0, value))
}

export function scrollbarGeometry(metrics: ScrollbarMetrics, track: number, minimum = 28) {
  const range = Math.max(0, metrics.total - metrics.viewport)
  const progress = range > 0 ? clampProgress(metrics.offset / range) : 0
  const ratio = metrics.thumbRatio ?? metrics.viewport / Math.max(metrics.total, 1)
  const height = Math.min(track, Math.max(minimum, track * clampProgress(ratio)))
  return { progress, height, top: progress * Math.max(0, track - height) }
}

/** 拖拽基准固定在按下时的轨道上，不能随虚拟行测量后的 scrollHeight 重算比例。 */
export function draggedProgress(start: number, delta: number, travel: number) {
  return clampProgress(start + delta / Math.max(1, travel))
}
