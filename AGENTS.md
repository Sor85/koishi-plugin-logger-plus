# AGENTS.md

## Agent skills

### Issue tracker

Issue 与 spec 以 Markdown 文件形式存放在本仓库的 `.scratch/` 下，不使用 GitHub Issues。详见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个规范角色的默认取值，未做重命名；本地 tracker 中记录在工单文件的 `Status:` 行。详见 `docs/agents/triage-labels.md`。

### Domain docs

single-context 布局：根目录 `CONTEXT.md` 加 `docs/adr/`。本仓库另有 `CONSTRAINTS.md` 记录已验证的硬约束（滚动位置稳定性、虚拟滚动、日志文件规模），改动相关代码前须一并阅读。详见 `docs/agents/domain.md`。
