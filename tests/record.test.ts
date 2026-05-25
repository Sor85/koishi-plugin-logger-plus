import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Logger } from 'koishi'
import { createLogRecordHandler } from '../src/record'

function createRecord(scope: object): Logger.Record {
  return {
    id: 1,
    timestamp: 1000,
    type: 'info',
    level: 2,
    name: 'demo',
    content: 'started',
    meta: { [Context.current]: { scope } },
  } as Logger.Record
}

test('插件刚重启时先延后解析日志路径，避免启动日志丢失插件筛选路径', async () => {
  const scope = {}
  let ready = false
  const commits: Logger.Record[] = []
  const handler = createLogRecordHandler({
    paths(target: object) {
      assert.equal(target, scope)
      return ready ? ['demo-path'] : []
    },
  }, record => commits.push(record))

  handler(createRecord(scope))

  assert.equal(commits.length, 0)

  ready = true
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0].meta.paths, ['demo-path'])
})

test('能立即解析插件路径时直接写入日志', () => {
  const scope = {}
  const commits: Logger.Record[] = []
  const handler = createLogRecordHandler({
    paths() {
      return ['demo-path']
    },
  }, record => commits.push(record))

  handler(createRecord(scope))

  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0].meta.paths, ['demo-path'])
})

test('延后后仍无法解析插件路径时也保留日志', async () => {
  const scope = {}
  const commits: Logger.Record[] = []
  const handler = createLogRecordHandler({
    paths() {
      return []
    },
  }, record => commits.push(record))

  handler(createRecord(scope))

  assert.equal(commits.length, 0)

  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0].meta.paths, [])
})
