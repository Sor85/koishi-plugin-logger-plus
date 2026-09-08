import test from 'node:test'
import assert from 'node:assert/strict'
import { getRecordPaths, hasLogFilter, isLogType, matchesLogFilter, stripAnsi } from '../src/log-filter'

function createRecord(options: Partial<{ name: string, type: string, content: string, paths: string[] }> = {}) {
  return {
    name: options.name ?? 'app',
    type: options.type ?? 'info',
    content: options.content ?? 'hello world',
    meta: { paths: options.paths ?? ['plugin.alpha'] },
  }
}

test('没有任何条件时不算启用筛选', () => {
  assert.equal(hasLogFilter({}), false)
  assert.equal(hasLogFilter({ path: '', type: '', search: '' }), false)
  assert.equal(hasLogFilter({ search: 'error' }), true)
  assert.equal(hasLogFilter({ type: 'debug' }), true)
})

test('空条件匹配任何日志', () => {
  assert.equal(matchesLogFilter(createRecord(), {}), true)
})

test('按插件路径筛选只保留对应插件的日志', () => {
  const record = createRecord({ paths: ['plugin.alpha', 'plugin.beta'] })

  assert.equal(matchesLogFilter(record, { path: 'plugin.beta' }), true)
  assert.equal(matchesLogFilter(record, { path: 'plugin.gamma' }), false)
})

test('缺少 meta 的日志按无插件路径处理', () => {
  assert.deepEqual(getRecordPaths({}), [])
  assert.deepEqual(getRecordPaths({ meta: {} }), [])
  assert.equal(matchesLogFilter({ name: 'app', type: 'info', content: 'x' }, { path: 'plugin.alpha' }), false)
})

test('按等级筛选只保留同一等级的日志', () => {
  assert.equal(matchesLogFilter(createRecord({ type: 'debug' }), { type: 'debug' }), true)
  assert.equal(matchesLogFilter(createRecord({ type: 'info' }), { type: 'debug' }), false)
  assert.equal(matchesLogFilter(createRecord({ type: 'error' }), { type: 'error' }), true)
})

test('只接受已知的日志等级', () => {
  assert.equal(isLogType('debug'), true)
  assert.equal(isLogType('error'), true)
  assert.equal(isLogType('trace'), false)
  assert.equal(isLogType(''), false)
  assert.equal(isLogType(undefined), false)
})

test('关键词搜索忽略大小写并覆盖日志名称', () => {
  const record = createRecord({ name: 'gemini', content: 'Timeout waiting for platform' })

  assert.equal(matchesLogFilter(record, { search: 'TIMEOUT' }), true)
  assert.equal(matchesLogFilter(record, { search: 'GEMINI' }), true)
  assert.equal(matchesLogFilter(record, { search: 'not-exist' }), false)
})

test('关键词搜索跳过内容里的 ANSI 颜色码', () => {
  const record = createRecord({ content: 'plat\u001b[31mform gemini\u001b[0m' })

  assert.equal(stripAnsi(record.content), 'platform gemini')
  assert.equal(matchesLogFilter(record, { search: 'platform' }), true)
})

test('多个条件同时生效', () => {
  const record = createRecord({ type: 'error', content: 'load failed', paths: ['plugin.alpha'] })

  assert.equal(matchesLogFilter(record, { path: 'plugin.alpha', type: 'error', search: 'load' }), true)
  assert.equal(matchesLogFilter(record, { path: 'plugin.alpha', type: 'warn', search: 'load' }), false)
  assert.equal(matchesLogFilter(record, { path: 'plugin.beta', type: 'error', search: 'load' }), false)
  assert.equal(matchesLogFilter(record, { path: 'plugin.alpha', type: 'error', search: 'timeout' }), false)
})
