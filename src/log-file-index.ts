import { Dict, Time } from 'koishi'

const LOG_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})-(\d+)\.log$/

/** 某个日期下已经落盘的全部日志文件序号。 */
export interface LogFileGroup {
  date: string
  indexes: number[]
}

/**
 * 文件已经不在了不算错误。
 *
 * 这一条判定是「自己喂自己」那个循环的断点：清理与读取都会遇到刚被删掉的文件，而把它记成日志
 * 就要往日志文件里写一行，写满就滚动、滚动又触发清理、清理再报错——真实环境里一天就能把单日
 * 文件数推到十万量级。
 */
export function isMissingFileError(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * 日志文件清单：谁已经在磁盘上、下一个该写第几号。
 *
 * 单独成类是因为它要同时挡住两个已经发生过的故障：序号分配不能把整份清单展开成实参，过期清理
 * 不能被并发跑第二遍。两者都只在文件数很大时才现形，而那正是没人手动验证的时候。
 */
export class LogFileIndex {
  private indexes: Dict<number[]> = {}
  /**
   * 每个日期的当前最大序号单独记一份。
   *
   * 不这么记，分配下一个序号最短的写法就是 `Math.max(...indexes[date])`，而它会把整个数组当实参
   * 展开：单日文件数上万时直接 `RangeError: Maximum call stack size exceeded`。崩的位置是「写一条
   * 日志」，于是进程崩溃、重启、扫到同一批文件、再崩，成了停不下来的循环。
   */
  private maxIndexes: Dict<number> = {}

  constructor(filenames: Iterable<string> = []) {
    for (const filename of filenames) {
      const capture = LOG_FILE_PATTERN.exec(filename)
      if (!capture) continue
      this.register(capture[1], +capture[2])
    }
  }

  private register(date: string, index: number) {
    (this.indexes[date] ??= []).push(index)
    this.maxIndexes[date] = Math.max(this.maxIndexes[date] ?? 0, index)
  }

  /** 取下一个可用序号并登记，序号从 1 开始。 */
  allocate(date: string) {
    const index = (this.maxIndexes[date] ?? 0) + 1
    this.register(date, index)
    return index
  }

  /** 读取用的清单副本；不给出内部数组，避免调用方边读边改。 */
  entries(date?: string): LogFileGroup[] {
    if (date) return [{ date, indexes: [...this.indexes[date] ?? []] }]
    return Object.keys(this.indexes).map(date => ({ date, indexes: [...this.indexes[date]] }))
  }

  /**
   * 交出过期日期，**同时把它们从清单里移除**。
   *
   * 移除写在返回之前，因此并发调用第二次只会拿到空清单：删文件是异步的，旧写法在删完之后才
   * 从清单里摘掉日期，两次清理就会对同一批文件各删一遍，第二遍全是「文件不存在」的报错。
   *
   * `maxAgeDays` 为 0 或空表示不清理。
   */
  takeExpired(maxAgeDays: number | undefined, now: number): LogFileGroup[] {
    if (!maxAgeDays) return []
    const expired: LogFileGroup[] = []
    for (const date of Object.keys(this.indexes)) {
      if (now - Date.parse(date) < maxAgeDays * Time.day) continue
      expired.push({ date, indexes: this.indexes[date] })
      delete this.indexes[date]
      delete this.maxIndexes[date]
    }
    return expired
  }
}
