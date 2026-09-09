# Triage 标签

各技能统一使用五个规范角色。本表把这些角色映射到本仓库 issue tracker 里实际使用的字符串。

本仓库使用本地 Markdown tracker，因此「标签」不是 GitHub label，而是写在工单文件顶部 `Status:` 行里的取值（约定见 `issue-tracker.md`）。

| mattpocock/skills 中的角色 | 本仓库取值        | 含义                     |
| -------------------------- | ----------------- | ------------------------ |
| `needs-triage`             | `needs-triage`    | 待维护者评估             |
| `needs-info`               | `needs-info`      | 等待报告者补充信息       |
| `ready-for-agent`          | `ready-for-agent` | 规格完整，可交给 AFK Agent |
| `ready-for-human`          | `ready-for-human` | 需人工实现               |
| `wontfix`                  | `wontfix`         | 不予处理                 |

技能提到某个角色时（例如「打上 AFK-ready 的 triage 标签」），使用本表右列对应的取值。

如需改用其它命名，只修改右列即可。
