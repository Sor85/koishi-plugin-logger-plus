import type Logger from 'reggol'
import { getLogKey } from './log-record'

export interface LogTextLayout {
  columns: number
  lineHeight: number
  separatorHeight: number
}

interface CachedText {
  name: string
  content: string
  widths: number[]
  columns?: number
  lines?: number
}

// 与日志展示的日期、等级前缀及换行缩进保持一致。
export const logPrefixColumns = 24
const scanBudget = 16_384

function characterColumns(code: number, character: string) {
  if (code < 0x20 || code === 0x7f) return 0
  if (code < 0x7f) return 1
  if (/\p{Mark}/u.test(character) || code === 0x200d || code === 0xfe0f) return 0
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe6f)
    || (code >= 0xff01 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f000 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3ffff) ? 2 : 1
}

/**
 * 缓存原始文本行的显示列数，而不是某个宽度下的像素高度。
 * CJK/Emoji 采用宽字符近似，ANSI 不占列；宽度变化只重新累加换行数，不再次扫描正文。
 * 单条大 JSON 也按字符预算让出事件循环，不能仅在记录之间分批。
 */
function* textWidths(record: Logger.Record) {
  const widths: number[] = []
  let width = logPrefixColumns
  let scanned = 0
  // 第一行包含来源名和正文前的空格；正文后续行只有固定缩进。
  for (const text of [record.name, ' ', record.content]) {
    let ansi = false
    let carriageReturn = false
    for (const character of text) {
      if (++scanned >= scanBudget) {
        scanned = 0
        yield
      }
      const code = character.codePointAt(0)!
      if (code === 0x1b) {
        ansi = true
        continue
      }
      if (ansi) {
        if (character !== '[' && code >= 0x40 && code <= 0x7e) ansi = false
        continue
      }
      if (character === '\n' && carriageReturn) {
        carriageReturn = false
        continue
      }
      carriageReturn = character === '\r'
      if (character === '\n' || carriageReturn) {
        widths.push(width)
        width = logPrefixColumns
      } else if (character === '\t') {
        width += 8 - width % 8
      } else {
        width += characterColumns(code, character)
      }
    }
  }
  widths.push(width)
  return widths
}

export function createLogHeightEstimator(yieldTask: () => Promise<void>) {
  const cache = new Map<string, CachedText>()
  let revision = 0
  let disposed = false

  return {
    async prepare(records: readonly Logger.Record[], layout: LogTextLayout): Promise<number[] | undefined> {
      if (disposed) return
      const current = ++revision
      const obsolete = () => disposed || current !== revision
      const heights: number[] = []
      const columns = Math.max(1, layout.columns)
      const lineHeight = Math.max(1, layout.lineHeight)
      let work = 0
      for (let index = 0; index < records.length; index++) {
        if (obsolete()) return
        const record = records[index]
        const key = getLogKey(record)
        let entry = cache.get(key)
        if (!entry || entry.name !== record.name || entry.content !== record.content) {
          const scan = textWidths(record)
          let result = scan.next()
          while (!result.done) {
            await yieldTask()
            if (obsolete()) return
            result = scan.next()
          }
          entry = { name: record.name, content: record.content, widths: result.value }
          cache.set(key, entry)
          work += record.name.length + record.content.length
        }
        if (entry.columns !== columns) {
          let lines = 0
          for (const width of entry.widths) {
            lines += Math.max(1, Math.ceil(width / columns))
            if (++work >= scanBudget) {
              work = 0
              await yieldTask()
              if (obsolete()) return
            }
          }
          entry.columns = columns
          entry.lines = lines
        }
        const start = index > 0 && records[index - 1].id > record.id && record.name === 'app'
        heights.push(entry.lines! * lineHeight + (start ? layout.separatorHeight : 0))
        if (++work >= scanBudget) {
          work = 0
          await yieldTask()
          if (obsolete()) return
        }
      }
      // 缓存只保留本次清单，卸载历史或切换日期后不继续持有大段正文。
      const active = new Set(records.map(getLogKey))
      for (const key of cache.keys()) if (!active.has(key)) cache.delete(key)
      return heights
    },
    dispose() {
      disposed = true
      revision++
      cache.clear()
    },
  }
}
