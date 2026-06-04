import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'fs/promises'

test('日志行使用时间戳和 id 作为稳定渲染 key', async () => {
  const source = await readFile(new URL('../client/logs.vue', import.meta.url), 'utf8')

  assert.match(source, /:key="getLogKey\(record\)"/)
  assert.match(source, /:data-log-key="getLogKey\(record\)"/)
})

test('日志列表定义自定义滚动条样式', async () => {
  const source = await readFile(new URL('../client/logs.vue', import.meta.url), 'utf8')

  assert.match(source, /scrollbar-width:\s*auto/)
  assert.match(source, /&::[-\w]+scrollbar\s*\{[\s\S]*width:\s*1rem;[\s\S]*height:\s*1rem;/)
  assert.match(source, /&::[-\w]+scrollbar-thumb/)
})

test('日志列表滚动容器使用 border-box 计算 padding', async () => {
  const source = await readFile(new URL('../client/logs.vue', import.meta.url), 'utf8')

  assert.match(source, /\.log-list\s*\{[\s\S]*box-sizing:\s*border-box;/)
})
