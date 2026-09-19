/**
 * 日志会话。
 *
 * 一次连续日志浏览里的查询条件、展示记录、分页进度与历史生命周期，全部收在这一个 module。
 * 在此之前它们散在父子两个组件里：外壳握筛选、共享历史缓存、第一页查询与卸载计时，列表组件
 * 握游标与后续页，靠复合 `:key` 自增计数把子树整棵拆掉才能重置分页。分散的后果是同一个
 * `hasMore` 在半路丢失、初始游标靠巧合对齐、迟到请求污染当前浏览都没有统一裁决处。
 *
 * 核心是纯 TypeScript：只通过注入的 `loadPage`（Console transport）、`getLiveLogs`（实时流）、
 * `schedule`（计时）与几个回调和外界打交道，不认识 Vue、DOM 或 Koishi Console 运行时，
 * 因此测试可以拿内存 adapter 控制成功/失败/响应顺序，拿可推进的时钟验证卸载，全程无 DOM。
 *
 * 三条贯穿始终的规则：
 *
 * 1. 请求有效性由 `requestId` 统一裁决。查询切换、卸载、销毁都递增它；任何 await 之后、写入
 *    当前状态之前都要重新核对，过期请求的成功、失败或结束都不得改动当前查询的数据、游标、
 *    加载标记或错误提示。
 * 2. 共享历史缓存与当前查询的分页进度是两个概念。缓存可跨非日期筛选保留，游标、结束状态和
 *    请求有效性必须属于当前查询；日期查询的数据独立保存，不与实时流或缓存混合。
 * 3. 会前插内容的写入（`loadMore`）由调用方包在 LogViewport 的 `around` 里执行，先取锚点、
 *    再改数据、最后按锚点复位；会话只负责在写入前确认请求仍属于当前查询。
 */

import type Logger from 'reggol'
import type { LogFilter } from '../src/log-filter'
import { compileLogFilter, hasLogFilter } from '../src/log-filter'
import { getLogKey, mergeLogRecords } from './log-record'

/** 一次日志浏览的查询条件；日期与非日期筛选共用同一形状 */
export interface LogSessionQuery {
  date?: string
  path?: string
  type?: string
  search?: string
  searchPaths?: readonly string[]
}

/** 服务端一页历史日志的返回契约，与 `logger-plus/load-before` 对齐 */
export interface LogPage {
  logs: Logger.Record[]
  cursor?: string
  hasMore: boolean
}

/** 发给 transport 的请求体：筛选条件加当前查询的游标 */
export interface LogPageRequest extends LogFilter {
  date?: string
  cursor?: string
}

/** 会话对外流出的只读结果，供响应式展示层消费 */
export interface LogSessionResult {
  /** 当前查询下应当展示的记录：非日期为实时与缓存合并后过滤，日期为该日期结果 */
  records: Logger.Record[]
  /** 已加载的历史记录（不含实时流），仅供收集插件下拉选项等展示用途 */
  loadedRecords: Logger.Record[]
  /** 是否还能加载更早记录 */
  canLoadMore: boolean
  /** 第一页在途或后续页在途 */
  loadingMore: boolean
}

export interface LogSessionOptions {
  /** Console transport seam：读取一页历史日志 */
  loadPage(request: LogPageRequest): Promise<LogPage>
  /** 实时日志来源，不复制也不接管全局实时存储 */
  getLiveLogs(): Logger.Record[]
  /** 结果变化时流出，供适配器落进响应式状态 */
  onResult(result: LogSessionResult): void
  /** 请求失败的错误提示，由展示层承接；会话核心不直接调用 UI */
  onError(message: string): void
  /** 查询切换或卸载后请求视口回到最新，位置算法仍归 LogViewport */
  onQueryReset(): void
  /** 日期模式卸载后清除日期，通知适配器同步筛选控件 */
  onDateCleared(): void
  /** 可控计时依赖：返回取消函数；生产环境是 setTimeout/clearTimeout */
  schedule(task: () => void, delay: number): () => void
  /** 自动卸载空闲时长 */
  autoUnloadDelay: number
}

export interface LogSession {
  /** 更新查询条件；等价查询按内容判定不重复请求，变化则重建分页进度 */
  setQuery(query: LogSessionQuery): void
  /** 实时日志变化，重算非日期展示；日期结果不受实时流影响 */
  liveLogsChanged(): void
  /** 加载更早记录；调用方须包在 LogViewport 的 around 里执行 */
  loadMore(): Promise<void>
  /** 浏览保活，延后自动卸载；实时推送不调用此方法 */
  keepAlive(): void
  /** 自动卸载开关变化 */
  setAutoUnload(enabled: boolean): void
  /** 销毁会话：作废在途请求、清理计时，此后回调不再发布状态 */
  dispose(): void
}

function filterOf(query: LogSessionQuery): LogFilter {
  return {
    path: query.path,
    type: query.type,
    search: query.search,
    searchPaths: query.searchPaths,
  }
}

// 需要向服务端扫描第一页的查询：日期查询，或带有效非日期筛选的查询。
// 无筛选浏览只显示实时数据、手动加载更早记录，不属于「有第一页」的查询。
function requiresFirstPage(query: LogSessionQuery) {
  return !!query.date || hasLogFilter(filterOf(query))
}

// 查询身份按条件内容计算，不看对象或数组引用：searchPaths 每次配置推送都会重算出新数组，
// 只按引用比较会让同一份清单反复触发历史查询。用 NUL 分隔避免字段拼接产生假相等。
function keyOf(query: LogSessionQuery) {
  return [
    query.date ?? '',
    query.path ?? '',
    query.type ?? '',
    query.search ?? '',
    (query.searchPaths ?? []).join('\n'),
  ].join('\u0000')
}

const EMPTY: Logger.Record[] = []

export function createLogSession(options: LogSessionOptions): LogSession {
  const { loadPage, getLiveLogs, onResult, onError, onQueryReset, onDateCleared, schedule } = options

  let query: LogSessionQuery = {}
  // 未初始化时为 null，保证首个 setQuery（即使是空查询）也会执行
  let queryKey: string | null = null
  // 非日期查询已加载的历史，跨筛选保留；游标、结束状态与它是不同概念
  let sharedCache: Logger.Record[] = []
  // 日期查询的展示结果，独立于实时流与共享缓存
  let dateLogs: Logger.Record[] = []
  // 当前查询的分页游标与结束状态，随查询切换重建
  let cursor: string | undefined
  let cursorEstablished = false
  let hasMore = true
  // 尚未成功取回第一页：查询切换时按 requiresFirstPage 置位，第一页成功后清除。
  // 决定 loadMore 是「重试第一页」还是「沿用游标翻下一页」
  let needsFirstPage = false
  let firstPageLoading = false
  let loadMoreInFlight = false
  let autoUnload = true
  let disposed = false
  // 请求有效性令牌：查询切换、卸载、销毁都递增，过期请求据此丢弃
  let requestId = 0
  let unloadCancel: (() => void) | undefined

  // 展示记录投影：日期结果独立返回；非日期把实时与缓存合并去重后按当前条件过滤。
  // 相同日志同时出现在实时流与历史页时，mergeLogRecords 按稳定标识去重并维持时间顺序。
  function computeRecords(): Logger.Record[] {
    if (query.date) return dateLogs
    const live = getLiveLogs()
    const merged = sharedCache.length ? mergeLogRecords(sharedCache, live) : live
    const filter = filterOf(query)
    if (!hasLogFilter(filter)) return merged
    // 实时日志频繁推送，判定函数必须在过滤循环外编译一次
    const matches = compileLogFilter(filter)
    return merged.filter(record => matches(record))
  }

  function loadedRecords(): Logger.Record[] {
    if (!sharedCache.length && !dateLogs.length) return EMPTY
    return [...sharedCache, ...dateLogs]
  }

  function publish() {
    if (disposed) return
    onResult({
      records: computeRecords(),
      loadedRecords: loadedRecords(),
      canLoadMore: hasMore,
      loadingMore: firstPageLoading || loadMoreInFlight,
    })
  }

  function buildRequest(pageCursor: string | undefined): LogPageRequest {
    return {
      date: query.date || undefined,
      path: query.path || undefined,
      type: query.type || undefined,
      search: query.search || undefined,
      searchPaths: query.searchPaths,
      cursor: pageCursor,
    }
  }

  // 未建立游标时的加载起点：取当前展示的第一条（最早一条）记录标识，
  // 让无筛选浏览能从实时视图继续读取更早记录。
  function firstDisplayedCursor() {
    const first = computeRecords()[0]
    return first ? getLogKey(first) : undefined
  }

  function hasLoadedHistory() {
    return sharedCache.length > 0 || dateLogs.length > 0 || cursorEstablished
  }

  function clearUnloadTimer() {
    unloadCancel?.()
    unloadCancel = undefined
  }

  // 只在存在已加载历史时计时；关闭自动卸载或销毁时不排程。反复调用只保留一个有效回调。
  function resetUnloadTimer() {
    clearUnloadTimer()
    if (disposed || !autoUnload || !hasLoadedHistory()) return
    unloadCancel = schedule(unload, options.autoUnloadDelay)
  }

  // 到期卸载：清空共享缓存、日期结果与分页进度，并递增 requestId 作废在途请求，
  // 迟到响应因此无法把历史重新填回。保留实时来源，不重挂展示子树也能完成清理。
  function unload() {
    const wasDate = !!query.date
    requestId++
    sharedCache = []
    dateLogs = []
    cursor = undefined
    cursorEstablished = false
    hasMore = true
    firstPageLoading = false
    loadMoreInFlight = false
    clearUnloadTimer()
    if (wasDate) {
      // 日期模式卸载后清除日期回到实时模式，保留插件/等级/关键词筛选
      query = { ...query, date: undefined }
      queryKey = keyOf(query)
    }
    // 卸载后仍可能有有效非日期筛选，此时 loadMore 应重新扫描第一页而非沿用已清除的游标
    needsFirstPage = requiresFirstPage(query)
    // 回到实时最新位置；此处不触发任何历史请求：即使仍有有效筛选，也不能刚卸载就自动回填。
    // 由日期同步引起的 setQuery 会因 queryKey 已更新而被去重挡掉，只有真正的用户查询变更才再加载。
    onQueryReset()
    publish()
    // onDateCleared 放在 publish 之后：适配器据此把 selectedDate 归零，随之而来的 setQuery 因 key 相同被去重
    if (wasDate) onDateCleared()
  }

  async function refreshFirstPage(id: number) {
    firstPageLoading = true
    publish()
    let page: LogPage
    try {
      page = await loadPage(buildRequest(undefined))
    } catch {
      // 规则 1：查询已切换则丢弃这次失败，不得改动新查询的状态或弹出过期错误
      if (id !== requestId) return
      firstPageLoading = false
      // 第一页失败保留当前可用记录（非日期为实时与缓存，日期为空），提示失败并允许重试第一页，
      // 不沿用上一查询游标；needsFirstPage 保持置位，下次 loadMore 仍从第一页重试
      onError('加载日志失败')
      publish()
      return
    }
    // 规则 1：await 之后写入前重新核对；查询切换过就整份丢弃
    if (id !== requestId) return
    if (query.date) {
      dateLogs = page.logs
    } else {
      sharedCache = mergeLogRecords(sharedCache, page.logs)
    }
    cursor = page.cursor
    cursorEstablished = !!page.cursor
    hasMore = page.hasMore
    needsFirstPage = false
    firstPageLoading = false
    resetUnloadTimer()
    publish()
  }

  function setQuery(next: LogSessionQuery) {
    if (disposed) return
    const nextKey = keyOf(next)
    // 等价查询直接返回，避免派生数组引用变化触发重复请求
    if (nextKey === queryKey) return
    queryKey = nextKey
    query = { ...next }
    // 规则 1：查询切换作废旧请求，旧请求的成功/失败/结束都不能再改动状态
    requestId++
    cursor = undefined
    cursorEstablished = false
    hasMore = true
    firstPageLoading = false
    loadMoreInFlight = false
    needsFirstPage = requiresFirstPage(query)
    // 日期查询数据独立且不保留上一日期展示；非日期共享缓存跨筛选保留
    if (query.date) dateLogs = []
    clearUnloadTimer()
    // 分页重置在此完成，不依赖销毁并重建展示子树；视口回到最新由展示层响应
    onQueryReset()
    publish()
    if (needsFirstPage) {
      void refreshFirstPage(requestId)
    } else {
      resetUnloadTimer()
    }
  }

  async function loadMore() {
    // 第一页在途或重复点击时不并发请求同一查询的下一页
    if (disposed || firstPageLoading || loadMoreInFlight || !hasMore) return
    const id = requestId
    loadMoreInFlight = true
    publish()
    // needsFirstPage 时重试第一页（游标置空，从最新匹配处扫描），否则沿用当前查询游标；
    // 未建立游标的无筛选浏览退回当前展示的最早一条作起点
    const request = needsFirstPage ? buildRequest(undefined) : buildRequest(cursor ?? firstDisplayedCursor())
    let page: LogPage
    try {
      page = await loadPage(request)
    } catch {
      // 规则 1：查询切换/卸载后旧请求失败不得干扰新状态
      if (id !== requestId) return
      loadMoreInFlight = false
      // 后续页失败保留已有记录与游标，允许重试同一逻辑页；失败不当作正常到达末尾
      onError('加载更早日志失败')
      publish()
      return
    }
    // 规则 1 与规则 3：写入前确认请求仍属于当前查询；数据变更由外层 around 保护阅读位置
    if (id !== requestId) return
    if (query.date) {
      dateLogs = mergeLogRecords(page.logs, dateLogs)
    } else {
      sharedCache = mergeLogRecords(sharedCache, page.logs)
    }
    cursor = page.cursor
    cursorEstablished = !!page.cursor
    hasMore = page.hasMore
    needsFirstPage = false
    loadMoreInFlight = false
    resetUnloadTimer()
    publish()
  }

  return {
    setQuery,
    liveLogsChanged() {
      if (disposed) return
      // 日期结果独立于实时流：实时到达不改变日期展示，也不写入非日期缓存
      if (query.date) return
      publish()
    },
    loadMore,
    keepAlive() {
      // 浏览保活只由用户操作触发；实时推送不计作活动，不能无限延长历史保留
      resetUnloadTimer()
    },
    setAutoUnload(enabled) {
      autoUnload = enabled
      if (enabled) resetUnloadTimer()
      else clearUnloadTimer()
    },
    dispose() {
      // 规则 1：销毁作废全部请求，此后迟到响应与计时回调都不再发布状态
      disposed = true
      requestId++
      clearUnloadTimer()
    },
  }
}
