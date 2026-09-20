/**
 * 变高虚拟列表布局。
 *
 * 日志行高度不固定：正文可以换行，跨重启的分隔行还多一段留白，因此不能按固定行高换算偏移。
 * 这里按稳定标识缓存实测高度，未量过的行用估算值顶位，偏移表只从第一处失效的下标往后重算。
 */

export interface VirtualListWindow {
  /** 窗口内第一条的下标 */
  start: number
  /** 窗口尾后下标，即最后一条的下标加一 */
  end: number
  /** 窗口之前所有条目的总高度 */
  paddingTop: number
  /** 窗口之后所有条目的总高度 */
  paddingBottom: number
}

export interface VirtualListLayout {
  /** 更新条目清单，已实测高度按标识继续沿用 */
  setItems(keys: string[], estimates?: readonly number[]): void
  /** 更新估算行高，只影响尚未实测的条目 */
  setEstimatedHeight(height: number): void
  /** 记录实测高度，返回偏移是否需要重算 */
  measure(key: string, height: number): boolean
  /** 丢弃全部实测高度，容器宽度变化后换行结果全部失效时使用 */
  forgetHeights(): void
  /** 查找条目下标，不在清单里返回 -1 */
  indexOf(key: string): number
  /** 条目顶部相对列表内容顶部的偏移 */
  offsetOf(index: number): number
  /** 像素偏移转成「记录下标 + 行内比例」，不受其他行估算高度修正影响 */
  positionAt(offset: number): number
  /** 将记录位置映射到稳定的预估像素坐标，不随逐行实测改变 */
  estimatedOffsetAt(position: number): number
  /** 根据正文预估的全量高度；未提供逐条预估时使用统一行高 */
  estimatedTotalHeight(): number
  /** 全部条目的总高度 */
  totalHeight(): number
  /** 实测高度的缓存条数，仅供守卫测试断言缓存不会无限增长 */
  measuredSize(): number
  /** 按滚动偏移算出需要渲染的窗口 */
  getWindow(scrollOffset: number, viewportHeight: number, overscan: number): VirtualListWindow
}

// 实测缓存的保留倍数：实时日志反复增删，缓存按标识存放，
// 只有超过当前条数的这个倍数才做一次全量清理，避免每次推送都遍历缓存
const measuredRetainFactor = 3

export function createVirtualListLayout(estimatedHeight: number): VirtualListLayout {
  let estimate = estimatedHeight
  let keys: string[] = []
  let indexes = new Map<string, number>()
  const measured = new Map<string, number>()
  const estimated = new Map<string, number>()
  const estimatedOffsets: number[] = [0]
  let estimatedDirty = 1
  // offsets[i] 是第 i 条的顶部偏移，offsets[keys.length] 是总高度
  let offsets: number[] = [0]
  // 第一个可能失效的偏移下标：小于它的偏移一律有效
  let dirty = 1

  function estimatedAt(index: number) {
    return estimated.get(keys[index]) ?? estimate
  }

  function heightAt(index: number) {
    return measured.get(keys[index]) ?? estimatedAt(index)
  }

  function markDirty(index: number, estimatesChanged = false) {
    if (index < dirty) dirty = index
    if (estimatesChanged && index < estimatedDirty) estimatedDirty = index
  }

  function ensureEstimatedOffsets() {
    estimatedOffsets.length = keys.length + 1
    for (let index = Math.max(1, estimatedDirty); index <= keys.length; index++) {
      estimatedOffsets[index] = estimatedOffsets[index - 1] + estimatedAt(index - 1)
    }
    estimatedDirty = keys.length + 1
  }

  function ensureOffsets() {
    if (offsets.length !== keys.length + 1) offsets.length = keys.length + 1
    if (dirty > keys.length) return
    for (let index = Math.max(dirty, 1); index <= keys.length; index++) {
      offsets[index] = offsets[index - 1] + heightAt(index - 1)
    }
    dirty = keys.length + 1
  }

  function pruneMeasured() {
    if (measured.size <= keys.length * measuredRetainFactor) return
    for (const key of measured.keys()) {
      if (!indexes.has(key)) measured.delete(key)
    }
  }

  function setItems(nextKeys: string[], nextEstimates?: readonly number[]) {
    const limit = Math.min(keys.length, nextKeys.length)
    let diff = 0
    while (diff < limit && keys[diff] === nextKeys[diff]) diff++
    if (diff !== limit || keys.length !== nextKeys.length) {
      keys = nextKeys
      indexes = new Map()
      for (let index = 0; index < keys.length; index++) indexes.set(keys[index], index)
      pruneMeasured()
      for (const key of estimated.keys()) if (!indexes.has(key)) estimated.delete(key)
      // 前 diff 条没变，它们的顶部偏移连同 offsets[diff] 都还有效。
      markDirty(diff + 1, true)
    }
    if (!nextEstimates) return
    for (let index = 0; index < keys.length; index++) {
      const height = nextEstimates[index]
      if (!(height > 0) || !Number.isFinite(height) || estimated.get(keys[index]) === height) continue
      // 同一记录的预估改变意味着正文或排版条件改变，旧实测高度也不能继续沿用。
      if (estimated.has(keys[index])) measured.delete(keys[index])
      estimated.set(keys[index], height)
      markDirty(index + 1, true)
    }
  }

  function findIndexAtOffset(offset: number) {
    ensureOffsets()
    if (!keys.length) return 0
    let low = 0
    let high = keys.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (offsets[middle] <= offset) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    return low
  }

  return {
    setItems,
    setEstimatedHeight(height) {
      if (!(height > 0) || height === estimate) return
      estimate = height
      markDirty(1, true)
    },
    measure(key, height) {
      if (!(height > 0) || measured.get(key) === height) return false
      measured.set(key, height)
      const index = indexes.get(key)
      // 已经被移出清单的行只留在缓存里等清理，不参与偏移
      if (index === undefined) return false
      markDirty(index + 1)
      return true
    },
    forgetHeights() {
      if (!measured.size) return
      measured.clear()
      markDirty(1)
    },
    indexOf(key) {
      const index = indexes.get(key)
      return index === undefined ? -1 : index
    },
    offsetOf(index) {
      ensureOffsets()
      if (index <= 0) return 0
      return offsets[Math.min(index, keys.length)]
    },
    positionAt(offset) {
      ensureOffsets()
      if (offset <= 0 || !keys.length) return 0
      if (offset >= offsets[keys.length]) return keys.length
      const index = findIndexAtOffset(offset)
      return index + (offset - offsets[index]) / heightAt(index)
    },
    estimatedOffsetAt(position) {
      ensureEstimatedOffsets()
      if (position <= 0 || !keys.length) return 0
      if (position >= keys.length) return estimatedOffsets[keys.length]
      const index = Math.floor(position)
      return estimatedOffsets[index] + (position - index) * estimatedAt(index)
    },
    estimatedTotalHeight() {
      ensureEstimatedOffsets()
      return estimatedOffsets[keys.length]
    },
    totalHeight() {
      ensureOffsets()
      return offsets[keys.length]
    },
    measuredSize() {
      return measured.size
    },
    getWindow(scrollOffset, viewportHeight, overscan) {
      ensureOffsets()
      if (!keys.length) return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 }
      const total = offsets[keys.length]
      const top = Math.max(0, scrollOffset - overscan)
      const bottom = scrollOffset + Math.max(0, viewportHeight) + overscan
      const start = findIndexAtOffset(top)
      const end = Math.min(keys.length, Math.max(start + 1, findIndexAtOffset(bottom) + 1))
      return {
        start,
        end,
        paddingTop: offsets[start],
        paddingBottom: Math.max(0, total - offsets[end]),
      }
    },
  }
}
