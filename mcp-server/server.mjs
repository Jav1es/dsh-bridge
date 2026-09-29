#!/usr/bin/env node
/**
 * dsh-bridge MCP server — 把本机 DeepSeek Harness（dsh）作为工具暴露给 Marvis
 *
 * 传输：MCP stdio（换行分隔的 JSON-RPC 2.0）
 * 依赖：零依赖，只用 Node 内置模块
 *
 * 暴露的工具：
 *   dsh_run     执行一个任务（核心；可指定工作目录 / 超时 / 续跑会话）
 *   dsh_status  自检：dsh 是否可用、版本、账号通道是否就绪
 *
 * 设计要点：
 *   - 任务文本经临时文件传给子进程，绝不走命令行拼接 —— 中文 / 换行 / 引号全安全
 *   - stdout 只输出协议消息；一切日志走 stderr（否则会污染协议流）
 *   - 超时后杀整棵进程树，避免留下野进程
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, 'dsh-runner.ps1');

const SERVER_NAME = 'dsh-bridge';
const SERVER_VERSION = '1.0.0';
const DEFAULT_TIMEOUT = 600;   // 秒
const MAX_TIMEOUT = 3600;      // 秒
const MAX_OUTPUT = 60000;      // 字符，超出截断

function log(...a) {
    process.stderr.write('[dsh-bridge] ' + a.join(' ') + '\n');
}

/** 选一个可用的 PowerShell 宿主。
 *  MCP server 常被以精简环境启动，PATH 里未必有 pwsh —— 逐个探测已知位置。 */
let _pwsh = null;
function pwshExe() {
    if (_pwsh) return _pwsh;
    if (process.env.DSH_BRIDGE_PWSH) { _pwsh = process.env.DSH_BRIDGE_PWSH; return _pwsh; }
    const absolute = [
        join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
        join(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ];
    // 先绝对路径（精简环境下 PATH 不可靠），全都不存在再退回让 spawn 走 PATH 解析
    for (const c of absolute) {
        if (existsSync(c)) { _pwsh = c; break; }
    }
    if (!_pwsh) _pwsh = 'pwsh';
    return _pwsh;
}

/**
 * 跑一次 dsh。返回 { code, stdout, stderr, timedOut }。
 * @param {{task:string, workdir?:string, timeout?:number, sessionId?:string, json?:boolean}} o
 */
function runDsh(o) {
    return new Promise((resolve) => {
        const tmp = mkdtempSync(join(tmpdir(), 'dsh-bridge-'));
        const taskFile = join(tmp, 'task.txt');
        writeFileSync(taskFile, o.task, { encoding: 'utf8' });

        const args = [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', RUNNER, '-TaskFile', taskFile,
        ];
        if (o.sessionId) args.push('-SessionId', o.sessionId);
        if (o.json) args.push('-Json');

        const cwd = o.workdir && existsSync(o.workdir) ? o.workdir : process.cwd();

        const child = spawn(pwshExe(), args, {
            cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });

        const secs = Math.min(Math.max(Number(o.timeout) || DEFAULT_TIMEOUT, 10), MAX_TIMEOUT);
        const timer = setTimeout(() => {
            timedOut = true;
            log(`timeout after ${secs}s, killing pid ${child.pid}`);
            // Windows 下要杀整棵树，否则 pwsh 的子进程会留下
            try {
                spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            } catch { /* ignore */ }
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, secs * 1000);

        const finish = (code) => {
            clearTimeout(timer);
            try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
            resolve({ code, stdout, stderr, timedOut });
        };

        child.on('error', (e) => {
            stderr += `\n[spawn error] ${e.message}`;
            finish(-1);
        });
        child.on('close', (code) => finish(code));
    });
}

/** 自检：dsh 是否在 PATH、版本、账号通道是否可用 */
async function runStatus() {
    const probe = await runDsh({ task: '只回复两个字：可以', timeout: 120 });
    const info = {
        ok: probe.code === 0 && !probe.timedOut,
        exit_code: probe.code,
        timed_out: probe.timedOut,
        reply: probe.stdout.trim(),
        stderr_tail: probe.stderr.trim().slice(-500),
        runner_script: RUNNER,
        pwsh: pwshExe(),
    };
    if (!info.ok && /MISSING_CREDENTIAL/.test(probe.stderr)) {
        info.hint = 'headless profile 未配好凭据：需在 ~/.dsh/profiles/headless/cordis.patch.yml 里把 provider 指向 deepseek-account';
    }
    return info;
}

// ---------------------------- MCP 协议 ----------------------------

const TOOLS = [
    {
        name: 'dsh_run',
        description: [
            '把任务交给本机的 DeepSeek Harness（dsh）自主执行，返回它的最终答复。',
            'dsh 是带完整工具链的编码/办公代理：能读写文件、跑脚本、搜索、生成 docx/xlsx/pptx。',
            '',
            '【什么时候用】任务需要多步工具编排、批量处理文件、生成长文档或 Office 文档、',
            '或者需要一次独立复核（审计/挑错/核对数字与来源/交叉验证）。',
            '【什么时候不要用】一句话能答的问题、闲聊、简单改写 —— 那些直接回答更快。',
            '',
            '【写法建议】把任务当成交给同事的工单：背景、输入文件的绝对路径、期望产物与落点、验收标准。',
            '涉及文件时务必给 workdir。要求它把结果写盘，而不是只回一段话。',
            '【长任务】默认超时 600 秒，生成报告类任务建议 1200~1800 秒。',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                task: {
                    type: 'string',
                    description: '任务描述。写清背景、输入绝对路径、期望产物与验收标准。支持多行。',
                },
                workdir: {
                    type: 'string',
                    description: 'dsh 的工作目录（绝对路径）。涉及相对路径或要产出文件时必填。',
                },
                timeout_seconds: {
                    type: 'integer',
                    description: '超时秒数，默认 600，上限 3600。长文档/批量任务建议 1200~1800。',
                },
                session_id: {
                    type: 'string',
                    description: '可选：接着某个已有 dsh 会话继续（多轮协作）。从上次返回里拿 session id。',
                },
                json_events: {
                    type: 'boolean',
                    description: '可选：true 时返回 NDJSON 事件流而非纯文本（含 session id、token 用量）。',
                },
            },
            required: ['task'],
        },
    },
    {
        name: 'dsh_status',
        description: '自检 dsh 桥是否可用：返回 dsh 是否连通、退出码、实测答复与错误摘要。调用 dsh_run 前若不确定环境是否正常，可先跑这个。',
        inputSchema: { type: 'object', properties: {} },
    },
];

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(req) {
    const { id, method, params } = req;

    // 通知（无 id）不需要回复
    if (id === undefined || id === null) {
        if (method === 'notifications/initialized') log('client initialized');
        return;
    }

    switch (method) {
        case 'initialize': {
            const pv = params?.protocolVersion || '2024-11-05';
            ok(id, {
                protocolVersion: pv,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            });
            return;
        }
        case 'ping':
            ok(id, {});
            return;
        case 'tools/list':
            ok(id, { tools: TOOLS });
            return;
        case 'tools/call': {
            const name = params?.name;
            const a = params?.arguments || {};
            try {
                if (name === 'dsh_status') {
                    const s = await runStatus();
                    ok(id, { content: [{ type: 'text', text: JSON.stringify(s, null, 2) }], isError: false });
                    return;
                }
                if (name === 'dsh_run') {
                    if (typeof a.task !== 'string' || a.task.trim() === '') {
                        ok(id, { content: [{ type: 'text', text: '参数错误：task 不能为空' }], isError: true });
                        return;
                    }
                    log(`dsh_run start: ${a.task.slice(0, 80).replace(/\s+/g, ' ')}…`);
                    const r = await runDsh({
                        task: a.task,
                        workdir: a.workdir,
                        timeout: a.timeout_seconds,
                        sessionId: a.session_id,
                        json: a.json_events === true,
                    });
                    let out = r.stdout.trim();
                    if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + `\n…[输出超过 ${MAX_OUTPUT} 字符已截断]`;

                    const parts = [];
                    if (r.timedOut) parts.push(`⚠️ 超时被终止（超过设定秒数）。可将任务拆小，或调大 timeout_seconds。`);
                    if (!out && r.stderr.trim()) parts.push('（无 stdout）');
                    if (out) parts.push(out);
                    if (r.code !== 0 && r.stderr.trim()) parts.push(`\n--- stderr（诊断，非结果）---\n${r.stderr.trim().slice(-2000)}`);
                    if (r.code !== 0) parts.push(`\n退出码：${r.code}`);

                    log(`dsh_run done: exit=${r.code} timedOut=${r.timedOut} bytes=${out.length}`);
                    ok(id, {
                        content: [{ type: 'text', text: parts.join('\n') }],
                        isError: r.code !== 0 || r.timedOut,
                    });
                    return;
                }
                err(id, -32601, `unknown tool: ${name}`);
            } catch (e) {
                log('tool error: ' + (e?.stack || e));
                ok(id, { content: [{ type: 'text', text: `内部错误：${e?.message || e}` }], isError: true });
            }
            return;
        }
        default:
            err(id, -32601, `method not found: ${method}`);
    }
}

// ---------------------------- 启动 ----------------------------

log(`starting; runner=${RUNNER}; pwsh=${pwshExe()}`);
if (!existsSync(RUNNER)) log(`WARNING: runner script not found at ${RUNNER}`);

const rl = readline.createInterface({ input: process.stdin, terminal: false });

let pending = 0;      // 在飞的工具调用数
let closing = false;  // stdin 已关闭，等在飞的干完再退

function maybeExit() {
    if (closing && pending === 0) {
        log('all calls settled, exiting');
        process.exit(0);
    }
}

rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let req;
    try {
        req = JSON.parse(t);
    } catch {
        log('non-JSON line ignored');
        return;
    }
    pending++;
    Promise.resolve(handle(req))
        .catch((e) => log('handler crash: ' + (e?.stack || e)))
        .finally(() => { pending--; maybeExit(); });
});
rl.on('close', () => {
    closing = true;
    log('stdin closed' + (pending ? `, waiting for ${pending} in-flight call(s)` : ''));
    maybeExit();
});
