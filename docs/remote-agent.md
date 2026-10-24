# 把 Aether 的 Agent 放到服务器上运行

Aether 默认在手机本地（Android 的 Alpine VM / iOS 的 iSH）里运行 Pi Coding Agent。
本文档说明如何把 **Agent 本体迁移到服务器**：手机只负责界面与实时同步，文件、命令、
终端、工具调用全部发生在服务器的工作区里，Agent 能力保持不变。

- 服务器端代码：`server/`（Node.js，无第三方服务依赖，仅 `ws`）
- 共享层客户端：`shared/src/commonMain/kotlin/com/zhousl/aether/remote/`
- Android 适配：`app/src/main/java/com/zhousl/aether/runtime/remote/`
- 桥接协议：`pi-bridge/src/bridge.ts`（新增 `runtime: "server"`）

---

## 0. 原理（先看懂这一节，后面就不会迷路）

```
手机 App                                  服务器
┌───────────────────────┐                ┌────────────────────────────────┐
│ Compose/SwiftUI 界面   │                │ aether-server                  │
│  ↓                     │  WebSocket     │  ├─ workspace hub              │
│ PiBridgeClient         │◀──────────────▶│  │   ├─ pi-bridge (bridge.mjs)│
│  （与本地完全同一套）   │  JSON 行协议   │  │   ├─ journal（实时日志）    │
│  ↑ 实时事件/工具调用    │                │  │   └─ fs / exec / process   │
└───────────────────────┘                └────────────────────────────────┘
```

关键点：

1. **协议完全不变**。手机侧仍然是 `SharedPiBridgeClient`（iOS）或
   `PiKernelBridge`（Android），只是它读写的「进程」从本机 Alpine 换成了
   服务器上的桥接进程（Android 用一个 `java.lang.Process` 子类把 WebSocket
   伪装成本地进程，因此上层代码一行没改）。
2. **路径由服务器下发**。`hello` 帧里带 `paths.home / workspace / agent /
   bridge / extensions`，手机直接使用这些绝对路径，不做任何映射。
3. **实时同步**。服务器把桥接进程的每个事件（文本增量、思考增量、工具调用、
   工具结果）广播给该工作区的**所有**客户端，并写入 `journal/*.jsonl`；
   断线重连可用 `resume.since` 回放。
4. **设备侧能力保留**。需要手机的宿主工具（浏览器/手机使用/Agent 模式、
   Aether 扩展的宿主侧动作）仍通过 `host_tool_request` 回到手机执行。

---

## 1. 服务器准备

### 1.1 环境

- Node.js ≥ 22（推荐 24）
- 一台手机能访问到的 Linux/macOS 机器（内网、VPN 或 Tailscale 都行）
- 磁盘：每个工作区 ≈ 几百 MB（含 node_modules 缓存）

### 1.2 构建 Pi 桥接包（只需一次）

```bash
git clone https://github.com/Zhou-Shilin/Aether.git
cd Aether/pi-bridge
npm ci
npm run build          # 产出 dist/bridge.mjs、dist/extension-bridge.mjs 等
```

> 若构建时内存不足：`NODE_OPTIONS=--max-old-space-size=4096 npm run build`

### 1.3 启动服务器

```bash
cd ../server
npm ci

node bin/aether-server.mjs \
  --host 0.0.0.0 \
  --port 8787 \
  --data-dir /var/lib/aether \
  --token "$(openssl rand -hex 24)"
```

启动后会打印：

```
aether-server 1.0.0 listening on http://0.0.0.0:8787
dashboard: http://0.0.0.0:8787/dashboard
token: <这一串就是手机要填的访问令牌>
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--host` | 默认 `127.0.0.1`；要让手机连就必须 `0.0.0.0` |
| `--port` | 默认 8787 |
| `--data-dir` | 工作区与日志目录，默认 `./data` |
| `--token` | 可重复，格式 `token` 或配合 `--token-user` 区分用户 |
| `--token-file` | JSON 令牌文件，适合多用户 |
| `--bridge` | 桥接包路径，默认自动找 `pi-bridge/dist/bridge.mjs` |
| `--idle-timeout` | 无客户端后多久回收桥接进程（分钟，0 关闭） |
| `--max-workspaces` | 同时运行的桥接进程上限（默认 8） |
| `--webhook` | 把精简后的 Agent 活动 POST 到外部（可选） |
| `--log-level` | `debug` / `info` / `warn` / `error` |

### 1.4 验证服务器

```bash
curl -H "Authorization: Bearer <token>" http://<服务器IP>:8787/healthz
curl -H "Authorization: Bearer <token>" http://<服务器IP>:8787/v1/info
```

浏览器打开 `http://<服务器IP>:8787/dashboard`，填入地址、令牌、工作区名
（默认 `default`），点连接即可看到 Agent 的实时输出——这同时也是排查问题的
最快手段。

### 1.5 安全建议

- 不要把 8787 直接暴露到公网。推荐：内网 / Tailscale / WireGuard，
  或前置 Nginx/Caddy 做 TLS + 额外鉴权。
- 服务器上的桥接进程以当前用户身份执行 `bash`，**不要用 root 跑**。
- 令牌只存在于内存（哈希后比较），换令牌就重启服务器。

---

## 2. 手机端设置

> Aether 已切换为纯远程形态：首次启动的引导流程是
> **欢迎 → 连接你的 Agent → 模型**，不再有「安装本地 Alpine」这一步。
> 没有配置服务器时，聊天页只显示「连接你的 Agent」卡片，不会偷偷退回本地运行。

### Android

1. 首次启动会在引导第 2 步直接让你连接服务器（地址 + 令牌 + 工作区），
   也可以事后从 **设置 → 远程 Agent**（设置页里新增的入口，图标为服务器）进入。
2. 填写：
   - **服务器地址**：`http://192.168.1.10:8787`（支持 `https://`、`ws://`，
     也接受裸的 `IP:端口`）
   - **访问令牌**：服务器启动时打印的那串
   - **工作区**：默认 `default`，多项目时可用不同名字
3. 点 **测试连接** → 显示「连接正常」并回显服务器工作区路径。
4. 打开 **使用远程 Agent** 开关 → **保存**。

> 开启后本机 Alpine 完全不参与 Agent 运行：启动时不再检查/安装本地运行时，
> 聊天页在未配置服务器时直接显示连接卡片。Alpine 只剩开发者预览和
> 「重放引导」这两条入口，正常用户走不到。

### iOS

1. 打开 **设置 → 远程 Agent**（原生设置页里的同名入口）。
2. 同样填写地址、令牌、工作区，点 **测试连接**，再打开开关保存。
3. 返回聊天页即可。切换开关时会自动丢弃旧的桥接进程，下一次对话走新主机。

### 行为说明

- 首次开启后，App 会立即连接并在后台维持 WebSocket；网络切换、服务器重启
  会自动重连（设置里的「自动重连」）。
- 关掉开关即回到本机运行，两边的会话互不影响（服务器会话保存在服务器的
  `home/.pi` 与 `.aether/agent-sessions`）。
- 关闭开关不会删除服务器上的任何数据。

---

## 3. 验证清单

| 检查项 | 预期结果 |
| --- | --- |
| `测试连接` | 显示服务器版本/工作区路径 |
| 发一条消息 | 手机正常流式输出；服务器 `journal/` 里出现同名帧 |
| 让 Agent 执行 `ls` | 输出的是**服务器**目录内容 |
| 让 Agent 写文件 | 文件出现在 `<data-dir>/users/<user>/<ws>/workspace/` |
| 浏览器 dashboard | 与手机同时看到同一段流式输出 |
| 杀掉服务器进程再重启 | 手机自动重连，历史会话仍在 |

命令行侧也可以直接验证（不需要手机）：

```bash
cd server
npm test     # 13 个用例，含一次真实的端到端 Agent 回合
```

---

## 4. 多设备与实时同步

- 同一 `user + workspace` 允许多个客户端同时连接（手机、平板、浏览器、
  DeepSeek Harness）。
- 所有客户端共享**同一个**桥接进程与会话：一台设备发起的回合，其他设备能
  实时看到文本增量与工具调用；`steer`（插话）与 `abort`（中止）同样对所有
  人生效。
- 每帧都会写入 `<data-dir>/users/<user>/<ws>/.aether/journal/YYYY-MM-DD.jsonl`，
  断线重连时可用 `resume.since` 回放遗漏内容。
- 需要外部系统接收活动记录时，用 `--webhook https://...`：每帧精简后以 NDJSON
  POST 出去（已剔除 `data_base64`、截图等大字段）。

---

## 5. 在 DeepSeek Harness 中运行

`server/src/dsh-plugin.mjs` 是一个 cordis 插件，可以直接挂到 DeepSeek Harness：

```yaml
# cordis.patch.yml
plugins:
  aether-remote-server:
    host: 0.0.0.0
    port: 8787
    dataDir: /var/lib/aether
    tokens:
      - token: "<token>"
        user: default
```

```bash
dsh plugin --profile web add /path/to/Aether/server
```

挂载后手机端配置方式与独立运行完全一致（地址 + 令牌 + 工作区）。Harness 内的
其它插件可以通过 `ctx.get('aetherRemoteServer')` 拿到服务器实例。

### 5.1 让 Agent 本身跑在 DeepSeek Harness 上

默认的桥接包跑的是 Pi 编码 Agent。如果想让 Agent 直接由 DeepSeek Harness
执行（使用 Harness 的模型目录、工具、权限与插件生态），把服务器切到 `dsh`
运行时即可，手机端不用改任何设置：

```bash
AETHER_RUNTIME=dsh \
DEEPSEEK_API_KEY=sk-... \
aether-server --host 0.0.0.0 --port 8787
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AETHER_RUNTIME` | `pi` | `pi` 或 `dsh` |
| `AETHER_DSH_HOME` | `$DSH_HOME` | Harness 主目录（含 profile 与凭据） |
| `AETHER_DSH_ARGS` | `--profile acp` | 传给 Harness 启动器的参数 |
| `AETHER_DSH_BRIDGE` | `<包>/bin/dsh-bridge.mjs` | 桥接脚本路径 |

原理：`server/src/dsh-bridge/` 用 ACP（Agent Client Protocol，JSON-RPC stdio）
驱动 `dsh --profile acp`，再把 Harness 的事件翻译成手机端已经在用的桥接协议：

| Harness（ACP）事件 | 手机端收到的事件 |
|---|---|
| `agent_message_chunk` | `assistant_text_delta` |
| `agent_thought_chunk` | `assistant_reasoning_delta` |
| `tool_call` / `tool_call_update` | `tool_call_start` / `tool_call_delta` / `tool_call_end` |
| `usage_update` | `context_usage` |
| `PromptResponse.usage` | 本轮用量（`assistant_done`） |

模型列表来自 Harness 的 `model` 配置项，手机端的模型选择、思考强度
（`reasoning_effort`）都会同步过去；权限请求默认选 Harness 的 `allow_*` 选项，
需要人工审批时应在 Harness 侧配置策略。

> 注意：ACP 只承载标准语义（文本、思考、工具调用、用量）。Harness 网页端特有的
> 计划/待办卡片不在 ACP 里，手机端目前显示为普通工具卡片。

---

## 6. 数据与备份

```
<data-dir>/users/<user>/<workspace>/
├── home/            Agent 的 HOME：~/.pi（凭据、会话）、~/.aether（扩展）
├── workspace/       Agent 的工作目录（你的项目文件）
└── .aether/journal/ 每日 JSONL 活动日志
```

- 备份：直接打包 `<data-dir>` 即可。
- 迁移：把整个目录拷到新机器，用同样的 `--data-dir` 启动。
- 清理：删除对应 `users/<user>/<workspace>` 目录（先停服务器）。

---

## 7. 常见问题

**手机提示「连接失败 / 401」**
- 检查令牌是否带了多余空格；
- `curl` 一下 `/v1/info` 看是否 401（说明令牌不对）还是连不上（防火墙/绑定地址）；
- `--host 127.0.0.1` 时只有本机能连，手机必须用 `0.0.0.0` 或具体网卡地址。

**连接正常，但一发消息就报 `bridge_unavailable`**
- 服务器日志里找 `bridge.start_failed`，通常是 `pi-bridge/dist/bridge.mjs`
  没构建（执行 `npm run build`），或 Node 版本过低。
- 可用 `--log-level debug` 看到完整帧往来。

**Agent 说找不到文件 / 路径不对**
- 远程模式下工作区是服务器的 `paths.workspace`，不是手机里的 `/workspace`。
  设置页的「测试连接」会显示真实路径。

**iOS 一直显示未就绪**
- 远程模式下 `isReady` 取决于握手是否成功；先在设置里点「测试连接」，
  失败时错误会显示在设置页。

**想临时切回本机**
- 关闭「使用远程 Agent」开关并保存即可，无需重启 App。

---

## 8. 当前版本的支持范围

已完整支持（与本地一致）：

- 对话、流式文本/思考增量、工具调用与结果展示
- 全部内置工具：`read` / `write` / `edit` / `bash` / `grep` / `glob` / `web_*`
- 会话持久化、分支、压缩、`steer` / `follow_up` / `abort`
- 技能（Skills）在服务器工作区发现与加载
- 扩展（Pi Extensions）在服务器 `~/.aether/extensions` 加载
- 服务器端长驻进程（扩展桥、MCP、终端）：`srv_process_*`
- 多设备实时同步、journal 回放、Webhook

仍属设备侧、远程模式下不参与 Agent：

- Alpine 专属功能：本地终端、本地文件管理器、DocumentsProvider、VM 内 Chrome
- 手机使用 / Agent 模式 / 浏览器预览等宿主工具（这些本来就该在手机上跑，
  远程模式下依然可用）

> 注意：Android 的「Agent Skills」列表页在远程模式下仍按本机路径解析，
> 列表可能为空；但 Agent 在服务器侧仍能正常发现并使用工作区里的技能。
> 该 UI 适配留待后续版本。
