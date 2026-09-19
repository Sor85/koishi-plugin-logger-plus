import test from 'node:test'
import assert from 'node:assert/strict'
import { compareLogRecords, decodeLogCursor, encodeLogIdentity, isBeforeCursor } from '../src/log-identity'

test('同一记录得到同一标识，不同记录标识不同', () => {
  assert.equal(encodeLogIdentity({ timestamp: 1000, id: 1 }), encodeLogIdentity({ timestamp: 1000, id: 1 }))
  assert.notEqual(encodeLogIdentity({ timestamp: 1000, id: 1 }), encodeLogIdentity({ timestamp: 1000, id: 2 }))
  assert.notEqual(encodeLogIdentity({ timestamp: 1000, id: 1 }), encodeLogIdentity({ timestamp: 2000, id: 1 }))
})

test('身份编码即游标编码，wire 格式保持 timestamp:id 不变', () => {
  // 唯一锁定编码格式的断言：客户端与服务端共用此函数，一致性由构造保证，无需额外跨端 diff
  assert.equal(encodeLogIdentity({ timestamp: 1747126800000, id: 42 }), '1747126800000:42')
})

test('记录先后：同时间戳按序号排序', () => {
  const records = [
    { timestamp: 1000, id: 3 },
    { timestamp: 1000, id: 1 },
    { timestamp: 1000, id: 2 },
  ]
  assert.deepEqual([...records].sort(compareLogRecords).map(encodeLogIdentity), ['1000:1', '1000:2', '1000:3'])
})

test('记录先后：跨重启序号回绕时仍按时间戳主导', () => {
  // 进程重启让 id 从头计数：靠 id 会把新日志排到旧日志前，必须以时间戳为主
  const older = { timestamp: 1000, id: 900 }
  const newerAfterRestart = { timestamp: 2000, id: 1 }
  assert.ok(compareLogRecords(older, newerAfterRestart) < 0)
  assert.deepEqual([newerAfterRestart, older].sort(compareLogRecords).map(encodeLogIdentity), ['1000:900', '2000:1'])
})

test('游标编码→解析往返回到同一身份', () => {
  const identity = { timestamp: 1747126800000, id: 42 }
  assert.deepEqual(decodeLogCursor(encodeLogIdentity(identity)), identity)
})

test('非法游标解析为 null，不再依赖 NaN 比较', () => {
  assert.equal(decodeLogCursor('not-a-cursor'), null)
  assert.equal(decodeLogCursor('1000'), null)
  assert.equal(decodeLogCursor('1000:2:3'), null)
  assert.equal(decodeLogCursor('abc:def'), null)
  // 空段不能靠 Number('')===0 蒙混成合法身份
  assert.equal(decodeLogCursor(':5'), null)
  assert.equal(decodeLogCursor('1000:'), null)
})

test('是否早于游标：正确区分早于、等于与晚于', () => {
  const cursor = encodeLogIdentity({ timestamp: 2000, id: 5 })
  // 早于：时间戳更小，或同时间戳序号更小
  assert.equal(isBeforeCursor({ timestamp: 1000, id: 99 }, cursor), true)
  assert.equal(isBeforeCursor({ timestamp: 2000, id: 4 }, cursor), true)
  // 等于游标自身不算早于，翻页不会重复取到游标那条
  assert.equal(isBeforeCursor({ timestamp: 2000, id: 5 }, cursor), false)
  // 晚于
  assert.equal(isBeforeCursor({ timestamp: 2000, id: 6 }, cursor), false)
  assert.equal(isBeforeCursor({ timestamp: 3000, id: 1 }, cursor), false)
})

test('缺失游标时全部记录通过，从最新开始读取', () => {
  assert.equal(isBeforeCursor({ timestamp: 1000, id: 1 }, undefined), true)
  assert.equal(isBeforeCursor({ timestamp: Number.MAX_SAFE_INTEGER, id: 1 }, undefined), true)
})

test('非法游标得到明确空结果：无记录通过，而非返回全部历史', () => {
  assert.equal(isBeforeCursor({ timestamp: 1000, id: 1 }, 'garbage'), false)
  assert.equal(isBeforeCursor({ timestamp: Number.MAX_SAFE_INTEGER, id: 1 }, 'garbage'), false)
})
