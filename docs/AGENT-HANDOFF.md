# 外部 Agent 与PaperMind交付协议

目标：用户在 Codex / 其他 Agent 中学习和生成文章，PaperMind承载阅读、批注与原文讨论。无需把写作对话迁进PaperMind。

## 告诉外部 Agent 的使用方式

> 请把学习笔记保存为 Markdown，再交付到本机PaperMind。首次使用 `papermind notes import 文件.md`。后续修改同一篇前，先用 `papermind notes get 文档ID` 读取最新正文、讨论和 revision，综合最新内容修改，再带 `--id` 和 `--revision` 交付。不要只改旧文件后覆盖PaperMind的新内容。最后给我返回的文档链接。若发生版本冲突，重新读取最新文档并合并，不要强行覆盖。

若没有安装 `papermind` 快捷命令，在本项目用 `node bin/papermind.mjs` 代替 `papermind`。后台服务需先启动：`papermind --background --no-open`。

## 命令

```sh
# 创建；文件绝对路径默认作为交付标识，重试同一份内容不重复创建
papermind notes import ./检索学习笔记.md

# 查找或读取；get 返回包含正文结构、讨论和 revision 的 JSON
papermind notes list
papermind notes get 文档ID

# 更新；revision 必须是刚刚读取的版本
papermind notes import ./检索学习笔记.md --id 文档ID --revision 3

# HTML 或标准输入；跨目录交付可使用稳定 key
papermind notes import ./文章.html --format html --title "学习笔记"
cat ./文章.md | papermind notes import - --key learning/retrieval
```

这里的“文档ID”是返回的 UUID，不是文章标题。命令输出包括 id、revision、是否新建、定位变化提示和可打开的 URL。默认连接 `127.0.0.1:4317`，可追加 `--port`。

## 一致性

- 修改已有文档必须提供 revision；旧版本会被拒绝。
- 同一 key 的同一份原始交付内容重试时，返回已有文档，不回退用户在PaperMind的后续编辑。
- 对仍然唯一出现的相同原文，重新定位讨论及高亮；原文消失或出现多次时不猜测位置。讨论保留并标记原文已变化。
- 浏览器在没有本机未保存编辑、没有 AI 操作进行时，每 3 秒检查外部更新。后台标签重新聚焦也检查。未保存的输入不会被外部更新直接替换。
- 全文交付使用 Markdown 或 HTML；标题、列表、表格和代码块由解析器转换，HTML 经现有清理器处理。
- 通过本机 HTTP 服务写入；不要直接编辑 SQLite，也不要读取模型授权文件。

HTTP 接口：`POST /api/agent/documents`，字段为 body、format、title?、id?、revision?、key?。同样使用本机 session token；CLI 会自行取得并仅用于本机请求，不输出 token。
