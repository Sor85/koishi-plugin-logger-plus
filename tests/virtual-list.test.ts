import test from 'node:test'
import assert from 'node:assert/strict'
import { createVirtualListLayout } from '../client/virtual-list'

function keys(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => `${index + offset}`)
}

test('只渲染窗口内的条目，窗口外的高度折进上下占位', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(keys(1000))

  const window = layout.getWindow(0, 100, 0)

  assert.deepEqual(window, { start: 0, end: 6, paddingTop: 0, paddingBottom: 19880 })
  assert.equal(layout.totalHeight(), 20000)
})

test('滚动到中段时只取该段条目，并按 overscan 多备一段', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(keys(1000))

  const window = layout.getWindow(5000, 100, 100)

  assert.equal(window.start, 245)
  assert.equal(window.end, 261)
  assert.equal(window.paddingTop, 4900)
  assert.equal(window.paddingBottom, 20000 - 5220)
})

test('实测高度后按真实高度累加偏移', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(keys(5))

  assert.equal(layout.measure('1', 60), true)
  assert.equal(layout.measure('1', 60), false)
  assert.equal(layout.offsetOf(1), 20)
  assert.equal(layout.offsetOf(2), 80)
  assert.equal(layout.totalHeight(), 140)

  const window = layout.getWindow(0, 100, 0)

  assert.deepEqual(window, { start: 0, end: 4, paddingTop: 0, paddingBottom: 20 })
})

test('前插条目后沿用已实测高度，只把偏移整体下移', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(['a', 'b', 'c'])
  layout.measure('b', 60)

  assert.equal(layout.offsetOf(2), 80)

  layout.setItems(['x', 'y', 'a', 'b', 'c'])

  assert.equal(layout.indexOf('b'), 3)
  assert.equal(layout.offsetOf(3), 60)
  assert.equal(layout.offsetOf(4), 120)
  assert.equal(layout.totalHeight(), 140)
})

test('末尾追加条目不影响已有偏移', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(['a', 'b'])
  layout.measure('a', 40)

  assert.equal(layout.totalHeight(), 60)

  layout.setItems(['a', 'b', 'c'])

  assert.equal(layout.offsetOf(1), 40)
  assert.equal(layout.totalHeight(), 80)
})

test('容器宽度变化后丢弃实测高度，回落到估算值', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(['a', 'b'])
  layout.measure('a', 100)

  assert.equal(layout.totalHeight(), 120)

  layout.forgetHeights()

  assert.equal(layout.totalHeight(), 40)
})

test('估算行高改变后未实测的条目随之更新', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(['a', 'b'])
  layout.measure('a', 100)

  layout.setEstimatedHeight(30)

  assert.equal(layout.totalHeight(), 130)
})

test('已移出清单的条目不再占用实测缓存', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(keys(10))
  for (const key of keys(10)) layout.measure(key, 40)

  assert.equal(layout.measuredSize(), 10)

  // 实时日志会不断丢弃最旧的记录，缓存必须跟着收缩，不能随进程存活时间无限增长
  for (let round = 1; round <= 20; round++) {
    layout.setItems(keys(10, round * 10))
    for (const key of keys(10, round * 10)) layout.measure(key, 40)
  }

  assert.ok(layout.measuredSize() <= 40, `实测缓存涨到 ${layout.measuredSize()} 条`)
})

test('十万条日志仍能定位窗口且不展开数组', () => {
  const layout = createVirtualListLayout(20)
  const total = 100000
  layout.setItems(keys(total))

  const window = layout.getWindow(1000000, 400, 0)

  assert.equal(layout.totalHeight(), total * 20)
  assert.equal(window.start, 50000)
  assert.equal(window.end, 50021)
  assert.equal(window.end - window.start < 100, true)
})

test('清单为空时窗口为空且不产生占位', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems([])

  assert.deepEqual(layout.getWindow(0, 400, 200), { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 })
  assert.equal(layout.totalHeight(), 0)
  assert.equal(layout.indexOf('a'), -1)
})

test('条目减少后偏移与总高度随之收缩', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(keys(100))

  assert.equal(layout.totalHeight(), 2000)

  layout.setItems(keys(3))

  assert.equal(layout.totalHeight(), 60)
  assert.equal(layout.offsetOf(3), 60)
  assert.equal(layout.getWindow(0, 400, 0).paddingBottom, 0)
})

test('逐条预估同时用于未实测占位与稳定权重，实测只改变实际偏移', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(['a', 'b', 'c'], [20, 1000, 40])
  assert.equal(layout.totalHeight(), 1060)
  assert.equal(layout.estimatedTotalHeight(), 1060)
  assert.equal(layout.estimatedOffsetAt(1.5), 520)
  layout.measure('b', 1200)
  assert.equal(layout.totalHeight(), 1260)
  assert.equal(layout.estimatedOffsetAt(1.5), 520)
  assert.equal(layout.estimatedTotalHeight(), 1060)
  assert.equal(layout.positionAt(620), 1.5)
  layout.setItems(['history', 'a', 'b', 'c'], [300, 20, 1000, 40])
  assert.equal(layout.totalHeight(), 1560)
  assert.equal(layout.estimatedOffsetAt(2.5), 820)
  layout.setItems(['c'], [40])
  assert.equal(layout.estimatedTotalHeight(), 40)
  layout.setItems([])
  assert.equal(layout.estimatedTotalHeight(), 0)
  assert.equal(layout.estimatedOffsetAt(Infinity), 0)
})

test('相同清单在宽度变化后更新预估并作废对应实测，旧偏移不能残留', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(['a', 'b'], [20, 1000])
  layout.measure('b', 1100)
  layout.totalHeight()
  layout.estimatedTotalHeight()
  layout.setItems(['a', 'b'], [40, 2000])
  assert.equal(layout.totalHeight(), 2040)
  assert.equal(layout.estimatedTotalHeight(), 2040)
  assert.equal(layout.estimatedOffsetAt(1.5), 1040)
})
