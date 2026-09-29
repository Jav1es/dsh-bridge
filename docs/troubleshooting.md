# 排错

按「现象 → 原因 → 处置」组织。先跑自检，它能定位大部分问题：

```powershell
dsh --profile headless "只回复两个字：可以"
```

---

## A. 后端层（dsh 本身）

### `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`

headless profile 默认走 API Key 通道，而你的登录在账号通道。

**处置**：编辑 `~/.dsh/profiles/headless/cordis.patch.yml`：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
```

### `dsh: command not found` / `PATH 里找不到 dsh 命令`

**处置**：确认 `dsh` 可用（`Get-Command dsh`）。脚本会自动回退到 `%APPDATA%\npm\dsh.ps1`；若你的 DSH 装在别处，用 `-DshPath` 显式指定（Skill 方式），或改 `mcp-server/dsh-runner.ps1` 里的候选列表。

### 输出为空但退出码 0

看 **stderr**。dsh 的诊断（含 reasoning）都走 stderr，不作为结果。

---

## B. 桥接层

### `spawn error` / MCP 工具调用直接报错

宿主 spawn 时的 PATH 里没有 `pwsh`。

**处置**：`server.mjs` 已按绝对路径回退（`%ProgramFiles%\PowerShell\7\pwsh.exe`）。若你的 PowerShell 装在非标准位置，设环境变量：

```powershell
$env:DSH_BRIDGE_PWSH = "D:\你的路径\pwsh.exe"
```

### 中文变成乱码

说明任务文本走了命令行或 stdin 管道，而不是临时文件。

**处置**：确认 `scripts/dsh_ask.ps1` 用的是文件传递（读 `task.txt`）；确认中间临时 `.ps1` 是 **UTF-8 带 BOM**。

### `The stream is currently in use by a previous operation`

对 `StandardInput` 同时 `WriteAsync` 又立刻 `Close()`。

**处置**：用文件传递（本项目做法），不要走 stdin。

### 超时了但 dsh 还在后台跑

只 `child.kill()` 了直接子进程。

**处置**：确认超时分支调用了 `taskkill /T /F`（`/T` 是杀整棵树的关键）。

### 调用一直不返回

`tools/call` 是一次性的，没有进度。先确认任务是不是真的长——用 `json_events: true` 手工跑一次看事件流，或先跑 `dsh_status` 确认链路通。

---

## C. Marvis 导入层

### 用「链接添加」导入技能时提示 **`仓库根目录未找到 skill.md 文件，该文件为必需文件`**

Marvis 把 GitHub 链接当作**技能包**处理，要求：

1. 链接域名是 GitHub / skillhub / clawhub
2. 链接下能读到**唯一的**技能包
3. **`SKILL.md` 必须在仓库第一层目录**
4. 必须有开源许可协议（LICENSE）

**原因**：技能被放在子目录里（如 `skill/dsh-bridge/SKILL.md`），不在根目录。

**处置**：让仓库根目录就是技能包。本仓库已按此重构：

```
dsh-bridge/            ← 仓库根 = 技能包根
├── SKILL.md           ← 必须在第一层（大小写：Marvis 自身技能用的是大写 SKILL.md）
├── meta.json
├── scripts/
│   └── dsh_ask.ps1
├── LICENSE            ← 必须有
├── mcp-server/        ← 附带内容，不影响导入
├── docs/
├── assets/
└── README.md
```

导入时填仓库根地址：`https://github.com/Jav1es/dsh-bridge`

### 导入成功但技能不触发

技能的触发靠 `SKILL.md` frontmatter 里的 `description`。若描述写得太泛，要么不触发、要么到处触发。

**处置**：`description` 里同时写清「什么时候用」和「什么时候**不要**用」。本项目的写法可参考根目录 `SKILL.md`。

### MCP 连接卡片显示 `0 tools` 或连不上

1. 手工跑一次握手，确认服务端本身正常（见 [`mcp-reference.md`](./mcp-reference.md)）
2. 确认配置里 `args` 的路径**是绝对路径**且文件存在
3. 确认 `node` 在宿主可见的 PATH 里；否则把 `command` 改成 node 的绝对路径
4. 保存后把开关**关掉再打开**，强制重连

### 长任务在 MCP 通道下拿不到结果

宿主的 `tools/call` 超时短于任务耗时。

**处置**：改用 Skill 通道（走 shell，不受 MCP 超时约束），或把任务拆小、调大 `timeout_seconds`。

---

## D. 安全相关

### 这个桥会不会把我的文件泄出去？

不会主动外发。但要知道**权限是放大的**：装上之后，Marvis 能借 dsh 的手读写本机任意文件。dsh 的每一次 headless 调用都会在自己的会话日志里留痕（`~/.dsh/sessions`），可事后审计。

### 任务文本会到哪里去？

进入 dsh 的会话记录（本机），并随请求发给你所配置的模型服务商。**不要把凭据或密钥写进任务文本。**
