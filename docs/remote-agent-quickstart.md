# 远程 Agent 接入速查（本机 / 公网）

本机已安装并配置好 Aether 远程 Agent（DeepSeek Harness 运行时）。本文是重启后的
最短接入路径。

## 当前状态

| 项 | 值 |
|---|---|
| 挂载路径 | `/aether`（挂在 DeepSeek Harness web 服务器上） |
| 公网地址 | `http://186.241.74.39:3193/aether` |
| 手机 WebSocket | `ws://186.241.74.39:3193/aether/v1/agent` |
| 访问令牌 | `aether-811f08ec6a3c059c` |
| 工作区 | `default` |
| Agent 运行时 | DeepSeek Harness（ACP），模型 `inside/deepseek-v4.1-flash` |

## 重启验证（30 秒）

```bash
curl -fsSL http://127.0.0.1:3081/aether/healthz
# {"ok":true,"version":"1.0.0","protocol":1,...}

curl -fsSL -H "Authorization: Bearer aether-811f08ec6a3c059c" \
  "http://127.0.0.1:3081/aether/v1/pair" | head -c 300
```

## 手机接入（一条连接串）

打开 App 引导第 2 步「连接你的 Agent」（或 设置 → 远程 Agent），点 **粘贴连接信息**：

```
aether://186.241.74.39:3193/aether/v1/agent?token=aether-811f08ec6a3c059c&workspace=default
```

再点 **测试连接** → 「已连接」→ **连接并继续**。

## 相关文件

| 文件 | 用途 |
|---|---|
| `$DSH_HOME/profiles/web/cordis.patch.yml` | 挂载条目（mountPath / 令牌 / 模型路由） |
| `server/config/acp-inside-provider.yml` | ACP 用的 provider（`inside`）补丁 |
| `scripts/restart-dsh-web.sh` | 重启并自检挂载 |

## 换令牌 / 换模型

1. 编辑 `$DSH_HOME/profiles/web/cordis.patch.yml` 里的 `tokens[0].token`
   （或 `server/config/acp-inside-provider.yml` 里的 `provider`/`model`）
2. 执行 `bash /workspace/aether/scripts/restart-dsh-web.sh`
3. 手机端用新令牌重新粘贴

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| App 报 `unexpected end of stream` | 路由未挂上（没重启） | 跑重启脚本，验证 `/aether/healthz` |
| 报 token 无效 / 4401 | 令牌不一致 | 改 patch + 重启 |
| `curl` 返回 404 | 同上，路由不存在 | 同上 |
| 超时 | 网络层 | 公网只放行 3193 |
