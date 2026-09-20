import test from 'node:test'
import assert from 'node:assert/strict'
import type Logger from 'reggol'
import { createLogHeightEstimator } from '../client/log-height-estimator'
import { createPreparedLogList } from '../client/prepared-log-list'

function record(content: string, id = 1, name = 'x'): Logger.Record {
  return { id, timestamp: id * 1000, type: 'info', name, content }
}
const layout = { columns: 80, lineHeight: 20, separatorHeight: 16 }

test('按换行、缩进、来源名称、宽字符和 ANSI 计算高度', async () => {
  const estimator = createLogHeightEstimator(async () => {})
  const records = [
    record('hello', 1),
    record('hello\nworld', 2),
    record('中'.repeat(40), 3),
    record('\u001b[31m' + '中'.repeat(40) + '\u001b[0m', 4),
    record('a'.repeat(55), 5),
    record('a'.repeat(54), 6),
    record('a\r\nb', 7),
    record('a\n', 8),
    record('é'.repeat(54), 9),
    record('😀'.repeat(40), 10),
    record('a'.repeat(40), 11, 'source-with-a-long-name'),
  ]
  assert.deepEqual(await estimator.prepare(records, layout), [20, 40, 40, 40, 40, 20, 40, 40, 20, 40, 40])
})

test('跨重启分隔留白与前插后的首行判定一致', async () => {
  const estimator = createLogHeightEstimator(async () => {})
  const first = record('start', 1, 'app')
  assert.deepEqual(await estimator.prepare([first], layout), [20])
  assert.deepEqual(await estimator.prepare([record('old', 100), first], layout), [20, 36])
})

test('单条大日志也分批让出；追加仅扫描新增记录，缩窄宽度复用文本缓存', async () => {
  let yields = 0
  const estimator = createLogHeightEstimator(async () => { yields++ })
  const big = record('a'.repeat(200_000))
  const wide = (await estimator.prepare([big], layout))![0]
  assert.ok(yields > 5)
  yields = 0
  await estimator.prepare([big, record('new', 2)], layout)
  assert.equal(yields, 0, '缓存命中时不能重新扫描大正文')
  const narrow = (await estimator.prepare([big, record('new', 2)], { ...layout, columns: 40 }))![0]
  assert.ok(narrow > wide)
  assert.equal(yields, 0, '宽度变化只重算缓存的行宽')
  const taller = (await estimator.prepare([big], { ...layout, lineHeight: 40 }))![0]
  assert.equal(taller, wide * 2)
})

test('同标识正文替换与卸载后重新进入均重新计算，不永久保留正文缓存', async () => {
  let yields = 0
  const estimator = createLogHeightEstimator(async () => { yields++ })
  assert.deepEqual(await estimator.prepare([record('short')], layout), [20])
  const big = record('a'.repeat(100_000))
  assert.ok((await estimator.prepare([big], layout))![0] > 20)
  await estimator.prepare([], layout)
  yields = 0
  await estimator.prepare([big], layout)
  assert.ok(yields > 0)
})

test('过期预估与卸载后未完成的扫描不能提交结果', async () => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const estimator = createLogHeightEstimator(() => wait)
  const old = estimator.prepare([record('a'.repeat(100_000))], layout)
  assert.deepEqual(await estimator.prepare([record('new', 2)], layout), [20])
  release()
  assert.equal(await old, undefined)
  estimator.dispose()
  assert.equal(await estimator.prepare([record('ignored')], layout), undefined)
})

test('分批期间保留已提交列表，新推送合并后原子提交且不重启大记录扫描', async () => {
  let release!: () => void
  let block = false
  let yields = 0
  const wait = new Promise<void>(resolve => { release = resolve })
  const commits: { records: Logger.Record[], heights: number[] }[] = []
  const prepared = createPreparedLogList({
    yieldTask: async () => { yields++; if (block) await wait },
    commit: (records, heights) => { commits.push({ records, heights }) },
  })
  const initial = record('initial')
  prepared.update([initial], layout)
  await prepared.ready()
  assert.equal(commits.length, 1)
  block = true
  const big = record('a'.repeat(100_000), 2)
  prepared.update([big, initial], layout)
  for (let i = 0; i < 20; i++) prepared.update([big, initial, record('new', 3 + i)], layout)
  assert.equal(commits.length, 1)
  block = false
  release()
  await prepared.ready()
  assert.equal(commits.length, 2)
  assert.equal(commits[1].records.at(-1)!.id, 22)
  assert.equal(commits[1].heights.length, 3)
  assert.ok(yields < 15, '连续推送不能重复从头扫描同一条大日志')
  prepared.dispose()
})

test('预估期间销毁列表不发布，完成边界的新推送也不丢失', async () => {
  const commits: number[] = []
  const prepared = createPreparedLogList({
    yieldTask: async () => {},
    commit(records) {
      commits.push(records[0].id)
      if (records[0].id === 1) queueMicrotask(() => { prepared.update([record('two', 2)], layout) })
    },
  })
  prepared.update([record('one')], layout)
  await prepared.ready()
  assert.deepEqual(commits, [1, 2])
  prepared.update([record('a'.repeat(100_000), 3)], layout)
  prepared.dispose()
  await prepared.ready()
  assert.deepEqual(commits, [1, 2])
})
