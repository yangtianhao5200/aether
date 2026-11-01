# Aether → DSH（DeepSeek Harness）远端适配 — 接手文档

本文档整理自本次会话的全部已完成工作、已交付产物、已知待解决问题及下一步工作线。可直接作为把对话转移给下一个开发者的说明。

---

## 1. 项目基本事实

- 仓库：`/workspace/aether`，当前分支 `main`。
- Git remote：
  - `origin` = `https://github.com/Zhou-Shilin/Aether.git`
  - `target` = `https://yangtianhao5200/aether.git`（身份 `yangtianhao5200`，token `<GITHUB_PAT>`）
- 已提交的最新 commit：`5167ace`（HEAD），工作目录干净（无未提交改动）。
- CI：`.github/workflows/build.yml` 在 `target/main` 上每次 push 都会构建 **release APK**，并上传 artifact `aether-release-apk`（保留 30 天），打 `v*` tag 时自动发布 GitHub Release。`pr-check.yml` 也已改为 release 构建。
- 远端地址：`http://186.241.74.39:3193/aether`，token `<AETHER_TOKEN>`（本地 DSH web 在 `127.0.0.1:3081`，pid 1）。
- 上面的占位符是脱敏后的凭据：真实值保存在本地 `server/src/config.mjs` 的 `dshLaunchToken` 默认值、DSH 客户端常量 `DefaultDshAccessToken`，以及 Aether 服务端的工作区配置中；本仓库不保存明文。

---

## 2. 已交付的 release APK

| 项目 | 值 |
|------|-----|
| 文件 | `/workspace/output/aether-apk-dsh/release/aether-5167ace.apk` |
| Commit | `5167ace` |
| 签名 | APK v2，密钥 `app/release.keystore`（已入库），证书 CN=Aether |
| sha256 | `52dbc9dbdcf5d86d67c609a6b0ea99c47972ad0e1bd2cb6108f9802d14eca47a` |
| 包名 | `com.baimoqilin.aether`（正式 release 包，无 `.debug` 后缀） |
| 可覆盖安装 | 是（同一密钥，可与上一版覆盖安装） |

---

## 3. 本轮已完成的改动（commit `5167ace`）

### A. DSH 主机设置转圈漂移（修复）
`app/src/main/java/com/zhousl/aether/ui/DshHostSection.kt`、`DshConfigSection.kt`：
- 两个加载圈之前只限定高度 `Modifier.height(18.dp)`，宽度未控制，导致圆弧看起来在漂移。
- 已改为固定方形 `Modifier.size(18.dp)`，并补充了 `androidx.compose.foundation.layout.size` 导入。

### B. 远程模式下设置专属优化（修复）
`app/src/main/java/com/zhousl/aether/ui/SettingsScreen.kt`：
- 远程 Agent 已配置时，隐藏只在本地运行有效、对远程无效的设置项：Agent 技能、Pi 扩展、定时任务、手机操作（Agent Mode）、数据统计。
- 模型提供方页面在远程模式下不再显示「添加/编辑/删除提供方」按钮（在手机上配置远程 provider 无效），改为提示「模型提供方由远程 DSH 主机管理，请在此选择默认模型」。

### C. 切换模型卡顿（修复）
`app/src/main/java/com/zhousl/aether/ui/AetherViewModel.kt`：
- 切换模型时会请求公开“思考等级”目录，远程模型的 provider 在本地无法访问，导致切换卡顿。已对 `providerConfigId.startsWith("remote-")` 的选项跳过该网络请求。

### D. 其他已到位
- 远程模式下已实现“每对话独立模型记忆 + 新对话沿用上一对话模型”（`ChatSession.selectedModelKey` 按会话持久化；新建对话通过 `currentConversationModelKey()` 继承当前对话模型），无需改动。
- CI 全量构建通过（run 41254215244，成功）。

---

## 4. 下一步工作线（用户当前要求实现）

以下两点本质是**同一套“以 DSH 服务器为准”的机制**，建议一次性实现：

### 4.1 聊天记录同步到服务器 / 侧边栏自动同步
现状：侧边栏只读手机本地数据库（`ChatRepository.getSessionsWithMessages()`）。
已知可行路径（已实测）：
- DSH 提供 `session/list`：`POST /api/session/list`，信封 `{type:"client-request", rpcId, method:"session/list", payload:{args:{_request:{}}}}`，响应包含 `items[{sessionId, updatedAt, agentAvailable, running, blank, parentSessionId, projections:{kind:"cached", asOfSeq, values:{title, goal, tokenUsage, contextPressure, contextBreakdown, sessionStats}}} ]`。
- DSH 提供 `session/page`：获取某会话的消息分页（用于重开时续显）。

实施建议：
1. 在 `AetherViewModel.refreshDshHost()`（或远程连接成功后）新增 `syncRemoteSessions()`：调用 `runtime.remoteAgentHost.dshRpc("session","list","{_request:{}}")`，把非 blank、非子会话（`parentSessionId` 为空或过滤掉 `origin=="subagent"`）写入本地 `ChatSession`（`ChatRepository.upsertSessionSnapshot`），供侧边栏展示。
2. 用户打开某会话时，若本地无消息，则通过 `session/page` 拉取服务端消息并映射为 app 的 `ChatMessage`（需处理分段、工具调用、角色映射）。这是最容易破坏现有收发的地方，**务必在 CI 打包后用真机反复验证发消息/收响应不回弹、不重复**。

### 4.2 任务执行中退出应用→重开接回（断线续跑）
根因：app 端把远程当“子进程”（`PiKernelBridge` / `RemoteAgentHost` 维护一条 WS），进程一走，本地就丢了本次 turn 的流式状态；服务端 DSH 本身仍在跑。
实施建议：
- 重连/重开应用后，对当前会话（或最新一条 `running==true` 的会话）通过 `session/page` 按 `asOfSeq` / 游标拉取最新消息，并把流式状态（`pendingResponseBlocks`、`pendingAssistantText`、`sessionExecutionStates`）恢复到 UI，让用户感觉“任务没中断”。
- 与 4.1 共享“从服务器拉会话/消息”的同一套逻辑。

---

## 5. 关键文件与入口（下手建议）

- `app/src/main/java/com/zhousl/aether/ui/AetherViewModel.kt`
  - `refreshDshHost()`（约行 2427）：远程连接成功后加载主机信息、模型目录；可在此处追加 `syncRemoteSessions()`。
  - `setCurrentChatModelSelection(...)`（约行 2848）：按会话持久化模型。
  - `currentConversationModelKey(...)`（约行 1831）：新对话继承当前模型。
  - `loadDshModelCatalog()`（约行 2550）：`session/modelCatalog` 调用示例。
- `app/src/main/java/com/zhousl/aether/runtime/remote/RemoteAgentHost.kt`：`dshRpc(namespace, method, argsJson)` 与 `activeClient()`，用于向 DSH 发 RPC（`session/list`、`session/page`）。
- `app/src/main/java/com/zhousl/aether/data/ChatRepository.kt`：`upsertSessionSnapshot`、`getSessionsWithMessages`、`getSessionWithMessages`，本地会话/消息写入。
- `app/src/main/java/com/zhousl/aether/ui/AetherUiState.kt`：`ChatSession`（行约 231）与 `AetherUiState.sessions` / `currentSessionId`。
- `shared/src/commonMain/kotlin/com/zhousl/aether/remote/RemoteAetherClient.kt`：`dshRpc`/`dshRpcJson`，共享模块 RPC 封装（bridge 层）。
- `server/src/workspace-hub.mjs`：hub 客户端连接/空闲关闭逻辑（`detach` 后 30 分钟空闲关闭 bridge）。
- `server/src/journal.mjs`：桥帧日志（当前是摘要而非原始帧，不适合直接重放，建议不依赖 journal 做续跑，改用 `session/page`）。

---

## 6. 构建与发布命令

- 推送触发 CI：`git push target main`（会自动在 `target` 仓库构建 release APK）。
- 工作流：`.github/workflows/build.yml`，job `Android Release APK`，执行 `:app:assembleRelease`，上传 artifact `aether-release-apk`。
- 本地不编译（用户要求），所有包均由 GitHub Actions 产出并放在 `/workspace/output/aether-apk-dsh/release/`（下载自 CI artifact）。

---

## 7. 已知遗留风险 / 提醒

- 历史记录同步和断线续跑涉及改动会话/消息数据层，**有回弹、重复、丢消息的风险**，必须在真机上完成：发消息 → 退出应用 → 重开，确认响应续显且不重复；以及配置 agent 后打开应用，确认侧边栏出现服务端会话。
- 服务端 idle 超时默认 30 分钟（`AETHER_IDLE_TIMEOUT_MINUTES`，Dsh 插件中默认 30），bridge 空闲后会停止，重连时会自动 `ensureStarted()` 重启，无需额外处理。
- `app/release.keystore` 已入库，后续所有 CI release 包使用同一密钥，可互相覆盖安装；如需更换密钥，设置环境变量 `RELEASE_KEYSTORE_FILE/PASSWORD/KEY_ALIAS/KEY_PASSWORD` 即可（`app/build.gradle.kts` 已支持）。

---

## 8. 如何把这个对话转移下去

把 `/workspace/AETHER_DSH_HANDOFF.md` 与 `/workspace/aether` 仓库（已 push 到 `target/main`）一并交给下一位开发者，并告知：
1. 最新 release APK 在 `/workspace/output/aether-apk-dsh/release/aether-5167ace.apk`（sha256 见上）。
2. 下一件事就是实现第 4 节的“以服务器为准”的聊天记录同步 + 断线续跑，优先处理 `session/list` → 侧边栏，再做 `session/page` → 续显。
