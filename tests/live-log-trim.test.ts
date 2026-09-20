import test from 'node:test'
import assert from 'node:assert/strict'
import { holdLiveLogTrim, liveLogTrimLimit } from '../client/live-log-trim'

test('无人挂起时使用常规上限', () => {
  assert.equal(liveLogTrimLimit(1000, 5000), 1000)
})

test('挂起期间放宽到硬上限，释放后恢复常规上限', () => {
  const release = holdLiveLogTrim()
  assert.equal(liveLogTrimLimit(1000, 5000), 5000)
  release()
  assert.equal(liveLogTrimLimit(1000, 5000), 1000)
})

test('多处挂起要全部释放才恢复裁剪', () => {
  const first = holdLiveLogTrim()
  const second = holdLiveLogTrim()
  first()
  assert.equal(liveLogTrimLimit(1000, 5000), 5000)
  second()
  assert.equal(liveLogTrimLimit(1000, 5000), 1000)
})

test('重复释放同一个闸不会把计数减穿', () => {
  const release = holdLiveLogTrim()
  release()
  release()
  const other = holdLiveLogTrim()
  assert.equal(liveLogTrimLimit(1000, 5000), 5000)
  other()
  assert.equal(liveLogTrimLimit(1000, 5000), 1000)
})

test('硬上限小于常规上限时不缩小缓冲', () => {
  const release = holdLiveLogTrim()
  assert.equal(liveLogTrimLimit(1000, 500), 1000)
  release()
})
