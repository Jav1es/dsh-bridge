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
