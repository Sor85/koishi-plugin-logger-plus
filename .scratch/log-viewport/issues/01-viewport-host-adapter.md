# 01 — 把滚动容器的 DOM 读写收进 ViewportHost adapter

**What to build:** 日志列表不再自己直接读写滚动几何。所有对滚动位置、占位容器顶部偏移、日志行矩形与行标识查询的访问，统一经过一个符合 `ViewportHost` 契约的适配器。

**这一张不搬编排逻辑**——五个私有变量与七个编排函数原地不动，只是把它们对 DOM 的访问换成对适配器的调用。用户视角行为一行不变：滚动、暂停追踪、前插历史日志、回到底部、跨页面往返全部与改动前一致。

这是为下一张做的 prefactor。把「改 DOM 访问方式」与「搬编排逻辑」拆成两步，任一步出问题都能立刻定位到是哪一半。

契约形状（来自 spec 的定型，prose 无法同等精确）：

```ts
interface ViewportHost {
  // 滚动容器几何；容器不存在或已离开 DOM 时返回 undefined
  metrics(): {
    scrollTop: number
    clientHeight: number
    clientWidth: number
    scrollHeight: number
    // 占位容器相对滚动容器内边距盒的顶部偏移；
    // 「查看更多消息」按钮与顶部内边距都算在它前面
    contentTop: number
  } | undefined
  // 当前渲染出来的行：标识、实测高度、相对容器视口顶部的偏移
  lines(): Array<{ key: string; height: number; top: number }>
  scrollTo(scrollTop: number): void
  estimatedLineHeight(): number
}
```

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] 存在符合上述四方法契约的适配器，且「容器不存在或已离开 DOM」的判断折进 `metrics()` 返回 `undefined`，调用方不再单独判断
- [ ] `lines()` 一次性满足锚点捕获与锚点恢复两边的需求
- [ ] 编排逻辑仍留在原处，未移入新 module
- [ ] 虚拟列表布局 module 的 11 条与暂停位置 module 的 4 条，共 15 条既有测试**一条未改**且全绿
- [ ] 日志视图源码守卫测试保持全绿
- [ ] 浏览器中人工确认行为不变：追踪最新、向上滚转暂停、前插历史后位置不动、回到底部、跨页面往返、改窗口宽度后位置不动
- [ ] 插件设置页的运行日志仍正常显示
- [ ] `yarn build` 通过

## Comments

2026-09-13 核对：此阶段提交为 `b55cd76`；当时 93 条测试及构建通过，虚拟列表与暂停位置的 15 条测试未改动。阶段内未执行浏览器验收，不能事后将全部检查项勾成完成；最终实现的 Chrome/Firefox 与设置页验收已在 04 补齐，详见 [验收记录](../verification.md)。
