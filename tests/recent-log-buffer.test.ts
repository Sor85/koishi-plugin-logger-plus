import test from 'node:test'
import assert from 'node:assert/strict'
import { RecentLogBuffer } from '../src/recent-log-buffer'

test('最近日志缓存只保留固定数量的最新记录', () => {
  const buffer = new RecentLogBuffer<number>(3)

  buffer.push(1)
  buffer.push(2)
  buffer.push(3)
  buffer.push(4)
  buffer.push(5)

  assert.deepEqual(buffer.values(), [3, 4, 5])
})

test('读取最近日志时返回独立数组', () => {
  const buffer = new RecentLogBuffer<number>(2)
  buffer.push(1)
  buffer.push(2)

  const records = buffer.values()
  records.push(3)

  assert.deepEqual(buffer.values(), [1, 2])
})
