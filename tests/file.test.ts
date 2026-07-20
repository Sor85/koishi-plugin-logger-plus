import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from 'koishi'
import { FileWriter } from '../src/file'

function createRecord(id: number): Logger.Record {
  return {
    id,
    timestamp: id,
    type: 'info',
    level: 2,
    name: 'perf',
    content: `record ${id}`,
    meta: {},
  } as Logger.Record
}

test('同一轮同步写入只安排一个文件任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logger-plus-file-'))
  const path = join(root, 'logs.log')
  const writer = new FileWriter('2026-07-15', path)

  try {
    await writer.task
    const initialTask = writer.task

    for (let id = 0; id < 100; id++) writer.write(createRecord(id))

    assert.equal(writer.task, initialTask)
    await writer.sync()

    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 100)
  } finally {
    await writer.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('待写内容达到批次上限时立即安排文件任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logger-plus-file-'))
  const path = join(root, 'logs.log')
  const writer = new FileWriter('2026-07-15', path)

  try {
    await writer.task
    const initialTask = writer.task
    const record = createRecord(1)
    record.content = 'x'.repeat(1024)

    for (let id = 0; id < 100; id++) writer.write(record)

    assert.notEqual(writer.task, initialTask)
    await writer.sync()
  } finally {
    await writer.close()
    await rm(root, { recursive: true, force: true })
  }
})
