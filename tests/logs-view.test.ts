import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'fs/promises'

test('日志行使用时间戳和 id 作为稳定渲染 key', async () => {
  const source = await readFile(new URL('../client/logs.vue', import.meta.url), 'utf8')

  assert.match(source, /:key="getLogKey\(record\)"/)
  assert.match(source, /:data-log-key="getLogKey\(record\)"/)
})
