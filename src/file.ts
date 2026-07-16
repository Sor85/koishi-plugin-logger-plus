import { FileHandle, open } from 'fs/promises'
import { Logger } from 'koishi'
import { Buffer } from 'buffer'

const MAX_BATCH_SIZE = 64 * 1024

export class FileWriter {
  public task: Promise<FileHandle>
  public size = 0

  private temp: string[] = []
  private tempSize = 0
  private scheduled = false

  constructor(public date: string, public path: string) {
    this.task = open(path, 'a+').then(async (handle) => {
      this.size += (await handle.stat()).size
      return handle
    })
  }

  flush() {
    this.scheduled = false
    if (!this.temp.length) return
    const content = Buffer.from(this.temp.join(''))
    this.temp = []
    this.tempSize = 0
    this.task = this.task.then(async (handle) => {
      await handle.write(content)
      return handle
    })
  }

  async sync() {
    this.flush()
    await this.task
  }

  write(record: Logger.Record) {
    const content = JSON.stringify(record) + '\n'
    const size = Buffer.byteLength(content)
    this.temp.push(content)
    this.tempSize += size
    this.size += size
    if (this.tempSize >= MAX_BATCH_SIZE) {
      this.flush()
      return
    }
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => this.flush())
  }

  async close() {
    await this.sync()
    const handle = await this.task
    await handle.close()
  }
}
