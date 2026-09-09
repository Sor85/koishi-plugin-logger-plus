# Issue tracker：本地 Markdown

本仓库的 issue 与 spec 以 Markdown 文件形式存放在 `.scratch/` 下，不使用 GitHub Issues。

## 约定

- 一个特性一个目录：`.scratch/<feature-slug>/`
- spec 固定为 `.scratch/<feature-slug>/spec.md`
- 实现工单一张一个文件，位于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，编号自 `01` 起。**不得**把多张工单合并进单个文件。
- triage 状态记录在每个工单文件顶部附近的 `Status:` 行，取值见 `triage-labels.md`
- 评论与往复记录追加到文件末尾的 `## Comments` 标题之下

`.scratch/` 未被 `.gitignore` 忽略，因此 spec 与工单会进入版本控制，可随代码一起 review。

## 当技能说「发布到 issue tracker」

在 `.scratch/<feature-slug>/` 下新建文件，目录不存在则一并创建。

## 当技能说「取出对应工单」

读取被引用路径下的文件。通常用户会直接给出路径或工单编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个文件，每张工单一个**子文件**。

- **map**：`.scratch/<effort>/map.md` —— 承载 Notes / Decisions-so-far / Fog 三段正文。
- **子工单**：`.scratch/<effort>/issues/NN-<slug>.md`，编号自 `01` 起，正文写问题本身。`Type:` 行记录工单类型（`research` / `prototype` / `grilling` / `task`），`Status:` 行记录 `claimed` / `resolved`。
- **阻塞关系**：文件顶部附近的 `Blocked by: NN, NN` 行。所列文件全部 `resolved` 时该工单解除阻塞。
- **frontier**：扫描 `.scratch/<effort>/issues/`，取其中未关闭、未被阻塞、未被认领的文件，编号最小者优先。
- **认领**：动工前先把 `Status:` 置为 `claimed` 并保存。
- **解决**：在 `## Answer` 标题下追加答案，把 `Status:` 置为 `resolved`，再把一条上下文指针（gist 加链接）追加到 `map.md` 的 Decisions-so-far。
