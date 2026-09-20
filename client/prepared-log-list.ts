import type Logger from 'reggol'
import type { LogTextLayout } from './log-height-estimator'
import { createLogHeightEstimator } from './log-height-estimator'

/**
 * 将分批预估与清单提交作为同一事务。处理期间保留上一份可滚动清单，
 * 不让新记录先替换 DOM、预估却几帧之后才补上；也不在连续推送时反复重启大正文扫描。
 */
export function createPreparedLogList(options: {
  yieldTask(): Promise<void>
  commit(records: Logger.Record[], heights: number[]): void
}) {
  const estimator = createLogHeightEstimator(options.yieldTask)
  let pending: { records: Logger.Record[], layout: LogTextLayout } | undefined
  let running: Promise<void> | undefined
  let disposed = false

  async function drain() {
    while (pending && !disposed) {
      const batch = pending
      const heights = await estimator.prepare(batch.records, batch.layout)
      if (disposed) return
      // 新查询或新推送已经到来时不发布旧清单；本轮已生成的文本缓存供下一轮复用。
      if (batch !== pending) continue
      pending = undefined
      if (heights) options.commit(batch.records, heights)
    }
  }

  function start() {
    running = drain().finally(() => {
      running = undefined
      // drain 已退出、finally 尚未执行的微任务间隙也可能收到一次推送。
      if (pending && !disposed) start()
    })
  }

  return {
    update(records: Logger.Record[], layout: LogTextLayout) {
      if (disposed) return
      pending = { records, layout }
      if (!running) start()
      return running
    },
    async ready() {
      while (running) await running
    },
    dispose() {
      disposed = true
      pending = undefined
      estimator.dispose()
    },
  }
}
