# logger-plus

Koishi 控制台日志插件。它会将 Koishi 运行日志写入本地文件，并在控制台中提供日志查看页面。

## 功能

- 按日期和大小滚动保存日志文件
- 在 Koishi 控制台中查看日志
- 在插件详情页展示相关插件日志
- 支持暂停/继续追踪最新日志

## 安装

```bash
npm install logger-plus
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
