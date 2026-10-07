# 公开文章导入与 GitHub 双向同步

## 使用方式

文档界面的「导入」支持公开 GitBook 单篇文章。粘贴地址 → 预览标题和正文 → 点击「导入为我的文档」。只创建自己的可编辑副本，保存原文链接；不会修改原网页，也不自动追踪后续更新。重复确认同一个有效预览不会重复创建。

「GitHub」默认只同步当前文档。使用本机 `gh auth login` 登录，填写已有 `owner/repository`、分支和存放目录。仓库需有已初始化的分支（例如创建仓库时勾选 README）。先预览每个文件的完整内容及远端原内容，再明确确认上传。不会创建仓库、自动选取其他笔记或自动推送。

每篇文档使用稳定 UUID 目录，保存：

- `README.md`：适合 GitHub 阅读的正文及来源链接。
- `document.json`：完整结构、标注、高亮、版本、来源与更新时间。
- `comments.json`：该文档的讨论、消息及修改提案。

在另一台电脑打开「从 GitHub 拉取」，填写同一仓库和目录，预览后恢复这些文件。它是显式上传 / 拉取，不是实时多人编辑，也不是浏览器云端托管。Markdown 表格是便于阅读的简化表示，跨行/跨列表格等完整格式仍保存在 `document.json`。

## API

在认证中间件之后、API 404 之前调用 `await installIntegrationRoutes(app, store, dataDir)`。

| 方法 | 路径 | 输入 / 返回 |
| --- | --- | --- |
| GET | `/api/github/status` | `{available, authenticated, login?, message}` |
| POST | `/api/import/preview` | `{url}` → `{previewId,title,html,url,sourceUrl,warnings}` |
| POST | `/api/import` | `{previewId}` → `{note}` |
| POST | `/api/github/preview` | `{repo,branch?,folder?,noteIds}` → `{previewId,repo,branch,folder,baseSha,files,warnings}` |
| POST | `/api/github/push` | `{previewId}` → `{repo,branch,commitSha,url,files}` |
| POST | `/api/github/pull/preview` | `{repo,branch?,folder?}` → 各篇正文与冲突预览 |
| POST | `/api/github/pull` | `{previewId}` → `{notes,backups}` |

每个文件预览包含 `path,status,content,previousContent?,bytes`，状态为 add/update/unchanged。预览绑定服务端快照，20 分钟有效；浏览器不能通过篡改文件内容来替换已预览的推送。

## 安全和冲突规则

网页仅接受公开域名、标准 443 端口的 HTTPS。每次跳转重新解析 DNS，拒绝本机、私网、保留地址，并将通过检查的 IP 固定到实际连接，防止 DNS 重绑定。最多 5 次跳转、25 秒、5 MB，拒绝非 HTML 和非 identity 压缩内容。

本机代理使用 `198.18.0.0/15` Fake-IP 时，通过固定 Cloudflare `https://1.1.1.1/dns-query` 查询公开域名的真实 A 记录；只连接验证后的公网地址，不放行 Fake-IP。不会修改系统 DNS 或代理。该兼容查询仅发送目标网页域名。

网页中的脚本、事件处理器和导航被移除。视频与图片保留为链接，预览不会自动加载远程媒体，也不会下载源视频。文章是资料，不会被当作工具执行指令。

GitHub 操作通过 `gh api` 参数数组执行，没有 shell 拼接，不读取、展示或复制令牌。同步记录和文档一同保存在本机 SQLite：记录远端文件 SHA 与上次同步的内容指纹；自动迁移旧版 github-sync.json。首次同步遇到同路径未知文件时拒绝覆盖；已登记文件的远端 SHA 若变化也拒绝。路径不能越界或进入 `.github` 等隐藏目录。

确认推送时重新检查本地文档快照和远端分支 HEAD。新提交以预览 HEAD 为唯一父提交，更新分支使用 `force:false`；并发产生的新远端提交会导致非快进更新失败。不会删除远端其他文件。若网络中断或提交后本地登记失败，不可把错误当作“远端肯定未改变”，需先检查提示和 GitHub 状态。

## 验证记录（2026-10-06）

- 10 项确定性测试通过：公网/私网地址与 URL 校验、正文提取、导入幂等、Markdown、指定文档导出、首次未知文件与远端变动保护、本地快照变动、并发非快进拒绝、路径检查，以及服务重开后的登记恢复与更新对比。
- GitHub 写入测试使用明确的 `FakeGithub`，仅证明协议和冲突处理；**没有真实推送**。用户尚未选择目标仓库，不应声称 GitHub 实仓同步已验收。
- 用户提供的真实 GitBook 单页已经通过生产 `fetchPublicPage` 获取（HTTP 200，495762 bytes），提取标题「1.交易入门」、说明与正文，6 个视频保留链接。另用临时 SQLite 库执行真实预览、导入、关闭重开，确认正文和 sourceUrl 保留；临时库已删除。
- 实测本机 DNS 返回 `198.18.0.232`，先被公网限制正确拒绝；加入固定公共 DNS 查询及公网 IP 固定连接后，生产导入成功。没有绕过 SSRF 判断或更改系统设置。

## 拉取与冲突规则（2026-10-07）

- 一次预览指定目录下最多 100 篇PaperMind笔记包，累计上限 8 MB；不下载其他文件。
- 没有本机文档时新增；只有远端修改时更新；只有本机修改时保持本机；双方都变动时明确提示，确认后先创建完整本机冲突副本，再载入远端版本。副本中的讨论 ID 重新分配，引用保持对应。
- 预览后再次检查远端 HEAD、本机正文和讨论、同步记录。任何变化均要求重新预览。
- 所有文档恢复与同步登记放在同一个事务里；中途失败不会留下部分恢复结果。重复确认同一预览不会反复产生副本。
- 已同步的正文、高亮、线程和消息恢复；跨设备旧提案不能直接应用，原设备撤销栈不迁移。恢复后的讨论仍可继续生成新写回并撤销新的操作。
- GitBook/GitHub 如果只改 README.md，拉取使用 Markdown 正文，按唯一原文重新定位讨论和高亮；无法匹配则保留讨论但解除定位。原生 GitBook 评论不转换。
- 不自动删除本机或远端文件。冲突副本可先在PaperMind阅读比较，再由 Agent 读取两份文档整理。

### 验证边界

两套独立 SQLite 数据目录配合显式 FakeGithub，验证上传、换机恢复、再次推回、双方修改、冲突副本、讨论保留、重开后恢复、预览过期状态与事务失败回滚。隔离浏览器环境实际点击了拉取预览、确认、查看副本讨论。未得到用户目标仓库前，不进行真实 GitHub 写入；模拟验收不代表实仓往返已完成。
