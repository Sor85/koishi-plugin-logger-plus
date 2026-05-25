import { Context, Logger } from 'koishi'

export interface LogRecordLoader {
  paths(scope: object): string[]
}

function getRecordContext(record: Logger.Record) {
  return record.meta?.[Context.current]
}

function isRootScope(scope: object) {
  return (scope as { parent?: { scope?: object } }).parent?.scope === scope
}

// 创建日志记录处理器，并为刚重启插件的日志延后解析筛选路径
export function createLogRecordHandler(loader: LogRecordLoader | undefined, commit: (record: Logger.Record) => void) {
  const contextPaths = new WeakMap<object, string[]>()
  const scopePaths = new WeakMap<object, string[]>()

  function resolvePaths(record: Logger.Record) {
    const context = getRecordContext(record)
    const scope = context?.scope
    if (!loader || !scope) return
    const paths = loader.paths(scope)
    if (paths.length) {
      record.meta['paths'] = paths
      contextPaths.set(context, paths)
      scopePaths.set(scope, paths)
      return paths
    }
    const cached = contextPaths.get(context) ?? scopePaths.get(scope)
    record.meta['paths'] = cached ?? paths
    return cached ?? paths
  }

  return (record: Logger.Record) => {
    record.meta ||= {}
    const context = getRecordContext(record)
    const scope = context?.scope
    const paths = resolvePaths(record)
    if (loader && scope && !paths?.length && !isRootScope(scope)) {
      setTimeout(() => {
        resolvePaths(record)
        commit(record)
      })
      return
    }
    commit(record)
  }
}
