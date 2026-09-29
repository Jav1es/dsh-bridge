# MCP 参考：工具参数与手工调试

## 传输

- **stdio**，换行分隔的 JSON-RPC 2.0（一行一个对象，无 `Content-Length` 头）
- `stdout` 只走协议消息；日志在 `stderr`

支持的方法：

| 方法 | 说明 |
|---|---|
| `initialize` | 握手，返回 `protocolVersion` / `capabilities.tools` / `serverInfo` |
| `notifications/initialized` | 客户端通知，**无响应** |
| `tools/list` | 列出工具 |
| `tools/call` | 调用工具 |
| `ping` | 返回空对象 |

---

## `dsh_plan`

把用户的原始提问转成一份**可执行的派工单**。适合问题模糊、涉及多步、或不确定该用哪个技能/工具时。

它会自己读本机的 Marvis 资源（**不需要调用方传清单**）：

| 来源 | 读什么 |
|---|---|
| `~/.marvis/skills/market/*/SKILL.md`<br>`~/.marvis/skills/custom/*/SKILL.md` | 技能的 frontmatter（`name` + `description`） |
| `~/.marvis/database/data.db` | `mcp_server_index` / `mcp_tool_index` 两张普通表（服务器与工具及其描述） |

> `~/.marvis` 一般是 `AppData\Roaming\Tencent\Marvis\User\<id>` 的目录联接。可用 `DSH_BRIDGE_MARVIS_HOME` 覆盖。
> 目录清单缓存 5 分钟，不必每次重扫。

**两段式**：

1. **本地检索**（不耗模型，毫秒级）：对技能名/描述、工具 id/描述做中英混排分词（ASCII 词 + 中文 2~4 元组）打分。名字命中权重 ×3；技能阈值 ≥2、工具阈值 ≥1（工具名是 ASCII 短标识，中文信息都在描述里）。
2. **生成派工单**：只把 top-K 候选喂给 dsh，输出六个小节：意图澄清 / 任务拆解 / **建议调用（技能与工具的准确名字）** / 是否需要 dsh 深加工 / 输出要求 / 注意事项。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `question` | string | ✅ | — | 用户原始提问，原文照抄 |
| `top_k` | integer | — | `12` | 技能与工具各取前几名进入候选，上限 `25` |
| `timeout_seconds` | integer | — | `180` | 生成简报的超时，上限 `900` |
| `skip_llm` | boolean | — | `false` | `true` 时**只返回本地检索候选**，秒回、不耗模型 |

**实测**：`skip_llm` 约 0.1 秒；完整模式约 **10 秒**（前提是规划器不跑去读文件——提示词里对此有硬约束）。

### 为什么能自动匹配

关键点是 **dsh 与 Marvis 同机**：技能清单和 MCP 清单都能直接读文件与 SQLite，不必让模型"记住"或让调用方传参。
Marvis 自己也有一套向量索引做工具召回，两者互补——`dsh_plan` 的价值在于**先做意图澄清与任务拆解**，再给出带理由的调用建议。

### 已知边界

- 检索是**关键词级**的，不是语义级；技能描述写得越具体命中越准。候选不足时派工单里会写「候选不足，建议补充检索」。
- 提示词强制「只用清单里出现过的名字」——曾经出现过模型臆造清单外工具名（如 `order_price` 不在 top-K 里却被写出来）的情况，加约束后复测为 0。

---

## `dsh_run`

把任务交给本机 dsh 自主执行。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `task` | string | ✅ | — | 任务描述。写清背景、输入绝对路径、期望产物与验收标准。支持多行 |
| `workdir` | string | — | MCP server 的 cwd | dsh 的工作目录。**涉及文件时必填** |
| `timeout_seconds` | integer | — | `600` | 超时秒数，上限 `3600`。长文档/批量任务建议 `1200`~`1800` |
| `session_id` | string | — | — | 接着已有会话继续（多轮协作） |
| `json_events` | boolean | — | `false` | `true` 时返回 NDJSON 事件流而非纯文本 |

**返回**：`content[0].text` 为字符串；`isError` 在 dsh 非零退出或超时时为 `true`。

**输出上限**：60000 字符，超出截断并注明。

---

## `dsh_status`

无参数。返回 JSON：

```json
{
  "ok": true,
  "exit_code": 0,
  "timed_out": false,
  "reply": "可以",
  "stderr_tail": "…",
  "runner_script": "…/dsh-runner.ps1",
  "pwsh": "…/pwsh.exe",
  "hint": "仅在凭据缺失时出现"
}
```

`ok: false` 时先看 `hint` 与 `stderr_tail`。

---

## 手工调试

### 最简握手 + 列出工具

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
'@ | node .\mcp-server\server.mjs
```

期望：两行响应，第二行 `result.tools` 有 2 个元素。

### 调用一次

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dsh_status","arguments":{}}}
'@ | node .\mcp-server\server.mjs
```

### 直接测后端（绕过 MCP）

```powershell
dsh --profile headless "只回复两个字：可以"
# 期望 2~3 秒内输出「可以」，退出码 0
```

这一步不通，MCP 也不会通——先修它。

### 看日志

服务端日志走 stderr，被管道吞掉时单独接出来：

```powershell
'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node .\mcp-server\server.mjs 2>server.log
Get-Content server.log
```

---

## 事件流格式（`json_events: true`）

`dsh --profile headless --json` 的输出，逐行 JSON：

| `type` | 说明 |
|---|---|
| `session` | 会话建立，含 `sessionId`、`cwd`。**拿它做多轮续跑** |
| `status` | 阶段变化：`turn_start` / `step_start` / `step_end` / `turn_end`，含 token 用量 |
| `thinking` | 推理内容 |
| `text` | 正文增量 |
| `final` | **最终答案**，取 `text` 字段 |

示例（真实输出，已截断）：

```json
{"type":"session","sessionId":"session-777e6a57-…","cwd":"D:\\work"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"thinking","text":""}
{"type":"text","text":"收到"}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"收到"}
```

**多轮续跑**：第一次调用加 `json_events: true` → 从 `session` 事件取 `sessionId` → 后续调用传 `session_id`。
