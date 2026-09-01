import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config } from '../src'

test('单个日志文件最大大小默认值为 1048576', async () => {
  const fields = Reflect.get(Config, 'dict')
  const maxSize = Reflect.get(fields, 'maxSize')
  const meta = Reflect.get(maxSize, 'meta')
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

  // 默认值别再往小改：10 KB 一换文件时，一次日志刷屏一天就能造出十万个文件，
  // 而按文件数伸缩的代码在那个量级会出事（见 CONSTRAINTS.md 的日志文件规模约束）。
  assert.equal(meta.default, 1048576)
  assert.match(readme, /\|\s*`maxSize`\s*\|\s*`1048576`\s*\|/)
})
