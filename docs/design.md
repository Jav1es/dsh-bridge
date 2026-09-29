# 设计取舍

记录几个「为什么这么做」——都是踩过坑之后的结果。

---

## 1. 为什么任务文本走临时文件，而不是命令行参数

最直接的写法是 `dsh --profile headless "<task>"`。但任务文本是**任意用户内容**：中文、换行、单双引号、反引号、`$`、超长段落。

- **走命令行** → 要逐层转义（Node → PowerShell → dsh），每一层都可能出错；Windows 命令行还有长度上限
- **走 stdin** → 省了转义，但 PowerShell 管道给原生进程的编码默认不是 UTF-8，中文会变乱码
- **走临时文件** → 全都不成问题

实际采用的方案：

```
Node 写 task.txt (UTF-8 无 BOM)
   ↓
生成一个临时 .ps1 (UTF-8 带 BOM，保证中文路径可读)
   ↓  内容：读 task.txt → 变量 → & dsh ... $变量
pwsh -File 该脚本
```

关键在于临时 `.ps1` **用变量传参**（`& $dsh @args $t`），而不是把文本拼进命令字符串——所以没有任何转义层。

> 踩坑记录：第一版用 `[Console]::In.ReadToEnd()` 读 stdin，中文被编码成乱码送进了 dsh；第二版用 `WriteAsync` + `Close` 又报 `The stream is currently in use by a previous operation`。最后换成文件传递才彻底干净。

---

## 2. 为什么 stdout 只走协议消息

MCP stdio 传输是**一行一个 JSON-RPC 对象**。任何额外写到 stdout 的东西都会让客户端解析失败。

所以服务端约定：

- `stdout` → **只有** JSON-RPC 响应
- `stderr` → 所有日志（`[dsh-bridge] starting; runner=...`）
- `dsh` 自己的诊断输出（如 stderr 上的 reasoning）→ 原样转给 stderr，不混进结果

> 踩坑记录：把 dsh 的 stderr 内容拼进 `content[0].text` 会让模型把诊断当结论；现在只在**非零退出**时才附上 stderr，并明确标注「诊断，非结果」。

---

## 3. 为什么超时要杀进程树

`child.kill()` 只结束直接子进程。链路是：

```
node (MCP server) → pwsh → dsh
```

杀掉 pwsh **不会**杀掉 dsh——它会继续跑，继续改文件，变成野进程。

所以超时走：

```js
spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'])   // /T = 整棵树
```

---

## 4. 为什么 pwsh / dsh 都要绝对路径回退

MCP server 是被宿主程序 spawn 的，**环境不一定继承你的交互式 PATH**。实测把 PATH 清到只剩 node 时：

- 裸 `pwsh` 解析失败 → `spawn error`，整个工具调用报错
- 裸 `dsh` 同理

所以两处都做了回退：

| 依赖 | 回退顺序 |
|---|---|
| `pwsh` | `$env:DSH_BRIDGE_PWSH` → `%ProgramFiles%\PowerShell\7\pwsh.exe` → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` → 裸 `pwsh` |
| `dsh` | `Get-Command dsh` → `%APPDATA%\npm\dsh.ps1` → `%APPDATA%\npm\dsh.cmd` |

> 踩坑记录：最初把裸 `pwsh` 放在候选列表**第一位**并且直接采用，等于回退逻辑根本没生效。改成「先绝对路径、后 PATH 解析」才对。

---

## 5. 为什么 Skill 和 MCP 两条通道都保留

它们解决的不是同一个问题：

| | Skill（走 shell） | MCP（走协议） |
|---|---|---|
| **谁决定调用** | Marvis 读 `SKILL.md` 后自己拼命令 | Marvis 把 `dsh_run` 当原生工具，按 schema 决策 |
| **超时约束** | 无（shell 调用不受 MCP 客户端限制） | 受宿主 `tools/call` 超时限制 |
| **长任务** | ✅ 适合 | ⚠️ 可能被掐断 |
| **常态调用** | 链路长、易漂 | ✅ 适合 |

所以：**日常走 MCP，长任务走 Skill**。两者共用同一个后端（`dsh --profile headless`），改一处即可。

---

## 6. 为什么零依赖

MCP 官方 SDK 需要 `npm install`。但：

- MCP stdio 协议本身很简单（换行分隔的 JSON-RPC，4 个方法）
- 引入依赖树会让「用户手动审查这段代码」变得几乎不可能
- 一个 `server.mjs` 单文件、只用 Node 内置模块，谁都能十分钟读完

代价是要自己实现 `initialize` / `tools/list` / `tools/call` / `ping` 四个方法——约 60 行，值得。
