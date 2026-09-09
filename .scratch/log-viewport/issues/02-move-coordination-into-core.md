# 02 — 把视口编排搬进 LogViewport 核心

**What to build:** 视口协调从此有一个 module 承载。五个私有变量与七个编排函数移入一个纯 TypeScript 核心；日志列表改为调用它对外的 8 个动作，并从一个回调接收窗口与两项追踪状态。

调用方从此不必知道虚拟列表的驾驶协议（先设清单再取窗口、窗口吃的是内容坐标而非滚动位置、渲染后才能量高度、只有宽度变化才丢弃实测高度），也不必自己保证「先取锚点、再改内容、再复位」的顺序——前插交给 `around` 执行，顺序封在里面。

**行为仍然一行不变。** 这一张是搬运，不是改造。

对外形状：

```ts
interface LogViewport {
  setItems(keys: string[]): void
  handleScroll(): void
  handleResize(): void
  followLatest(): void
  // 先取锚点 → 执行 change → 等 DOM 刷新 → 按锚点复位
  around(change: () => void | Promise<void>): Promise<void>
  capture(): LogAnchor | undefined
  restore(anchor?: LogAnchor): Promise<void>
  dispose(): void
}
// window / isFollowing / isViewingLatest 经 onStateChange 回调流出
```

**Blocked by:** 01 — 把滚动容器的 DOM 读写收进 ViewportHost adapter

**Status:** ready-for-agent

- [ ] 核心不引入 Vue —— 这条边界由 import 关系直接可验证，不靠纪律
- [ ] `schedule`、`flush`、`onStateChange` 作为构造参数由 composable 注入；核心不直接调用全局的帧调度
- [ ] `around(change)` 内部完成「取锚点 → 执行 → 等刷新 → 复位」，调用方不接触锚点
- [ ] `onStateChange` 只在状态真正变化时触发（沿用既有的「四字段全等则不更新」去重）
- [ ] 五条不变量以注释写入核心：单写者闸门、先取锚点再写实测高度、占位是布局值不得用位移变换、只有宽度变化才丢弃实测高度、找不到锚点时不强行恢复
- [ ] 虚拟列表布局 module 仅被核心引用，不再对日志列表暴露；其「缓存条数」方法不出现在 `LogViewport` 的对外形状上
- [ ] 暂停位置 module **原样保留**并被核心引用（并入留到 04）
- [ ] 跨重启分隔行判定、原生滚动条宽度遮罩、「用户仍在查看」保活协议三者仍留在渲染层
- [ ] 15 条既有测试**一条未改**且全绿
- [ ] 日志视图那 4 个滚动相关的正则用例改为指向新 module 并保持绿（作为搬运期临时护栏，04 再删）
- [ ] 浏览器中人工确认行为不变：追踪最新、向上滚转暂停、前插历史后位置不动、回到底部、跨页面往返、改窗口宽度后位置不动、拖动自绘滚动条不抖动
- [ ] `yarn build` 通过
