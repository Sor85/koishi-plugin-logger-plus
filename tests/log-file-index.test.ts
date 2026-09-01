import test from 'node:test'
import assert from 'node:assert/strict'
import { Time } from 'koishi'
import { isMissingFileError, LogFileIndex } from '../src/log-file-index'

function createFilenames(date: string, count: number) {
  return Array.from({ length: count }, (_, offset) => `${date}-${offset + 1}.log`)
}

test('单日文件数十万级时仍能分配下一个序号', () => {
  // 旧写法 `Math.max(...indexes[date])` 在这个量级直接 RangeError，而它跑在「写一条日志」的
  // 路径上，一崩就是进程反复重启。
  const index = new LogFileIndex(createFilenames('2026-09-01', 200_000))

  assert.equal(index.allocate('2026-09-01'), 200_001)
  assert.equal(index.allocate('2026-09-01'), 200_002)
})

test('没有历史文件的日期从 1 号开始分配', () => {
  const index = new LogFileIndex()

  assert.equal(index.allocate('2026-09-01'), 1)
  assert.equal(index.allocate('2026-09-01'), 2)
})

test('序号不连续时按最大值继续分配', () => {
  const index = new LogFileIndex(['2026-09-01-3.log', '2026-09-01-1.log', '备注.txt'])

  assert.equal(index.allocate('2026-09-01'), 4)
})

test('清单副本被外部修改不影响后续分配与读取', () => {
  const index = new LogFileIndex(['2026-09-01-1.log'])

  index.entries('2026-09-01')[0].indexes.push(99)

  assert.deepEqual(index.entries('2026-09-01'), [{ date: '2026-09-01', indexes: [1] }])
  assert.equal(index.allocate('2026-09-01'), 2)
})

test('过期日期交出之后清单里不再有它', () => {
  const now = Date.parse('2026-09-01T00:00:00.000Z')
  const index = new LogFileIndex(['2026-07-01-1.log', '2026-07-01-2.log', '2026-08-31-1.log'])

  assert.deepEqual(index.takeExpired(30, now), [{ date: '2026-07-01', indexes: [1, 2] }])
  // 并发的第二次清理拿到空清单，因此同一批文件不会被删第二遍，也就不会刷出一堆「文件不存在」。
  assert.deepEqual(index.takeExpired(30, now), [])
  assert.deepEqual(index.entries(), [{ date: '2026-08-31', indexes: [1] }])
})

test('刚好到保留天数的日期不算过期', () => {
  const date = '2026-08-02'
  const index = new LogFileIndex([`${date}-1.log`])
  const now = Date.parse(`${date}T00:00:00.000Z`) + 30 * Time.day - 1

  assert.deepEqual(index.takeExpired(30, now), [])
})

test('保留天数为 0 时不清理任何日期', () => {
  const index = new LogFileIndex(['2020-01-01-1.log'])

  assert.deepEqual(index.takeExpired(0, Date.parse('2026-09-01T00:00:00.000Z')), [])
  assert.deepEqual(index.takeExpired(undefined, Date.parse('2026-09-01T00:00:00.000Z')), [])
})

test('只有文件不存在才算可以忽略的错误', () => {
  assert.equal(isMissingFileError(Object.assign(new Error('missing'), { code: 'ENOENT' })), true)
  assert.equal(isMissingFileError(Object.assign(new Error('denied'), { code: 'EACCES' })), false)
  assert.equal(isMissingFileError(new Error('plain')), false)
  assert.equal(isMissingFileError(undefined), false)
})
