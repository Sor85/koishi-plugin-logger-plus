/**
 * 实时日志缓冲的裁剪闸。
 *
 * 控制台的实时日志是一段定长缓冲：写满之后每来一条新日志就从头部淘汰最早一条。用户贴底追踪时
 * 这没问题，被淘汰的都是早已滚出视口的内容；用户上滚浏览历史时却正相反——被淘汰的正是他往上读的
 * 那一段。清单前端被削，视口内容随之整体上移，可滚动范围同时收缩，到达顶部后连位置都保不住，
 * 表现出来就是「滚动被拉回原位」「刚滚过去的日志消失」。
 *
 * 因此暂停浏览期间挂起裁剪，恢复追踪后由下一条日志补做。挂起不等于不设上限：另有一个放宽后的
 * 硬上限兜底，避免用户长时间停在历史位置时缓冲无限增长。
 *
 * 闸是进程级的：裁剪挂在控制台入口的全局侦听里，暂停状态在日志页组件里，两者只能靠这里会合。
 * 取闸返回释放函数，重复释放无副作用，组件卸载时必须释放。
 */

let holds = 0

/** 挂起裁剪，返回释放函数；重复调用释放函数只生效一次 */
export function holdLiveLogTrim(): () => void {
  holds++
  let released = false
  return () => {
    if (released) return
    released = true
    holds--
  }
}

/** 当前生效的裁剪上限：有人挂起时用放宽后的硬上限，否则用常规上限 */
export function liveLogTrimLimit(limit: number, heldLimit: number): number {
  return holds > 0 ? Math.max(limit, heldLimit) : limit
}
