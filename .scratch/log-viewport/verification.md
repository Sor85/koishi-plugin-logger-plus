# LogViewport 验收记录

验证日期：2026-09-13（本机时间）。

## 最终实现

- `client/log-viewport.ts`：纯 TypeScript 核心、8 个动作、窗口与两项追踪状态、单写者闸门、异步代次、全部帧取消。
- `client/viewport-host.ts`：四方法 DOM 适配器，断开容器返回无几何。
- `client/use-log-viewport.ts`：Vue ref、生命周期、RAF 与 nextTick 注入。
- 暂停位置 module 与旧测试已删除；虚拟列表算法及其 11 条测试保持原样。
- 未修改分页 RPC、游标算法、右键菜单、通用滚动条 directive，未新增依赖。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `yarn test` | 107/107 通过，包含 19 条 LogViewport 行为测试 |
| `node --import tsx --test tests/log-viewport.test.ts` | 19/19 通过 |
| `yarn build` | 服务端类型生成、tsup、Vite 均通过 |
| `yarn exec tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --strict --esModuleInterop client/log-viewport.ts client/viewport-host.ts client/use-log-viewport.ts tests/log-viewport.test.ts` | 通过 |
| `yarn exec tsc --noEmit -p tsconfig.client.json` | 未通过：依赖 `@koishijs/client/client/plugins/loader.ts:56` 的 `ShallowReactiveBrandClass` 与 `Dict<LoadResult>` 不兼容 |
| `npx --no-install vue-tsc --noEmit -p tsconfig.client.json` | 未通过：既存 `Meta.paths` 类型缺失（logs.vue、settings.vue），以及 Koishi / schemastery-vue 依赖内的类型错误；与搬运后早期检查结果一致 |
| `git diff --check` | 通过 |

适配器新增的 `NodeList` 迭代类型错误已修复为 `Array.from()`；当前失败的全量类型检查不能宣称通过，也未为使检查变绿而修改第三方依赖。

### 有效性检查

在独立临时目录执行变异，不改动运行环境加载的源码：

- 基线：19 条全部通过。
- 禁用单写者闸门：异步前插期间抢写测试失败。
- 不清除旧宽度缓存：窗口外旧实测高度测试失败。
- 不取消待执行帧：卸载清理测试失败。

假 host 在 `flush()` 后才提交窗口，可控制未完成的刷新、模拟浏览器高度钳制；测试超出帧数限额会明确失败，不会无限等待。

## 真实浏览器验证

使用完整 Koishi 开发环境，`portal:` 指向本仓库，Console development 模式直接加载当前 `client/log-viewport.ts`。完整重启时核对旧主进程、worker 与 watcher 退出，5140/5141 释放后才启动新实例。

可复用脚本：`tests/browser/log-viewport.js`。

```sh
npx playwright cli -s=viewport-chrome open http://127.0.0.1:5140/logs --browser=chrome
npx playwright cli -s=viewport-chrome run-code --filename=tests/browser/log-viewport.js
npx playwright cli -s=viewport-chrome eval 'window.viewportReport'
npx playwright cli -s=viewport-chrome close
```

Firefox 使用另一会话名与 `--browser=firefox` 重复执行。脚本向真实 Vue 组件注入浏览器内测试 props，不写服务端日志或配置；不代替真实分页 RPC 的验证。

| 场景 | Chrome | Firefox |
| --- | --- | --- |
| 变高日志追踪、追加后贴底 | 距底部 0px | 距底部 0px |
| 用户上滚 | 转为暂停 | 转为暂停 |
| 暂停期间追加、前插 20 条 | 原锚点 −16px → −16px | 原锚点 −16px → −16px |
| 锚点移出渲染窗口后恢复 | −16px → −16px | −16px → −16px |
| 窗口宽度 1280 → 820 | −16px → −16px | −16px → −16px |
| 开启暂停保位后跨页返回 | 断开 DOM 后返回，−16px → −16px | 同左 |
| 点击回到底部 | 恢复追踪，距底部 0px | 同左 |
| 十万条日志 | 仅渲染 66 行 | 仅渲染 66 行 |
| 自绘滑块拖动 | 松手后位置与锚点偏移不变 | 同左 |
| 窄屏几何 | 避让侧栏，无页面横向溢出 | 同左 |

另在 Chrome 实际点击「查看更多消息」：真实 RPC 使日志从 343 增至 543 条，原锚点 20px → 20px。插件配置页的嵌入式运行日志实测高度 216px、14 个 DOM 行、距底部 0px。已查看 Chrome 日志页与 Firefox 十万条场景截图。

### 浏览器与时序测试发现的修复

1. `around()` 必须在调用异步 change **之前**关闭闸门，并在失败时释放。
2. 已开始的帧在每个刷新边界复查闸门与代次，避免旧锚点抢写。
3. 所有待执行帧均归核心所有；卸载取消等待帧时同时完成对应 Promise，异步续体不再写位置或发布状态。
4. 先渲染并测量末尾窗口，再贴底；避免窗口高度短暂收缩引发浏览器钳制，继而被误判为用户上滚。
5. 恢复最后一轮测量后先提交占位，再只按实际矩形写一次；宽度改变时优先使用重排前的稳定阅读锚点。
6. Firefox 原生滚动锚定曾使宽度变化后偏移从 −16px 变成 −176px。日志容器使用 `overflow-anchor: none` 后双浏览器通过，CSS 守卫保留此边界。

## 流程偏差

- Spec 要求两个提交；实际此前已产生四个提交 `b55cd76`、`c29717c`、`abf4a8e`、`403d812`，本轮没有改写历史。
- 01、02 阶段未执行浏览器验收，不能追认这些阶段已证明「行为一行不变」。原有 15 条底层测试虽未改且通过，仍未捕获编排缺陷；最终浏览器验收与新增行为测试已补齐。
- 早期评审报告中「全部验收落实」与「已覆盖断开 DOM」的结论证据不足，不作为本记录的依据。本记录仅采用实际执行结果。
