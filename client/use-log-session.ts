/**
 * LogSession 的 Vue 外壳。
 *
 * 只做三件事：把响应式查询、实时日志与开关接进会话意图，把会话流出的结果落进 ref，
 * 在卸载时销毁会话。查询生命周期、分页与历史规则一律不在这里，核心因此与框架无关。
 */

import { send, message } from '@koishijs/client'
import type Logger from 'reggol'
import { onUnmounted, ref, watch } from 'vue'
import type { LogSession, LogSessionQuery, LogSessionResult, LogPage, LogPageRequest } from './log-session'
import { createLogSession } from './log-session'

// 半小时无相关浏览操作后卸载已加载的过往日志，与服务端配置口径一致
const AUTO_UNLOAD_DELAY = 30 * 60 * 1000

export interface UseLogSessionOptions {
  /** 当前查询条件，随筛选控件变化 */
  query: () => LogSessionQuery
  /** 是否启用自动卸载 */
  autoUnload: () => boolean
  /** 实时日志来源 */
  liveLogs: () => Logger.Record[]
  /** 查询切换或卸载后请求视口回到最新 */
  onQueryReset(): void
  /** 日期模式卸载后同步清除日期筛选控件 */
  onDateCleared(): void
}

export function useLogSession(options: UseLogSessionOptions) {
  const result = ref<LogSessionResult>({ records: [], loadedRecords: [], canLoadMore: false, loadingMore: false })

  const session: LogSession = createLogSession({
    loadPage: (request: LogPageRequest) => send('logger-plus/load-before', request) as Promise<LogPage>,
    getLiveLogs: () => options.liveLogs(),
    onResult(next) {
      result.value = next
    },
    onError(text) {
      message.error(text)
    },
    onQueryReset: () => options.onQueryReset(),
    onDateCleared: () => options.onDateCleared(),
    schedule(task, delay) {
      const timer = setTimeout(task, delay)
      return () => clearTimeout(timer)
    },
    autoUnloadDelay: AUTO_UNLOAD_DELAY,
  })

  // 等价查询由会话按内容去重，派生数组引用变化不会重复请求
  watch(options.query, (next) => session.setQuery(next), { immediate: true })
  // 实时日志就地追加时数组引用不变，长度也要一起侦听
  watch(() => options.liveLogs().length, () => session.liveLogsChanged())
  watch(options.autoUnload, (enabled) => session.setAutoUnload(enabled), { immediate: true })

  onUnmounted(() => session.dispose())

  return {
    result,
    loadMore: () => session.loadMore(),
    keepAlive: () => session.keepAlive(),
  }
}
