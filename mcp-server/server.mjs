#!/usr/bin/env node
/**
 * dsh-bridge MCP server — 把本机 DeepSeek Harness（dsh）作为工具暴露给 Marvis
 *
 * 传输：MCP stdio（换行分隔的 JSON-RPC 2.0）
 * 依赖：零依赖，只用 Node 内置模块
 *
 * 暴露的工具：
 *   dsh_plan    规划：读本机 Marvis 的技能/MCP 清单，把模糊问题转成可执行派工单
 *   dsh_run     执行一个任务（核心；可指定工作目录 / 超时 / 续跑会话）
 *   dsh_status  自检：dsh 是否可用、版本、账号通道是否就绪
 *
 * 设计要点：
 *   - 任务文本经临时文件传给子进程，绝不走命令行拼接 —— 中文 / 换行 / 引号全安全
 *   - stdout 只输出协议消息；一切日志走 stderr（否则会污染协议流）
 *   - 超时后杀整棵进程树，避免留下野进程
 *   - dsh_plan 的检索在本地做（关键词打分），只把 top-K 候选喂给模型，控上下文
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
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

// ------------------ Marvis 资源目录（本地读取，供 dsh_plan 用） ------------------
//
// dsh 与 Marvis 跑在同一台机器上，所以这些清单可以自己读，不必让 Marvis 传：
//   技能    ~/.marvis/skills/{market,custom}/*/SKILL.md  的 frontmatter（name + description）
//   MCP     ~/.marvis/database/data.db 的 mcp_server_index / mcp_tool_index 两张普通表
//
// 注：~/.marvis 通常是 AppData\Roaming\Tencent\Marvis\User\<id> 的目录联接。

const MARVIS_HOME = process.env.DSH_BRIDGE_MARVIS_HOME
    || join(process.env.USERPROFILE || process.env.HOME || '', '.marvis');
const SKILL_ROOTS = [join(MARVIS_HOME, 'skills', 'market'), join(MARVIS_HOME, 'skills', 'custom')];
const MARVIS_DB = join(MARVIS_HOME, 'database', 'data.db');
const CATALOG_TTL_MS = 5 * 60 * 1000;

let _catalog = null;
let _catalogAt = 0;

/** 取 SKILL.md 的 YAML frontmatter（只认 `---` 包裹的第一段） */
function parseFrontmatter(text) {
    const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
        if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
    return out;
}

function loadSkills() {
    const out = [];
    for (const root of SKILL_ROOTS) {
        let dirs = [];
        try {
            dirs = readdirSync(root, { withFileTypes: true })
                .filter((d) => d.isDirectory()).map((d) => d.name);
        } catch { continue; }   // 目录不存在就跳过
        const source = basename(root);
        for (const d of dirs) {
            try {
                const txt = readFileSync(join(root, d, 'SKILL.md'), 'utf8').slice(0, 4000);
                const fm = parseFrontmatter(txt);
                out.push({
                    kind: 'skill', id: d, source,
                    name: fm.name || d,
                    desc: (fm.description || '').replace(/\s+/g, ' '),
                });
            } catch { /* 没有 SKILL.md 就跳过 */ }
        }
    }
    return out;
}

async function loadMcp() {
    const servers = [], tools = [];
    let mod;
    try { mod = await import('node:sqlite'); } catch { return { servers, tools }; }
    let db;
    try {
        db = new mod.DatabaseSync(MARVIS_DB, { readOnly: true });
        for (const r of db.prepare('SELECT server_name, description, enabled FROM mcp_server_index').all()) {
            servers.push({
                id: r.server_name, enabled: r.enabled,
                desc: String(r.description || '').replace(/\s+/g, ' '),
            });
        }
        for (const r of db.prepare('SELECT server, tool_name, description, enabled FROM mcp_tool_index').all()) {
            tools.push({
                id: `${r.server}/${r.tool_name}`, server: r.server, tool: r.tool_name, enabled: r.enabled,
                desc: String(r.description || '').replace(/\s+/g, ' '),
            });
        }
    } catch (e) {
        log('读取 Marvis MCP 索引失败（将只提供技能清单）: ' + (e?.message || e));
    } finally {
        try { db?.close(); } catch { /* ignore */ }
    }
    return { servers, tools };
}

async function loadCatalog(force = false) {
    const now = Date.now();
    if (!force && _catalog && now - _catalogAt < CATALOG_TTL_MS) return _catalog;
    const skills = loadSkills();
    const { servers, tools } = await loadMcp();
    _catalog = { skills, servers, tools, at: now };
    _catalogAt = now;
    log(`catalog loaded: ${skills.length} skills, ${servers.length} mcp servers, ${tools.length} mcp tools`);
    return _catalog;
}

/** 中英混排的粗粒度分词：ASCII 词 + 中文 2~4 元组 */
function tokenize(s) {
    const t = new Set();
    const lower = String(s || '').toLowerCase();
    for (const w of lower.match(/[a-z0-9][a-z0-9_\-+.]{1,}/g) || []) t.add(w);
    const cjk = lower.replace(/[^\u4e00-\u9fff]+/g, ' ');
    for (const seg of cjk.split(/\s+/)) {
        for (let n = 2; n <= 4; n++) {
            for (let i = 0; i + n <= seg.length; i++) t.add(seg.slice(i, i + n));
        }
    }
    return t;
}

function score(qt, text) {
    const tt = tokenize(text);
    let s = 0;
    for (const t of qt) if (tt.has(t)) s += t.length >= 3 ? 2 : 1;
    return s;
}

function shortlist(question, catalog, topSkills, topTools) {
    const qt = tokenize(question);
    // 名字命中权重 ×3（名字是最强信号）
    // 阈值区分：技能名多为中文，噪声容易蹭上二元组 → 要求 ≥2；
    //           工具名是 ASCII 短标识，中文信息全在描述里 → 放到 ≥1
    const rank = (items, nameOf, descOf, top, min) => items
        .map((it) => ({ it, s: score(qt, nameOf(it)) * 3 + score(qt, descOf(it)) }))
        .filter((x) => x.s >= min)
        .sort((a, b) => b.s - a.s)
        .slice(0, top)
        .map((x) => x.it);
    return {
        skills: rank(catalog.skills, (x) => `${x.name} ${x.id}`, (x) => x.desc, topSkills, 2),
        tools: rank(catalog.tools.filter((t) => t.enabled !== 0), (x) => x.id, (x) => x.desc, topTools, 1),
    };
}

function buildPlanPrompt(question, pick, catalog) {
    const skillLines = pick.skills.length
        ? pick.skills.map((s, i) => `${i + 1}. ${s.name}｜${s.id}｜${s.desc.slice(0, 220)}`).join('\n')
        : '（无相关技能命中）';
    const toolLines = pick.tools.length
        ? pick.tools.map((t, i) => `${i + 1}. ${t.id}｜${t.desc.slice(0, 220)}`).join('\n')
        : '（无相关 MCP 工具命中）';
    const serverLines = catalog.servers.length
        ? catalog.servers.map((s) => `- ${s.id}：${s.desc.slice(0, 120)}`).join('\n')
        : '（无）';

    return `你是 Marvis 的任务规划器。Marvis 是本机的一个桌面 AI 助手，它自己带着一套技能库和 MCP 工具。
用户的原始提问往往很模糊。请把它转成一份「可执行的派工单」，让 Marvis 照着做就能给出好答案。

【本机已连接的全部 MCP 服务器】
${serverLines}

【与本问题相关的技能候选（已按相关度排序）】
${skillLines}

【与本问题相关的 MCP 工具候选（已按相关度排序）】
${toolLines}

【用户原始提问】
${question}

【最重要的一条】
你**只做规划**：不要执行任务、不要读任何文件、不要调用任何工具、不要联网。
直接依据上面的候选清单与提问本身，输出派工单即可。执行是下一步的事。

【输出要求】严格按下面六个 Markdown 小节输出，不要写开场白和总结，不要复述本提示词：

## 意图澄清
1-3 句：用户真正想要什么。如有歧义，指出最可能的两种解释。

## 任务拆解
编号列出要执行的步骤，每步一行，动词开头。

## 建议调用
只从上面的候选里挑，**必须逐字使用清单里出现的名字**。
清单外的名字一律不要写 —— 写了等于报错，调用方会照着去调然后失败。
若你认为需要的能力不在候选里，就在本节写明「候选不足，建议补充检索：<关键词>」，不要臆造名字。
命中的写理由，没命中就写「无需」。
- 技能：\`名字\` — 理由
- MCP 工具：\`服务器/工具\` — 理由

## 是否需要交给 dsh 深加工
判断是否值得调用 \`dsh_run\`（适用于：需要独立复核审计、长文档生成、批量文件处理）。需要就写清交给它做什么；不需要就写「不需要」。

## 输出要求
Marvis 最终回答给用户什么：内容要点、格式（表格/清单/正文）、大致篇幅。

## 需要注意
约束、易错点、必须向用户确认的事项（没有就写「无」）。`;
}

// ---------------------------- MCP 协议 ----------------------------

const TOOLS = [
    {
        name: 'dsh_plan',
        description: [
            '把用户的原始提问转成一份「可执行的派工单」，供 Marvis 照着调用技能与 MCP 工具。',
            '',
            '它会自己读取本机 Marvis 已安装的**技能清单**（~/.marvis/skills/*）与**已连接的 MCP 服务器/工具清单**',
            '（~/.marvis/database/data.db），做关键词检索挑出候选，再用 dsh 生成结构化简报，包含：',
            '意图澄清 / 任务拆解 / **建议调用的技能与 MCP 工具（准确名字）** / 是否需要交给 dsh 深加工 / 输出要求 / 注意事项。',
            '',
            '【什么时候用】用户的问题比较模糊、涉及多步、或不确定该用哪个技能/工具时，先调它再干活。',
            '【什么时候不要用】问题已经很明确、或只是闲聊问答 —— 直接回答更快，调它会白等十几秒。',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: '用户的原始提问，原文照抄即可（可以带上一点上下文）。',
                },
                top_k: {
                    type: 'integer',
                    description: '技能与工具各取前几名进入候选，默认 12，上限 25。越大越全但越慢。',
                },
                timeout_seconds: {
                    type: 'integer',
                    description: '生成简报的超时秒数，默认 180，上限 900。',
                },
                skip_llm: {
                    type: 'boolean',
                    description: 'true 时只返回本地检索出的候选清单（秒回、不耗模型），适合先看命中情况。',
                },
            },
            required: ['question'],
        },
    },
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
                if (name === 'dsh_plan') {
                    const question = String(a.question || '').trim();
                    if (!question) {
                        ok(id, { content: [{ type: 'text', text: '参数错误：question 不能为空' }], isError: true });
                        return;
                    }
                    const topK = Math.min(Math.max(Number(a.top_k) || 12, 1), 25);
                    const catalog = await loadCatalog();
                    const pick = shortlist(question, catalog, topK, topK);
                    log(`dsh_plan: ${catalog.skills.length} skills / ${catalog.tools.length} tools -> picked ${pick.skills.length}/${pick.tools.length}`);

                    if (a.skip_llm === true) {
                        const body = [
                            `# 本地检索候选（未调用模型）`,
                            ``,
                            `## 技能候选（${pick.skills.length} / 共 ${catalog.skills.length}）`,
                            ...(pick.skills.map((s) => `- \`${s.name}\`（${s.id}）— ${s.desc.slice(0, 160)}`)),
                            ``,
                            `## MCP 工具候选（${pick.tools.length} / 共 ${catalog.tools.length}）`,
                            ...(pick.tools.map((t) => `- \`${t.id}\` — ${t.desc.slice(0, 160)}`)),
                        ].join('\n');
                        ok(id, { content: [{ type: 'text', text: body }], isError: false });
                        return;
                    }

                    const prompt = buildPlanPrompt(question, pick, catalog);
                    const r = await runDsh({ task: prompt, timeout: a.timeout_seconds || 180 });
                    const text = r.stdout.trim();
                    const head = [
                        `<!-- dsh_plan：候选 ${pick.skills.length} 技能 / ${pick.tools.length} 工具` +
                        `（库内共 ${catalog.skills.length} / ${catalog.tools.length}）；` +
                        `用时与退出码见文末 -->`,
                        '',
                    ].join('\n');
                    const tail = r.timedOut
                        ? '\n\n---\n⚠️ 生成简报超时被终止，可调大 timeout_seconds 或减少 top_k。'
                        : `\n\n---\n（生成完毕，退出码 ${r.code}）`;
                    const outText = text
                        ? head + text + tail
                        : `生成失败。\n\n--- stderr ---\n${r.stderr.trim().slice(-1500)}`;
                    log(`dsh_plan done: exit=${r.code} timedOut=${r.timedOut} bytes=${text.length}`);
                    ok(id, {
                        content: [{ type: 'text', text: outText }],
                        isError: r.code !== 0 || r.timedOut,
                    });
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
