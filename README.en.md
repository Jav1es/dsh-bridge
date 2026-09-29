<p align="center">
  <img src="assets/icon.png" width="160" alt="dsh-bridge">
</p>

<h1 align="center">dsh-bridge</h1>

<p align="center">
  <b>Let Tencent Marvis call your local DeepSeek Harness</b>
</p>

<p align="center">
  <a href="https://github.com/Jav1es/dsh-bridge/actions/workflows/ci.yml"><img src="https://github.com/Jav1es/dsh-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="License"></a>
  <img src="https://img.shields.io/badge/Platform-Windows-0078d4" alt="Platform">
  <img src="https://img.shields.io/badge/Node-%E2%89%A518-339933" alt="Node">
  <img src="https://img.shields.io/badge/MCP-3_tools-7c3aed" alt="MCP tools">
  <img src="https://img.shields.io/badge/Tests-6%2F6_passed-059669" alt="Tests">
  <img src="https://img.shields.io/badge/PowerShell-7-5391FE" alt="PowerShell">
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a>
</p>

> One Skill + one MCP server that turn your local DeepSeek Harness into Marvis's "reviewer and heavy lifter".
>
> 📎 Featured as [module 14](https://jav1es.github.io/portfolio/#works) of the author's portfolio: https://jav1es.github.io/portfolio/

Marvis is free and fast — good for everyday work. DeepSeek Harness (dsh) ships a full toolchain — file I/O, shell, search, docx/xlsx/pptx generation — good for heavy work. This project connects the two: **when Marvis hits an AI-audit/review task or a complex document job, it hands the task to dsh and takes back the result.**

I use Marvis for almost everything, but there are two kinds of work I don't want to trust it with alone: **outputs that go out to other people, where a mistake is costly and a second pair of eyes helps**, and **long or batch document processing that needs multi-step orchestration and files on disk**. dsh runs locally on my own account and costs nothing extra — so I built this bridge so Marvis can hand work over when it needs to.

---

## 📖 Table of Contents

- [✨ Two Ways to Connect](#-two-ways-to-connect)
- [🚀 Quick Start](#-quick-start)
- [🧪 Test Results](#-test-results)
- [🔧 MCP Tools](#-mcp-tools)
- [🛠 Design Notes](#-design-notes)
- [⚠️ Known Limitations](#️-known-limitations)
- [📁 Repository Layout](#-repository-layout)
- [📚 Documentation](#-documentation)
- [📢 Honesty Statement](#-honesty-statement)
- [📄 License](#-license)

---

## ✨ Two Ways to Connect

| Way | Form | Best for | Dependency |
|---|---|---|---|
| **A. Skill** | A Marvis skill (`SKILL.md` + PowerShell wrapper) | **Very long tasks** — runs through a shell, so no MCP call timeout | None |
| **B. MCP Server** | A zero-dependency Node MCP stdio server | **Everyday use** — Marvis treats dsh as a native tool and **decides on its own** whether to call it | Node ≥ 18 |

Both share the same backend: `dsh --profile headless "<task>"` on your machine. Use either one, or both.

**A or B?** I kept both. Day to day, let Marvis decide → use B. For runs that take minutes, use A so the MCP client timeout can't cut it off.

---

## 🚀 Quick Start

### Prerequisites

- **Windows** with **DeepSeek Harness** installed and `dsh` on your PATH
- **PowerShell 7 (`pwsh`)** — the scripts fall back to absolute paths, so it works even when PATH is minimal
- **Node.js ≥ 18** (route B only)

### Step 1: Configure the headless profile (required)

`dsh --profile headless` defaults to `deepseek-official`, which needs an API key. If you are signed in through the DSH desktop app, point it at the account route instead — edit `~/.dsh/profiles/headless/cordis.patch.yml`:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
```

Verify:

```powershell
dsh --profile headless "只回复两个字：可以"
# Expect "可以" within 2-3 seconds, exit code 0
```

> If you see `MISSING_CREDENTIAL`, this step is not done yet.

### Route A: Install the Skill

**Recommended: import by link inside Marvis**

Open **技能广场 → 工具箱/连接 → 链接添加** and paste the repository root:

```
https://github.com/Jav1es/dsh-bridge
```

> ⚠️ It must be the **repository root**. Marvis treats the whole repository as one skill package and requires `SKILL.md` at the **first level** — this repo is laid out that way (see [troubleshooting](docs/troubleshooting.md)).

**Alternative: install manually**

```powershell
git clone https://github.com/Jav1es/dsh-bridge "$env:USERPROFILE\.marvis\skills\custom\dsh-bridge"
```

Then say something in Marvis that should trigger it, e.g. "audit the numbers in this report". Marvis reads `SKILL.md` and decides whether to call out.

Test it directly, without Marvis:

```powershell
$s = "$env:USERPROFILE\.marvis\skills\custom\dsh-bridge\scripts\dsh_ask.ps1"
"只回复两个字：可以" | & $s     # piping avoids all quoting issues
```

### Route B: Connect the MCP Server

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.marvis\mcp\dsh-bridge" | Out-Null
Copy-Item .\mcp-server\* "$env:USERPROFILE\.marvis\mcp\dsh-bridge\" -Force
```

In Marvis, open **技能广场 → 工具箱 → 连接 → 我的连接 → 自定义连接 → 自定义配置 MCP** and paste (replace the username):

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

Save and flip the toggle on. When the card shows **`2 tools`**, you are connected.

---

## 🧪 Test Results

All figures below are real runs on my machine, not estimates.

**Skill route (`dsh_ask.ps1`, 6/6 passed)**

| # | Case | Result |
| :-- | :-- | :-- |
| T1 | Positional argument (Chinese text) | ✅ returns `可以`, exit 0 |
| T2 | `"text" \| .\dsh_ask.ps1` via pipe | ✅ returns `完成`, exit 0 |
| T3 | `-Json` event stream | ✅ 8 NDJSON lines, types `session/status/thinking/text/final` |
| T4 | Empty task | ✅ exit 2 (bad argument) |
| T5 | `-WorkDir` sets the working directory | ✅ returns `工作`, exit 0 |
| T6 | Multi-line with mixed quotes | ✅ delivered intact, returns `多行`, exit 0 |

**MCP route (over the real JSON-RPC protocol)**

| Case | Result |
| :-- | :-- |
| `initialize` handshake | ✅ `serverInfo: dsh-bridge v1.0.0` |
| `tools/list` | ✅ returns 2 tools |
| `dsh_status` | ✅ `ok=true, exit_code=0, reply="可以"` |
| `dsh_run` on a trivial task | ✅ returns the answer |
| `dsh_run` **with `workdir`, real file work** | ✅ asked it to count `.mjs` files in a tree → returned `3` |
| Normal PATH environment | ✅ passed |
| **Minimal PATH (node only)** | ✅ passed (falls back to an absolute `pwsh` path) |
| Whole flow (handshake + list + status + 2 calls) | **3.6 s** |

**End-to-end in practice**: ran an independent audit of a three-version résumé set through this bridge — **148 seconds**, 622-line report, surfacing 3 high-severity issues (including one externally falsifiable misstatement).

---

## 🔧 MCP Tools

| Tool | Description |
| :-- | :-- |
| **`dsh_plan`** | Planning: reads Marvis's **local skill and MCP-tool catalogs**, runs a local keyword retrieval over them, then asks dsh to produce a work order (intent / task breakdown / **exact skill and tool names to call** / whether to hand off to dsh / output spec / caveats). Arguments: `question` (required), `top_k`, `timeout_seconds`, `skip_llm` (return the shortlist only — instant, no model call) |
| **`dsh_run`** | Hand a task to dsh. Arguments: `task` (required), `workdir`, `timeout_seconds` (default 600, max 3600), `session_id` (continue a session), `json_events` |
| **`dsh_status`** | Self-check: connectivity, exit code, actual reply, error summary |

**How to write the prompt** — treat it like a work order to a colleague, not a search box:

- ❌ "deal with that spreadsheet"
- ✅ "Read `D:\work\sale.csv`, sum the `amount` column by month, output a Markdown table plus `D:\work\out\monthly.xlsx`, months ascending"

Always pass `workdir` when files are involved, **ask for artifacts on disk** rather than a chat reply, and give generous `timeout_seconds` for long jobs.

---

## 🛠 Design Notes

- **Task text reaches the child process through a temp file** — never string-concatenated into a command line, so Chinese text, newlines, quotes and very long prompts are all safe
- **stdout carries protocol messages only**; every log line goes to stderr, otherwise it would corrupt the MCP stream
- **Timeout kills the whole process tree** (`taskkill /T /F`), leaving no orphans
- **Survives a minimal PATH**: both `pwsh` and `dsh` have absolute-path fallbacks — verified with a PATH containing only node
- **Zero runtime dependencies**: the MCP server uses Node built-ins only; no `npm install`
- **Resumable**: `--session-id` supports multi-turn work; dsh remembers the context

---

## ⚠️ Known Limitations

| Limitation | Detail |
| :-- | :-- |
| **MCP call timeout** | `tools/call` returns in one shot. If Marvis's timeout is shorter than the job, long tasks come back empty — use route A (shell) for those |
| No streaming progress | You cannot see what dsh is doing mid-call |
| Output cap | Server truncates at 60,000 characters |
| Concurrency | dsh really reads and writes files — do not run two jobs over the same files at once |
| Permission scope | Once installed, Marvis can modify any file on your machine through dsh. Judge that for yourself |
| Platform | Windows only for now (the scripts use PowerShell and `taskkill`); the logic itself is portable and ports are welcome |

---

## 📁 Repository Layout

```
dsh-bridge/                     # repo root = skill package root (Marvis requires SKILL.md at the first level)
├── SKILL.md                    # Skill definition: triggers + audit/document prompt templates
├── meta.json                   # Marvis skill metadata
├── scripts/
│   └── dsh_ask.ps1             # Wrapper with timeout / stdin / session resume / JSON
├── mcp-server/
│   ├── server.mjs              # Zero-dependency MCP stdio server
│   ├── dsh-runner.ps1          # One-shot dsh runner
│   └── example-config.json     # Config template to paste into Marvis
├── docs/
│   ├── design.md               # Design trade-offs (temp file, process tree, PATH fallbacks…)
│   ├── mcp-reference.md        # Tool arguments, manual debugging, event stream format
│   └── troubleshooting.md      # Backend / bridge / Marvis import / security
├── assets/
│   ├── icon.png                # Project icon (whale + bridge)
│   └── icon.svg                # Vector source
├── .github/workflows/ci.yml    # CI: layout + syntax + MCP smoke test + secret scan
├── README.md                   # 简体中文
├── README.en.md                # This file
└── LICENSE                     # MIT (required for skill import)
```

---

## 📚 Documentation

| Document | Contents |
|---|---|
| [Design trade-offs](docs/design.md) | Why a temp file instead of the command line / why stdout carries protocol only / why we kill the process tree / why absolute-path fallbacks |
| [MCP reference](docs/mcp-reference.md) | Full tool arguments, manual JSON-RPC debugging, event stream format, multi-turn resume |
| [Troubleshooting](docs/troubleshooting.md) | Backend / bridge / Marvis import / security — symptom → cause → fix |

CI runs on every push: layout check → Node and PowerShell syntax checks → **MCP protocol smoke test** → secret scan.

---

## 📢 Honesty Statement

- **It works**: every script and config here was tested on my machine; results are in the tables above.
- **No inflation**: the MCP server exposes exactly 2 tools. Nothing is packaged as a capability it does not have.
- **Clear boundaries**: grey-area uses such as scripting `chat.deepseek.com` are **out of scope**. This project only calls dsh's official headless mode, on your own account.
- **No local data**: no personal paths, usernames or credentials are in this repo; the config template uses a `YOUR_USERNAME` placeholder.

---

## 📄 License

MIT License — see [LICENSE](./LICENSE).

---

<p align="center">
  <i>If you also run Marvis + DSH, I'd love to hear how you use it.</i>
</p>
