# 文档 Agent 接入

本产品使用 `@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core` **1.0.3**，应用需要 Node.js 24 以上。它没有启动 Codex CLI 或 App Server，没有读取 Codex、Pi 或环境变量中的已有凭证。

## 当前实现

`createAIService(dataDir?)` 创建服务。应用入口将 `STUDY_DATA_DIR` 或 `~/.local/share/study-workbench/` 传入；仅单独调用模块且不传目录时，回退到 `STUDY_DATA_DIR` 或 `~/.study-workbench`。

- `status()`：安全的模型目录、当前模型和配置状态。模型目录来自 SDK，**不表示账号实际有权调用所有模型**。
- `startLogin()`：立即返回 `{id,status:'starting'}`。轮询 `loginState(id)` 获取授权链接及结果。
- `submitLoginInput(id, fullCallbackUrl)`：供用户手动粘贴完整回调地址，验证地址及本次 OAuth state。
- `cancelLogin(id)`：取消登录并释放回调监听。
- `configure({provider?,model,apiKey?})`：设置模型；provider 缺省沿用当前值。API Key 仅允许 OpenAI，配置 API Key 将替换 OpenAI 的订阅凭证。
- `run({messages,context,mode,signal,onEvent,tools})`：真实模型生成，参见 `server/ai-types.ts`。

默认 `openai` 使用 Pi 新版 **Sign in with ChatGPT**（SIWC）。SDK 在 `127.0.0.1:1455/auth/callback` 监听，向 OpenAI 登录后得到独立授权；每个安装持久化稳定设备 ID。SDK 注册名称目前是 Pi。凭证存储在应用自己的 `ai-credentials.json`，权限 `0600`，不通过状态接口返回。OAuth 刷新由 SDK 在串行 credential-store 修改中执行。

保留 `openai-codex` 的模型目录仅用于兼容选择；当前 UI 登录只创建新版 OpenAI SIWC 凭证，不提供 legacy Codex 登录入口。没有隐式使用 `OPENAI_API_KEY`，也不会在订阅失败后自动切换付费 API。

## Harness 权限

- `chat`：只读文档和回答。
- `workspace`：保留的兼容 API，可按用户明确请求创建文档；当前 UI 使用按文章保存的 `chat`，不再呈现独立聊天入口。
- `create`：可调用 `create_document({title,content})`；回调收到 `{title,html}`。
- `revise`：必须有文档及选区，可调用 `propose_edit({replacement,explanation})`。仅生成修改建议，由主服务完成版本检查、精确定位和用户应用。
- `writeback`：用户点击「讨论融入正文」后执行一次保存，无需二次确认；版本和锚点检查通过后原子写入，允许撤销。
- 模型仅能使用上述注册工具；无 Shell、磁盘搜索、任意网络工具。
- 写工具每个请求最多成功一次。成功后结束工具回合，防止模型重复写入。
- 主服务必须对工具回调中的 HTML 做白名单清洗，并负责事务、修订号、锚点及提案保存。模型输出始终不可信。

前端事件只包含文字 delta、工具名称/阶段和完成 DTO。推理内容、工具原始参数、凭证、上游原始错误不会转发。用户停止、8 回合上限、180 秒超时都会中止 Agent。对话历史由文档服务保存，并在下次请求中传入，不依赖一个常驻 Agent 对象。

## 验证边界

2026-10-06 真实账号验收中，`gpt-5.4` 被上游明确拒绝为当前 ChatGPT 账号不支持的模型；切换 `gpt-6.1-sol` 后已成功生成文档。因此新安装默认选择 `gpt-6.1-sol`，既有设置保留。模型不支持时提示切换模型，不要求重复授权。不同账号的可用模型仍由服务商决定。

`npx tsx --test tests/ai.test.ts` 验证无凭证拒绝、持久化、0600 权限、新 SIWC 授权 URL、回调 state 拒绝、取消后释放 1455 端口，以及上游模型不支持错误的分类。自动测试没有完成授权或向模型发起请求；生产代码没有模拟答案。

2026-10-06 已另行完成真实账号的浏览器验收：GPT-6.1 Sol 创建文档、原文选区三轮问答、依据讨论生成列表提案、用户应用、撤销及主服务进程重启恢复。选区外正文逐结构一致，人工追加的学习笔记保留，三轮讨论、高亮及撤销状态在重启后完整恢复。私人验收截图和本机数据不随源码发布，公开验收范围见 `docs/RELEASE.md`。该验收证明当前账号和模型的核心链路，不代表所有账号或目录中所有模型均可用。
