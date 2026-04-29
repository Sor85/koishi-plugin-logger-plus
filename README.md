# logger-plus

Koishi 控制台日志插件。fork 自 Koishi 官方 logger 插件，在原有能力上增强了日志浏览体验。

## 功能

- 支持按插件过滤日志，只查看特定插件的日志记录
- 支持离开底部时自动暂停追踪最新日志
- 支持回到底部时自动恢复追踪最新日志
- 在每条日志末尾提供复制按钮，可一键复制完整日志内容

## 安装

```bash
npm install koishi-plugin-logger-plus
```

## 使用

在 Koishi 配置中启用插件：

```json
{
  "plugins": {
    "logger-plus": {}
  }
}
```

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `root` | `data/logs` | 日志文件目录 |
| `maxAge` | `30` | 日志保留天数 |
| `maxSize` | `102400` | 单个日志文件最大大小 |

## 开发

```bash
npm install
npm run build
```

## 许可证

AGPL-3.0
