# dsh-bridge

**让腾讯 Marvis 调用本机的 DeepSeek Harness（dsh）。**

Marvis 免费、快，适合干日常；dsh 带完整工具链，适合干重活。这个项目把两者接起来——
Marvis 遇到 **AI 审计/复核** 或 **复杂文档** 时，可以把任务交给 dsh 自主执行，拿回结果。

提供**两种接入方式**，可单独用，也可同时用：

| 方式 | 形态 | 适合 |
|---|---|---|
| **A. Skill** | 一个 Marvis 技能（`SKILL.md` + shell 脚本） | 超长任务（走 shell，无 MCP 超时约束） |
| **B. MCP Server** | 一个零依赖 Node MCP stdio 服务器 | 常态调用（Marvis 把 dsh 当**原生工具**自主选择） |

两者共用同一个后端：本机 `dsh --profile headless "<task>"`。

---

## 前置条件

- **Windows** + 已安装 **DeepSeek Harness（DSH）**，且 `dsh` 在 PATH 里
- **PowerShell 7（`pwsh`）** —— 脚本会按绝对路径回退查找，PATH 里没有也能用
- **Node.js ≥ 18**（MCP 方式需要；Skill 方式不需要）
- headless profile 已配好模型通道（见下方「配置 headless profile」）

### 配置 headless profile（必做，否则会报 MISSING_CREDENTIAL）

`dsh --profile headless` 默认走 `deepseek-official`（需要 API Key）。
若你用的是 DSH 桌面版的账号登录，需要把它指向账号通道：

编辑 `~/.dsh/profiles/headless/cordis.patch.yml`：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
```

自检：

```powershell
dsh --profile headless "只回复两个字：可以"
# 期望 2~3 秒内输出「可以」，退出码 0
```

---

## 方式 A：安装 Skill

把 `skill/dsh-bridge/` 整个目录复制到 Marvis 的自定义技能目录：

```powershell
Copy-Item -Recurse -Force .\skill\dsh-bridge "$env:USERPROFILE\.marvis\skills\custom\dsh-bridge"
```

然后在 Marvis 里新开对话，说一句会触发它的话，例如「审计一下这份报告的数字」。
Marvis 会读到 `SKILL.md` 的说明，自行决定是否调用。

### 直接手测（不经过 Marvis）

```powershell
$s = "$env:USERPROFILE\.marvis\skills\custom\dsh-bridge\scripts\dsh_ask.ps1"
& $s "只回复两个字：可以"

# 长任务用管道传，免转义
@'
请阅读 D:\work 下所有 csv，按「月份 × 品类」汇总销售额，
输出 Markdown 表格 + 一份 xlsx 到 D:\work\out。
'@ | & $s -WorkDir "D:\work" -TimeoutSeconds 1800
```

参数：`-Task` / `-TimeoutSeconds`（默认 900）/ `-WorkDir` / `-SessionId` / `-Json` / `-DshPath`。
退出码：`0` 成功 ｜ `2` 任务为空 ｜ `3` 找不到 dsh ｜ `124` 超时。

---

## 方式 B：接入 MCP Server

### 1. 放到一个固定位置

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.marvis\mcp\dsh-bridge" | Out-Null
Copy-Item .\mcp-server\* "$env:USERPROFILE\.marvis\mcp\dsh-bridge\" -Force
```

### 2. 在 Marvis 里粘贴配置

**技能广场 → 工具箱 → 连接 → 我的连接 → 自定义连接 → 自定义配置 MCP**，粘贴
（`mcp-server/example-config.json`，注意把路径换成你自己的）：

```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "node",
      "args": [
        "C:\\Users\\<你的用户名>\\.marvis\\mcp\\dsh-bridge\\server.mjs"
      ]
    }
  }
}
```

保存后开关打开即可（成功时卡片上会显示 `2 tools`）。

### 3. 暴露的工具

| 工具 | 说明 |
|---|---|
| `dsh_run` | 把任务交给 dsh 自主执行。参数：`task`（必填）、`workdir`、`timeout_seconds`（默认 600，上限 3600）、`session_id`（多轮续跑）、`json_events` |
| `dsh_status` | 自检：dsh 是否连通、退出码、实测答复、错误摘要 |

### 4. 手测 MCP 协议（不经 Marvis）

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dsh_status","arguments":{}}}
'@ | node "$env:USERPROFILE\.marvis\mcp\dsh-bridge\server.mjs"
```

期望第二行返回 `"ok": true`。

---

## 设计要点

- **任务文本经临时文件传给子进程**，绝不拼命令行 —— 中文、换行、引号、超长文本全安全
- **stdout 只输出协议消息**，日志一律走 stderr（否则会污染 MCP 协议流）
- **超时后杀整棵进程树**（`taskkill /T /F`），不留野进程
- **PATH 精简也能活**：`pwsh` 与 `dsh` 都有绝对路径回退，实测在「PATH 只剩 node」时仍可用
- **零运行时依赖**：MCP server 只用 Node 内置模块

## 已知限制

| 限制 | 说明 |
|---|---|
| 客户端工具超时 | MCP `tools/call` 是一次性返回。若 Marvis 的超时上限短于任务耗时，长任务拿不到结果 —— 这类任务改用方式 A（走 shell） |
| 无流式进度 | MCP 调用中途看不到 dsh 在做什么 |
| 输出上限 | 服务端截断在 60000 字符 |
| 并发 | dsh 会真的读写文件，不要让多个任务同时操作同一批文件 |
| 权限 | 装上之后，Marvis 能借 dsh 的手改本机任意文件 —— 请自行评估 |

## 目录结构

```
.
├── skill/
│   └── dsh-bridge/
│       ├── SKILL.md              技能定义（触发条件 + 审计/文档两种用法模板）
│       ├── meta.json             Marvis 技能元数据
│       └── scripts/
│           └── dsh_ask.ps1       带超时/stdin/会话续跑/JSON 的封装
└── mcp-server/
    ├── server.mjs                零依赖 MCP stdio 服务器
    ├── dsh-runner.ps1            一次性 dsh 执行器
    └── example-config.json       粘贴到 Marvis 的配置模板
```

## License

MIT
