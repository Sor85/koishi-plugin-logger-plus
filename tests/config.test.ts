import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config } from '../src'

test('单个日志文件最大大小默认值为 10240', async () => {
  const fields = Reflect.get(Config, 'dict')
  const maxSize = Reflect.get(fields, 'maxSize')
  const meta = Reflect.get(maxSize, 'meta')
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

  assert.equal(meta.default, 10240)
  assert.match(readme, /\|\s*`maxSize`\s*\|\s*`10240`\s*\|/)
})
