import test from 'node:test'
import assert from 'node:assert/strict'
import { createVirtualListLayout } from '../client/virtual-list'
import { logScrollbarMetrics, logScrollOffset } from '../client/log-scrollbar'
import { draggedProgress, scrollbarGeometry } from '../client/scrollbar-geometry'

test('记录坐标保留长日志的行内比例，其他行实测不会改变阅读进度', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(['a', 'b', 'c', 'd'])
  layout.measure('b', 1000)
  const metrics = { scrollTop: 530, contentTop: 10, clientHeight: 200, clientWidth: 600, scrollHeight: 1070 }
  const before = logScrollbarMetrics(layout, metrics)
  assert.equal(before.offset, 1.5)
  layout.measure('a', 800)
  const after = logScrollbarMetrics(layout, { ...metrics, scrollTop: 1310, scrollHeight: 1850 })
  assert.deepEqual(after, before)
  assert.equal(layout.positionAt(-1), 0)
  assert.equal(layout.positionAt(Infinity), 4)
})

test('混合长短记录的滑块正反映射一致，包含顶部按钮与底部内边距', () => {
  const layout = createVirtualListLayout(20)
  const keys = Array.from({ length: 100 }, (_, i) => `${i}`)
  layout.setItems(keys)
  for (const key of keys) layout.measure(key, Number(key) % 3 ? 20 : 1400)
  const metrics = { scrollTop: 0, contentTop: 36, clientHeight: 800, clientWidth: 600, scrollHeight: layout.totalHeight() + 52 }
  for (const progress of [0, 0.001, 0.1, 0.5, 0.9, 0.999, 1]) {
    const scrollTop = logScrollOffset(layout, metrics, progress)
    const logical = logScrollbarMetrics(layout, { ...metrics, scrollTop })
    assert.ok(Math.abs(scrollbarGeometry(logical, 784).progress - progress) < 1e-6)
  }
})

test('同一批日志在短日志区与长日志区切换，滑块长度不变', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(Array.from({ length: 100 }, (_, index) => `${index}`))
  layout.measure('50', 2000)
  const metrics = { scrollTop: 0, contentTop: 0, clientHeight: 200, clientWidth: 600, scrollHeight: layout.totalHeight() }
  const shortRows = scrollbarGeometry(logScrollbarMetrics(layout, metrics), 784)
  const longRow = scrollbarGeometry(logScrollbarMetrics(layout, { ...metrics, scrollTop: 1500 }), 784)
  assert.equal(longRow.height, shortRows.height, '滚动位置改变不能改变滑块长度')
  assert.ok(longRow.top > shortRows.top)
})

test('测量与重测不影响滑块尺寸，记录总量和视口变化仍会调整尺寸', () => {
  const layout = createVirtualListLayout(20)
  const keys = Array.from({ length: 100 }, (_, index) => `${index}`)
  layout.setItems(keys)
  const metrics = { scrollTop: 0, contentTop: 0, clientHeight: 200, clientWidth: 600, scrollHeight: layout.totalHeight() }
  const size = () => scrollbarGeometry(logScrollbarMetrics(layout, metrics), 784).height
  const original = size()
  for (const key of keys) layout.measure(key, 2000)
  assert.equal(size(), original)
  layout.forgetHeights()
  assert.equal(size(), original)
  layout.setItems([...keys, ...keys.map(key => `new-${key}`)])
  assert.equal(size(), original / 2)
  metrics.clientHeight *= 2
  assert.equal(size(), original)
  layout.setEstimatedHeight(40)
  assert.equal(size(), original / 2)
})

test('仅一条超长日志时滑块仍有可拖动空间，顶底端点正确', () => {
  const layout = createVirtualListLayout(20)
  layout.setItems(['long'])
  layout.measure('long', 2000)
  const metrics = { scrollTop: 0, contentTop: 0, clientHeight: 200, clientWidth: 600, scrollHeight: 2000 }
  let height: number | undefined
  for (const progress of [0, 0.5, 1]) {
    const scrollTop = logScrollOffset(layout, metrics, progress)
    const geometry = scrollbarGeometry(logScrollbarMetrics(layout, { ...metrics, scrollTop }), 784)
    height ??= geometry.height
    assert.equal(geometry.height, height)
    assert.ok(geometry.height < 784)
    assert.ok(Math.abs(geometry.progress - progress) < 1e-6)
  }
})

test('拖拽使用固定轨道比例，最小滑块与轨道高度均有限制', () => {
  assert.ok(Math.abs(draggedProgress(0.6, -200, 500) - 0.2) < 1e-12)
  assert.equal(draggedProgress(0.6, -1000, 500), 0)
  assert.equal(draggedProgress(0.6, 1000, 500), 1)
  const geometry = scrollbarGeometry({ offset: 300, viewport: 1, total: 10000 }, 784)
  assert.equal(geometry.height, 28)
  assert.equal(scrollbarGeometry({ offset: 0, viewport: 1, total: 10000 }, 10).height, 10)
  assert.deepEqual(scrollbarGeometry({ offset: 0, viewport: 0, total: 0 }, 784), { progress: 0, height: 28, top: 0 })
})
