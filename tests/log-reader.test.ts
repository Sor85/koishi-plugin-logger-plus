import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseRecord, readLinesBackward, readRecordsBackward } from '../src/log-reader'

async function withFile(content: string | Buffer, callback: (path: string) => Promise<void>) {
  const baseDir = await mkdtemp(join(tmpdir(), 'logger-plus-reader-'))
  const path = join(baseDir, 'sample.log')
  try {
    await writeFile(path, content)
    await callback(path)
  } finally {
    await rm(baseDir, { recursive: true, force: true })
  }
}

async function collect(iterable: AsyncIterable<string>) {
  const lines: string[] = []
  for await (const line of iterable) lines.push(line)
  return lines
}

test('从文件末尾往前逐行读取', async () => {
  await withFile('first\nsecond\nthird\n', async (path) => {
    assert.deepEqual(await collect(readLinesBackward(path)), ['third', 'second', 'first'])
  })
})

test('结尾没有换行时仍能读到最后一行', async () => {
  await withFile('first\nsecond', async (path) => {
    assert.deepEqual(await collect(readLinesBackward(path)), ['second', 'first'])
  })
})

test('空行和空文件不产生结果', async () => {
  await withFile('\n\nonly\n\n\n', async (path) => {
    assert.deepEqual(await collect(readLinesBackward(path)), ['only'])
  })
  await withFile('', async (path) => {
    assert.deepEqual(await collect(readLinesBackward(path)), [])
  })
})

test('分块边界切断多字节字符时不产生乱码', async () => {
  // 按字节倒读必然会在分块处切开中文，拼不回去就是一行乱码；分块取 7 字节确保切在字符中间
  const lines = ['插件加载完成', '数据库连接失败：超时', 'gemini 平台就绪']
  await withFile(lines.join('\n') + '\n', async (path) => {
    assert.deepEqual(await collect(readLinesBackward(path, 7)), [...lines].reverse())
  })
})

test('分块边界正好落在换行上也不丢行', async () => {
  const content = 'aaaa\nbbbb\ncccc\n'
  await withFile(content, async (path) => {
    // 5 字节一块，每块正好以换行结尾
    assert.deepEqual(await collect(readLinesBackward(path, 5)), ['cccc', 'bbbb', 'aaaa'])
  })
})

test('行数远超分块大小时逐行完整读出', async () => {
  const total = 5000
  const lines = Array.from({ length: total }, (_, offset) => `line-${offset + 1}`)
  await withFile(lines.join('\n') + '\n', async (path) => {
    const read = await collect(readLinesBackward(path, 64))
    assert.equal(read.length, total)
    assert.equal(read[0], `line-${total}`)
    assert.equal(read[total - 1], 'line-1')
  })
})

test('残缺的 JSON 行被跳过而不中断读取', async () => {
  // 进程被杀时最后一行只写了一半，这种残行不该让整页日志失败
  const content = '{"id":1,"content":"a"}\n{"id":2,"cont\n{"id":3,"content":"c"}\n'
  await withFile(content, async (path) => {
    const records: unknown[] = []
    for await (const record of readRecordsBackward(path)) records.push(record)

    assert.deepEqual(records, [{ id: 3, content: 'c' }, { id: 1, content: 'a' }])
  })
})

test('单行解析失败时返回空值', () => {
  assert.deepEqual(parseRecord('{"id":1}'), { id: 1 } as any)
  assert.equal(parseRecord('{"id":1'), undefined)
  assert.equal(parseRecord('not json'), undefined)
})

test('提前结束遍历时关闭文件句柄', async () => {
  const lines = Array.from({ length: 1000 }, (_, offset) => `line-${offset + 1}`)
  await withFile(lines.join('\n') + '\n', async (path) => {
    const read: string[] = []
    for await (const line of readLinesBackward(path, 32)) {
      read.push(line)
      if (read.length === 3) break
    }

    assert.deepEqual(read, ['line-1000', 'line-999', 'line-998'])
    // 凑够一页就中断是常态，句柄漏在这里的话，长期运行的进程会被筛选操作耗尽 fd
    assert.deepEqual(process.getActiveResourcesInfo().filter(name => name === 'FileHandle'), [])
  })
})
