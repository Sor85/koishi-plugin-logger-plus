/**
 * 日志身份。
 *
 * 一条日志由「时间戳加序号」构成的稳定标识，同时承担渲染标识、合并去重键、视口锚点与分页游标
 * 四种用途，其先后比较与游标编解码都基于它。此前这套值语义有多份独立实现：客户端一份身份编码
 * 与内联排序，服务端一份格式相同的游标编码、一份先后比较、一份游标解析。客户端用身份编码生成
 * 游标发给服务端，服务端用另一份实现生成下一游标回传，两份必须逐字符对齐，全靠人工维持。
 *
 * 这里把身份的值语义收口为一处：身份编码即游标编码（同一个函数），记录先后比较集中一处，
 * 游标解析与「是否早于游标」判定集中一处。客户端与服务端共享同一份实现，跨 JSON 边界的游标
 * 契约由构造保证同口径，不再靠两份实现人工对齐。
 *
 * module 只持有值语义本身，使用结构类型（时间戳与序号两个字段），不绑定客户端或服务端各自的
 * 日志记录类型；客户端的合并去重、记录截断与服务端的数组排序包装仍留在各自原处，只消费这里的
 * 身份与次序。
 */

/** 参与身份计算的最小结构：时间戳与序号。`Logger.Record` 天然满足，两端都能引用。 */
export interface LogIdentity {
  timestamp: number
  id: number
}

/**
 * 身份编码，同时就是游标编码。
 *
 * 客户端据此生成的分页游标与服务端理解、回传的游标因为共用此函数而天然同口径；渲染标识、
 * 去重键与视口锚点也用它。wire 格式为 `timestamp:id`，本次收口保持不变，已发出的游标继续有效。
 */
export function encodeLogIdentity(identity: LogIdentity): string {
  return `${identity.timestamp}:${identity.id}`
}

/**
 * 记录先后：时间戳主导，序号做次级键。
 *
 * 进程重启会让 id 从头计数，只靠 id 排不出跨重启的先后，必须以时间戳为主。返回值遵循
 * `Array.prototype.sort` 的比较约定，合并排序与分页判定共用这一次序。
 */
export function compareLogRecords(left: LogIdentity, right: LogIdentity): number {
  return left.timestamp - right.timestamp || left.id - right.id
}

/**
 * 解析游标为身份；非法游标返回 `null`。
 *
 * 用显式判断取代此前依赖 `NaN` 比较的偶然行为：游标必须恰好是 `timestamp:id` 两段且都为有限
 * 数字，否则视为非法。缺失游标不走这里，由 `isBeforeCursor` 单独处理为「从最新开始」。
 */
export function decodeLogCursor(cursor: string): LogIdentity | null {
  const parts = cursor.split(':')
  // 空段（如 `:5`、`1000:`）不能靠 Number('')===0 蒙混成合法身份，显式判空
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const timestamp = Number(parts[0])
  const id = Number(parts[1])
  if (!Number.isFinite(timestamp) || !Number.isFinite(id)) return null
  return { timestamp, id }
}

/**
 * 记录是否早于游标。
 *
 * 缺失游标表示从最新日志开始读取，全部记录通过；非法游标显式返回「不通过」，读取因此得到空页
 * 而非全部历史，也不抛错。合法游标按 `compareLogRecords` 判定严格早于。
 */
export function isBeforeCursor(record: LogIdentity, cursor?: string): boolean {
  if (!cursor) return true
  const identity = decodeLogCursor(cursor)
  if (!identity) return false
  return compareLogRecords(record, identity) < 0
}
