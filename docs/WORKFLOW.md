# PaperMind：Agent 写作、浏览器学习、私有知识库同步

PaperMind 是阅读与讨论工具；GitHub 私有知识库保存你的笔记。程序源码和学习内容使用两个独立仓库。GitBook 和 GitHub Pages 都不是这套流程的前提。

## 1. 首次安装

需要 Node.js 24+、Git 和 GitHub CLI (`gh`)。先用 `gh auth login` 登录自己的 GitHub 账号。

```sh
git clone https://github.com/zaozhiyi/PaperMind.git
cd PaperMind
npm ci
npm run build
npm link
papermind --background
```

浏览器访问 `http://127.0.0.1:4317/`。默认只允许本机访问，Chrome、Safari 等均可使用。在设置中连接自己的模型账号。后台运行后，关闭终端或浏览器不影响服务；电脑重启后需重新执行 `papermind --background`。

## 2. 绑定私人知识库

在个人账号下新建私有仓库并初始化 README，或者使用已有的独享私有仓库：

```sh
gh repo create YOUR_ACCOUNT/KnowledgeBase --private --add-readme
papermind sync setup YOUR_ACCOUNT/KnowledgeBase
papermind sync now
papermind sync status
```

请替换 `YOUR_ACCOUNT`。不要把知识库设为 public。自动同步只接受当前账号拥有、没有其他协作者和待接受邀请的私有仓库。绑定后，手动上传也仅允许发往这个知识库。GitHub 的 private 隐藏仓库名和内容，没有“公开标题、正文保密”的独立开关。若将来想公开介绍，可另建一份公开介绍，知识库仍然保持私有。

默认同步 PaperMind 中所有文档，包括以后新建的文档。排除欢迎页或测试文档时，可在配置命令后添加 `--exclude UUID1,UUID2`；重新配置不传此参数会保留原排除清单。自定义目录或分支可通过本机 `/api/knowledge/configure` 接口配置。

## 3. 日常使用

向 Codex 或其他本地 Agent 提出写作要求，并补充：

> 把最终学习笔记交付给 PaperMind。新文档用 `papermind notes import 文件.md`，返回阅读链接。修改旧文档前先 `papermind notes get 文档ID` 读取当前版本，再使用 `--id 文档ID --revision 当前版本号` 更新，保留我的高亮和讨论。

```sh
papermind notes import ./学习笔记.md
papermind notes list
papermind notes get DOCUMENT_ID
papermind notes import ./更新稿.md --id DOCUMENT_ID --revision 3
```

进入浏览器阅读、编辑和讨论。选段讨论可以融入正文；整篇 AI 对话属于当前文章。PaperMind 在后台每 2 分钟检查一次 GitHub；也可在「同步到 GitHub」窗口点击「立即同步」，或运行 `papermind sync now`。

同步的是已经保存、交付给 PaperMind 的内容。Agent 只在别的文件夹写了 Markdown、尚未交付时，不会被自动搜集上传。首次整理的 `archive/` 是原始材料快照，不会反向覆盖 PaperMind 的新内容；之后以 PaperMind 当前文档为准，避免同时维护两份正文。

## 4. 换电脑

在另一台电脑完成安装，登录**同一个 GitHub 账号**，绑定已有知识库，然后 `papermind sync now`。它会先拉取已有笔记，再上传本机新增或修改的文档。模型账号需在新电脑另行登录，登录凭据不随笔记同步。

各篇笔记位于 `learning-notes/文档ID/`：

- `README.md`：可直接在 GitHub 阅读、编辑的正文。
- `document.json`：保留高亮、表格和批注位置的结构化正文。
- `comments.json`：选段讨论、修改建议、整篇 AI 对话。

直接在 GitHub 修改 README 也能拉回；仅用 Markdown 表达不了的排版可能变化。归档附件保留在 `archive/`，可登录 GitHub 后查看，或用 `gh repo clone YOUR_ACCOUNT/KnowledgeBase` 下载全套材料。旧的本地撤销栈、未绑定文章的历史通用聊天、模型凭据和机器设置不属于文档同步包。

## 5. 同步失败与冲突

- 断网：笔记继续保存在本机，恢复网络后重试；退出电脑前可执行 `papermind sync now` 确认。
- 两边同时改同一篇：自动同步停止本轮写入。在浏览器「从 GitHub 拉取」中预览并处理，应用后会保留完整本机冲突副本。比较两个版本、完成整理后再同步。
- 仓库变为公开、增加协作者或邀请：拒绝上传，先恢复独享私有权限。
- 同步状态与失败原因：在「同步到 GitHub」窗口查看，或用 `papermind sync status`。
- 暂停：`papermind sync pause`；恢复：再次 `papermind sync setup YOUR_ACCOUNT/KnowledgeBase`。

同步不会删除远端其他文件，不会强制覆盖 GitHub 分支。电脑关机、休眠或 PaperMind 停止时不会同步；这不是云端常驻服务。多个电脑尽量不要同时修改同一篇文章。

## 6. 备份边界

私有 GitHub 仓库保存版本历史，但不等于端到端加密。请保留本机备份。完整本机数据默认在 `~/.local/share/study-workbench/`，复制数据库备份前停止 PaperMind；不要把该目录整体提交到 GitHub，因为其中也包含机器设置和模型登录资料。
