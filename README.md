<p align="center">
  <img src="assets/icon.png" width="160" alt="dsh-bridge">
</p>

<h1 align="center">dsh-bridge</h1>

<p align="center">
  <b>让腾讯 Marvis 调用本机 DeepSeek Harness</b>
</p>

<p align="center">
  <a href="https://github.com/Jav1es/dsh-bridge/actions/workflows/ci.yml"><img src="https://github.com/Jav1es/dsh-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="License"></a>
  <img src="https://img.shields.io/badge/Platform-Windows-0078d4" alt="Platform">
  <img src="https://img.shields.io/badge/Node-%E2%89%A518-339933" alt="Node">
  <img src="https://img.shields.io/badge/MCP-2_tools-7c3aed" alt="MCP tools">
  <img src="https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-6%2F6_%E9%80%9A%E8%BF%87-059669" alt="Tests">
  <img src="https://img.shields.io/badge/PowerShell-7-5391FE" alt="PowerShell">
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a>
</p>

> 一个 Skill + 一个 MCP Server，把本机 DeepSeek Harness 变成 Marvis 的「复核员 + 重活工」。

Marvis 免费、快，适合干日常；DeepSeek Harness（下称 dsh）带完整工具链——读写文件、跑脚本、搜索、生成 docx/xlsx/pptx——适合干重活。本项目把两者接起来：**Marvis 遇到 AI 审计/复核或复杂文档时，把任务交给 dsh 自主执行，拿回结果。**

我平时用 Marvis 处理绝大多数事情，但有两类活儿交给它我不放心：一是**要交出去、错了会难看的产出**，需要第三方复核；二是**长文档与批量文档处理**，需要多步工具编排并落盘。而 dsh 跑在本机、走我自己的账号，不额外花钱——所以我做了这个桥，让 Marvis 需要时能把活派过去。

---

## 📖 目录

- [✨ 两种接入方式](#-两种接入方式)
- [🚀 快速开始](#-快速开始)
- [🧪 实测记录](#-实测记录)
- [🔧 MCP 工具说明](#-mcp-工具说明)
- [🛠 设计要点](#-设计要点)
- [⚠️ 已知限制](#️-已知限制)
- [📁 仓库结构](#-仓库结构)
- [📚 文档](#-文档)
- [📢 诚信说明](#-诚信说明)
- [📄 License](#-license)

---

## ✨ 两种接入方式

| 方式 | 形态 | 适合 | 依赖 |
|---|---|---|---|
| **A. Skill** | Marvis 技能（`SKILL.md` + PowerShell 封装） | **超长任务**（走 shell，不受 MCP 调用超时约束） | 无 |
| **B. MCP Server** | 零依赖 Node MCP stdio 服务器 | **常态调用**——Marvis 把 dsh 当原生工具**自主判断**调不调 | Node ≥ 18 |

两者共用同一个后端：本机 `dsh --profile headless "<task>"`，可单独用，也可同时装。

**该用 A 还是 B？** 我两条都留着了：日常让 Marvis 自己决定 → 走 B；跑那种几分钟起步的长任务 → 走 A，避免被 MCP 客户端超时掐断。

---

## 🚀 快速开始

### 前置条件

- **Windows** + 已安装 **DeepSeek Harness**，`dsh` 在 PATH 里
- **PowerShell 7（`pwsh`）**——脚本带绝对路径回退，PATH 里没有也能用
- **Node.js ≥ 18**（仅 B 方式需要）

### 第一步：配置 headless profile（必做）

`dsh --profile headless` 默认走 `deepseek-official`（要 API Key）。若你用的是 DSH 桌面版的账号登录，需把它指向账号通道——编辑 `~/.dsh/profiles/headless/cordis.patch.yml`：

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

> 若报 `MISSING_CREDENTIAL`，就是这一步没配好。

### 方式 A：安装 Skill

**推荐：在 Marvis 里用「链接添加」直接导入**

打开 **技能广场 → 工具箱/连接 → 链接添加**，填入仓库根地址：

```
https://github.com/Jav1es/dsh-bridge
```

> ⚠️ 这条链接必须是**仓库根**。Marvis 会把整个仓库当作一个技能包处理，要求 `SKILL.md` 位于**第一层目录**——本仓库已按此组织（见[排错文档](docs/troubleshooting.md#c-marvis-导入层)）。

**备选：手动安装**

```powershell
git clone https://github.com/Jav1es/dsh-bridge "$env:USERPROFILE\.marvis\skills\custom\dsh-bridge"
```

然后在 Marvis 里说一句会触发它的话，例如「审计一下这份报告的数字」。Marvis 会读 `SKILL.md` 自行决定是否调用。

直接手测（不经 Marvis）：

```powershell
$s = "$env:USERPROFILE\.marvis\skills\custom\dsh-bridge\scripts\dsh_ask.ps1"
"只回复两个字：可以" | & $s     # 长任务推荐用管道传，免转义
```

### 方式 B：接入 MCP Server

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.marvis\mcp\dsh-bridge" | Out-Null
Copy-Item .\mcp-server\* "$env:USERPROFILE\.marvis\mcp\dsh-bridge\" -Force
```

在 Marvis 里打开 **技能广场 → 工具箱 → 连接 → 我的连接 → 自定义连接 → 自定义配置 MCP**，粘贴（把用户名换成你自己的）：

```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USERNAME\\.marvis\\mcp\\dsh-bridge\\server.mjs"]
    }
  }
}
```

保存后打开开关，卡片上出现 **`2 tools`** 即接入成功。

---

## 🧪 实测记录

以下均为本机真实执行结果，非估算。

**Skill 方式（`dsh_ask.ps1`，6/6 通过）**

| # | 用例 | 结果 |
| :-- | :-- | :-- |
| T1 | 位置参数（含中文） | ✅ 返回 `可以`，退出码 0 |
| T2 | `"文本" \| .\dsh_ask.ps1` 管道传入 | ✅ 返回 `完成`，退出码 0 |
| T3 | `-Json` 事件流 | ✅ 8 行 NDJSON，类型 `session/status/thinking/text/final` |
| T4 | 空任务 | ✅ 退出码 2（参数错） |
| T5 | `-WorkDir` 指定工作目录 | ✅ 返回 `工作`，退出码 0 |
| T6 | 多行 + 单双引号混合 | ✅ 正确送达，返回 `多行`，退出码 0 |

**MCP 方式（走真实 JSON-RPC 协议）**

| 用例 | 结果 |
| :-- | :-- |
| `initialize` 握手 | ✅ `serverInfo: dsh-bridge v1.0.0` |
| `tools/list` | ✅ 返回 2 个工具 |
| `dsh_status` | ✅ `ok=true, exit_code=0, reply="可以"` |
| `dsh_run` 简单任务 | ✅ 返回「可以」 |
| `dsh_run` **带 workdir 的真实文件任务** | ✅ 让它统计工作区 `.mjs` 文件数 → 正确返回 `3` |
| 正常 PATH 环境 | ✅ 通过 |
| **精简 PATH（只留 node）** | ✅ 通过（自动回退绝对路径 pwsh） |
| 全流程耗时（握手+列表+自检+2 次调用） | **3.6 秒** |

**端到端实战**：用这条链路对一份三版简历做独立审计——耗时 **148 秒**，返回 622 行审计报告，其中挑出 3 处「高」风险问题（含一处对外可被证伪的失实表述）。

---

## 🔧 MCP 工具说明

| 工具 | 说明 |
| :-- | :-- |
| **`dsh_run`** | 把任务交给 dsh 自主执行。参数：`task`（必填）、`workdir`、`timeout_seconds`（默认 600，上限 3600）、`session_id`（多轮续跑）、`json_events` |
| **`dsh_status`** | 自检：dsh 是否连通、退出码、实测答复、错误摘要 |

**写 prompt 的建议**——把任务当成交给同事的工单，而不是搜索框：

- ❌「处理一下那个表」
- ✅「读 `D:\work\sale.csv`，按月份汇总 amount 列，输出 Markdown 表格 + 一份 `D:\work\out\月报.xlsx`，月份升序」

涉及文件时**务必给 `workdir`**；要求它**把产物写盘**而不是只回一段话；长任务给足 `timeout_seconds`。

---

## 🛠 设计要点

- **任务文本经临时文件传给子进程**，绝不拼命令行——中文、换行、引号、超长文本全安全
- **stdout 只输出协议消息**，日志一律走 stderr，否则会污染 MCP 协议流
- **超时后杀整棵进程树**（`taskkill /T /F`），不留野进程
- **PATH 精简也能活**：`pwsh` 与 `dsh` 都有绝对路径回退，实测在「PATH 只剩 node」时仍可用
- **零运行时依赖**：MCP server 只用 Node 内置模块，不需要 `npm install`
- **任务可续跑**：`--session-id` 支持多轮协作，dsh 记得上文

---

## ⚠️ 已知限制

| 限制 | 说明 |
| :-- | :-- |
| **MCP 调用超时** | `tools/call` 是一次性返回。若 Marvis 的超时上限短于任务耗时，长任务拿不到结果——这类任务改用方式 A（走 shell） |
| 无流式进度 | MCP 调用中途看不到 dsh 在做什么 |
| 输出上限 | 服务端截断在 60000 字符 |
| 并发 | dsh 会真的读写文件，不要让多个任务同时操作同一批文件 |
| 权限 | 装上之后，Marvis 能借 dsh 的手改本机任意文件——请自行评估 |
| 平台 | 目前仅 Windows（脚本用了 PowerShell 与 `taskkill`）；逻辑本身与平台无关，欢迎移植 |

---

## 📁 仓库结构

```
dsh-bridge/                     ← 仓库根 = 技能包根（Marvis 导入要求 SKILL.md 在第一层）
├── SKILL.md                    # 技能定义：触发条件 + 审计/文档两套 prompt 模板
├── meta.json                   # Marvis 技能元数据
├── scripts/
│   └── dsh_ask.ps1             # 带超时 / stdin / 会话续跑 / JSON 的封装
├── mcp-server/
│   ├── server.mjs              # 零依赖 MCP stdio 服务器
│   ├── dsh-runner.ps1          # 一次性 dsh 执行器
│   └── example-config.json     # 粘贴到 Marvis 的配置模板
├── docs/
│   ├── design.md               # 设计取舍（为什么走临时文件 / 杀进程树 / 路径回退…）
│   ├── mcp-reference.md        # 工具参数速查 + 手工调试 + 事件流格式
│   └── troubleshooting.md      # 排错：后端 / 桥接 / Marvis 导入 / 安全
├── assets/
│   ├── icon.png                # 项目图标（鲸鱼 + 桥）
│   └── icon.svg                # 矢量源
├── .github/workflows/ci.yml    # CI：布局检查 + 语法检查 + MCP 协议冒烟 + 敏感信息扫描
├── README.md                   # 本文件
├── README.en.md                # English
└── LICENSE                     # MIT（技能导入要求必须有）
```

---

## 📚 文档

| 文档 | 内容 |
|---|---|
| [设计取舍](docs/design.md) | 为什么走临时文件而不是命令行 / 为什么 stdout 只走协议 / 为什么杀进程树 / 为什么路径要有绝对回退 |
| [MCP 参考](docs/mcp-reference.md) | 两个工具的完整参数、手工调试的 JSON-RPC 示例、事件流格式与多轮续跑 |
| [排错](docs/troubleshooting.md) | 后端 / 桥接 / Marvis 导入 / 安全，四类问题的现象 → 原因 → 处置 |

CI 每次 push 会跑：文件布局检查 → Node 与 PowerShell 语法检查 → **MCP 协议冒烟测试** → 敏感信息扫描。

---

## 📢 诚信说明

- **真实可用**：仓库内所有脚本与配置均在本机实测通过，测试结果见上文表格。
- **未夸大**：MCP server 只暴露 2 个工具，没有把「调用 dsh」包装成任何它做不到的能力。
- **有边界**：`chat.deepseek.com` 网页端等灰色用法**不在本项目范围内**——本项目只调用本机 dsh 的官方 headless 模式，走你自己的账号。
- **不含本机信息**：仓库内无个人路径、用户名或凭据；配置模板使用 `YOUR_USERNAME` 占位符。

---

## 📄 License

MIT License — 详见 [LICENSE](./LICENSE)。

---

<p align="center">
  <i>如果你也在用 Marvis + DSH，欢迎交流。</i>
</p>
