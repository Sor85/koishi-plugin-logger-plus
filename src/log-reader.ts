import { FileHandle, open } from 'fs/promises'
import { Buffer } from 'buffer'
import { Logger } from 'koishi'

const NEWLINE = 0x0a
const DEFAULT_CHUNK_SIZE = 64 * 1024

/**
 * 按位置精确读取一段字节。
 *
 * `read` 允许只读到一部分，正常文件几乎不会发生，但文件在读的过程中被截断时会；此时返回实际读到
 * 的那一段，交给上层当作「文件到这里就没了」处理，而不是把未初始化的内存当成日志内容。
 */
async function readExact(handle: FileHandle, position: number, length: number) {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  return offset === length ? buffer : buffer.subarray(0, offset)
}

/**
 * 从文件末尾往前逐行读取，跳过空行。
 *
 * 日志页要的永远是「最新的若干条」，而顺读要先把整个文件读完才知道末尾在哪：单个文件可以按
 * `maxSize` 涨到几十兆、单次查询又会跨上百个文件，于是内存占用跟历史总量成正比。倒读能在凑够
 * 一页之后立刻停下，峰值内存只跟分块大小有关，与文件大小和文件数量都无关。
 *
 * 切分按字节而不是按字符：UTF-8 的续字节都 >= 0x80，永远不会等于 `\n`(0x0A)，所以在字节层面找
 * 换行不会把中文这类多字节字符切成乱码。分块边界上剩下的那一段是被切断的半行，必须留到下一块
 * 拼回来才能解码。
 */
export async function* readLinesBackward(path: string, chunkSize = DEFAULT_CHUNK_SIZE) {
  const handle = await open(path, 'r')
  try {
    let position = (await handle.stat()).size
    let rest = Buffer.alloc(0)
    while (position > 0) {
      const length = Math.min(chunkSize, position)
      position -= length
      const chunk = await readExact(handle, position, length)
      const buffer = rest.length ? Buffer.concat([chunk, rest]) : chunk
      let end = buffer.length
      while (end > 0) {
        const index = buffer.lastIndexOf(NEWLINE, end - 1)
        if (index < 0) break
        const line = buffer.subarray(index + 1, end).toString('utf8')
        if (line) yield line
        end = index
      }
      rest = buffer.subarray(0, end)
    }
    // 文件第一行前面没有换行可依，循环结束时它还留在 rest 里
    const first = rest.toString('utf8')
    if (first) yield first
  } finally {
    await handle.close()
  }
}

/** 单行 JSON 解析。进程被杀时最后一行可能只写了一半，这种残行直接丢掉。 */
export function parseRecord(line: string): Logger.Record | undefined {
  try {
    return JSON.parse(line) as Logger.Record
  } catch {}
}

/** 从文件末尾往前逐条读取日志记录，顺序从新到旧。 */
export async function* readRecordsBackward(path: string, chunkSize?: number) {
  for await (const line of readLinesBackward(path, chunkSize)) {
    const record = parseRecord(line)
    if (record) yield record
  }
}
