import test from 'node:test'
import assert from 'node:assert/strict'
import { Logger } from 'koishi'
import { getLogKey, mergeLogRecords } from '../client/log-record'

function createRecord(id: number, timestamp: number): Logger.Record {
  return {
    id,
    timestamp,
    type: 'info',
    name: 'app',
    content: `${timestamp}:${id}`,
    meta: {},
  } as Logger.Record
}

test('日志稳定标识同时包含时间戳和 id', () => {
  assert.equal(getLogKey(createRecord(1, 1000)), '1000:1')
})

test('合并日志时去重并保持时间顺序', () => {
  const records = [
    createRecord(2, 2000),
    createRecord(3, 3000),
  ]
  const incoming = [
    createRecord(1, 1000),
    createRecord(2, 2000),
  ]

  assert.deepEqual(mergeLogRecords(records, incoming).map(getLogKey), ['1000:1', '2000:2', '3000:3'])
})
