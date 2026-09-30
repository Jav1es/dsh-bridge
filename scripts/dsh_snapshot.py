#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh_snapshot.py — 采集本机 DeepSeek Harness (dsh) 工作情况快照，输出 Markdown。
供 Marvis 在手机端查看 dsh 状态时调用。

采集项：
  1. dsh 在线状态（命令存在性 + 最近会话新鲜度）
  2. 活跃 node 进程（dsh 相关）
  3. 最近会话列表（Top N，含工作区映射、创建时间、最后活动）
  4. 今日费用与用量（cost-meter ledger）
  5. 最近 24h 产出文件（工作区扫描）

用法：
  python dsh_snapshot.py [--top-sessions N] [--top-files N]
输出：stdout Markdown；诊断走 stderr。退出码 0=成功。
"""

import argparse
import datetime
import glob
import json
import os
import re
import shutil
import sys

try:
    import zstandard as zstd
except ImportError:
    zstd = None

DSH_HOME = os.path.expanduser(r"~\.dsh")
SESSIONS_ROOT = os.path.join(DSH_HOME, "sessions")
LEDGER_PATH = os.path.join(DSH_HOME, "storages", "cost-meter", "ledger.json")
WORKSPACE_PATH = os.path.join(DSH_HOME, "storages", "workspace.json")


def log_err(msg: str) -> None:
    print(f"[dsh_snapshot] {msg}", file=sys.stderr)


def load_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log_err(f"读取失败 {path}: {e}")
        return None


def decode_session_zstd(fp: str):
    """解压 session.v4.jsonl.zstd，返回首行 JSON（会话元数据）或 None。"""
    if zstd is None:
        return None
    try:
        with open(fp, "rb") as f:
            raw = f.read()
        text = zstd.ZstdDecompressor().decompress(raw, max_output_size=10_000_000)
        line = text.decode("utf-8", errors="replace").splitlines()
        return json.loads(line[0]) if line else None
    except Exception as e:
        log_err(f"解压失败 {fp}: {e}")
        return None


def collect_sessions(top_n: int = 5):
    """遍历会话目录，按最后活动时间倒序返回 top_n 条。"""
    sessions = []
    if not os.path.isdir(SESSIONS_ROOT):
        log_err(f"会话目录不存在: {SESSIONS_ROOT}")
        return sessions
    for ws_dir in os.listdir(SESSIONS_ROOT):
        ws_path = os.path.join(SESSIONS_ROOT, ws_dir)
        if not os.path.isdir(ws_path):
            continue
        for sess_dir in os.listdir(ws_path):
            sess_path = os.path.join(ws_path, sess_dir)
            if not os.path.isdir(sess_path):
                continue
            for fname in os.listdir(sess_path):
                if not (fname.endswith(".zstd") or fname.endswith(".jsonl")):
                    continue
                fp = os.path.join(sess_path, fname)
                mtime = os.path.getmtime(fp)
                meta = decode_session_zstd(fp) if fname.endswith(".zstd") else None
                sessions.append({
                    "session_id": sess_dir,
                    "cwd": (meta or {}).get("cwd", ""),
                    "created_at": (meta or {}).get("createdAt", None),
                    "agent_preset": (meta or {}).get("agentPreset", ""),
                    "mtime": mtime,
                    "file": fp,
                })
                break  # 一个会话目录取一个文件即可
    sessions.sort(key=lambda s: s["mtime"], reverse=True)
    return sessions[:top_n]


def map_workspace_title(cwd: str, ws_tables: dict) -> str:
    """把 cwd 映射回 workspace.json 里的可读标题。"""
    if not cwd or not ws_tables:
        return cwd or "未知"
    for wid, info in ws_tables.items():
        path = (info or {}).get("path", "")
        if path and os.path.normcase(os.path.normpath(path)) == os.path.normcase(os.path.normpath(cwd)):
            return f"{info.get('title', '')} ({path})"
    return cwd


def fmt_ts(ms):
    if not ms:
        return "-"
    try:
        return datetime.datetime.fromtimestamp(ms / 1000).strftime("%m-%d %H:%M")
    except Exception:
        return "-"


def fmt_mtime(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%m-%d %H:%M")


def collect_cost():
    """解析 ledger.json，返回今日与昨日费用摘要。"""
    data = load_json(LEDGER_PATH)
    if not data:
        return None
    days = data.get("days", {})
    today = datetime.date.today().isoformat()
    yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    out = {"today": days.get(today), "yesterday": days.get(yesterday), "balance": data.get("balanceRef")}
    return out


def collect_output_files(ws_tables: dict, top_n: int = 5):
    """扫描工作区路径最近 24h 修改的文件。"""
    cutoff = datetime.datetime.now().timestamp() - 24 * 3600
    found = []
    skip_dirs = {".git", ".svn", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".dsh"}
    seen_paths = set()
    if not ws_tables:
        return found
    for wid, info in ws_tables.items():
        ws_path = (info or {}).get("path", "")
        if not ws_path or not os.path.isdir(ws_path):
            continue
        for root, dirs, files in os.walk(ws_path):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            # 控制遍历深度，避免卡死
            depth = root[len(ws_path):].count(os.sep)
            if depth > 4:
                dirs[:] = []
                continue
            for fname in files:
                if fname.startswith("~$") or fname.endswith((".tmp", ".lock", ".log")):
                    continue
                fp = os.path.join(root, fname)
                try:
                    mtime = os.path.getmtime(fp)
                except Exception:
                    continue
                if mtime < cutoff:
                    continue
                norm = os.path.normcase(fp)
                if norm in seen_paths:
                    continue
                seen_paths.add(norm)
                size = os.path.getsize(fp)
                found.append((mtime, fp, size))
    found.sort(key=lambda x: x[0], reverse=True)
    return found[:top_n]


def render(sessions, cost, output_files, top_sessions, top_files):
    lines = []
    lines.append("## dsh 工作情况快照")
    lines.append("")

    # 1. 在线状态
    lines.append("### 在线状态")
    dsh_cmd = shutil.which("dsh")
    if dsh_cmd:
        lines.append(f"- dsh 命令：可用（{dsh_cmd}）")
    else:
        lines.append("- dsh 命令：**未找到**（PATH 中无 dsh）")
    if sessions:
        newest = sessions[0]
        age_min = (datetime.datetime.now().timestamp() - newest["mtime"]) / 60
        if age_min < 30:
            lines.append(f"- 最近活动：{fmt_mtime(newest['mtime'])}（约 {int(age_min)} 分钟前，活跃）")
        else:
            lines.append(f"- 最近活动：{fmt_mtime(newest['mtime'])}（约 {int(age_min)} 分钟前）")
    else:
        lines.append("- 最近活动：未发现任何会话记录")
    lines.append("")

    # 2. 活跃进程
    lines.append("### 活跃进程")
    try:
        import subprocess
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-Process node -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 5 Id,StartTime,CPU | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=15)
        nodes = json.loads(out.stdout) if out.stdout.strip() else []
        if isinstance(nodes, dict):
            nodes = [nodes]
        if nodes:
            for n in nodes:
                st = n.get("StartTime", "")
                st_fmt = "-"
                if st:
                    m = re.search(r"Date\((\d+)\)", st)
                    if m:
                        try:
                            st_fmt = datetime.datetime.fromtimestamp(int(m.group(1)) / 1000).strftime("%m-%d %H:%M")
                        except Exception:
                            st_fmt = st
                    else:
                        try:
                            st_fmt = datetime.datetime.fromisoformat(st).strftime("%m-%d %H:%M")
                        except Exception:
                            st_fmt = st
                lines.append(f"- node PID {n.get('Id')}（启动 {st_fmt}，CPU {n.get('CPU', 0)}s）")
        else:
            lines.append("- 无 node 进程（dsh 未在运行）")
    except Exception as e:
        lines.append(f"- 进程查询失败：{e}")
    lines.append("")

    # 3. 最近会话
    lines.append(f"### 最近会话（Top {top_sessions}）")
    ws_tables = {}
    ws_data = load_json(WORKSPACE_PATH)
    if ws_data:
        ws_tables = ws_data.get("tables", {}).get("workspaces", {})
    if sessions:
        for s in sessions:
            sid = s['session_id'].replace("session-", "")
            lines.append(f"- **{sid[:13]}** · {map_workspace_title(s['cwd'], ws_tables)}")
            lines.append(f"  - 创建 {fmt_ts(s['created_at'])} · 最后活动 {fmt_mtime(s['mtime'])}"
                         + (f" · preset={s['agent_preset']}" if s['agent_preset'] else ""))
    else:
        lines.append("- 无会话记录")
    lines.append("")

    # 4. 费用
    lines.append("### 费用与用量")
    if cost:
        today = cost.get("today")
        if today:
            lines.append(f"- 今日（{today.get('date')}）：¥{today.get('cost', 0):.4f} · {today.get('calls', 0)} 次调用 · 输入 {today.get('input', 0):,} tok · 输出 {today.get('output', 0):,} tok")
            models = today.get("byProviderModel", {})
            if models:
                parts = []
                for k, v in list(models.items())[:4]:
                    parts.append(f"{k.split(':')[-1]} ¥{v.get('cost', 0):.4f}")
                lines.append(f"  - 模型分布：{'；'.join(parts)}")
        else:
            lines.append("- 今日暂无费用记录")
        yd = cost.get("yesterday")
        if yd:
            lines.append(f"- 昨日（{yd.get('date')}）：¥{yd.get('cost', 0):.4f} · {yd.get('calls', 0)} 次调用")
        bal = cost.get("balance")
        if bal:
            lines.append(f"- 余额参考：¥{bal.get('total', 0):.2f}（{bal.get('currency', 'CNY')}，{bal.get('date', '')}）")
    else:
        lines.append("- 费用台账读取失败")
    lines.append("")

    # 5. 最新产出
    lines.append(f"### 最近 24h 产出（Top {top_files}）")
    if output_files:
        for mtime, fp, size in output_files:
            size_str = f"{size / 1024:.0f}KB" if size < 1024 * 1024 else f"{size / 1024 / 1024:.1f}MB"
            lines.append(f"- {fmt_mtime(mtime)} · {os.path.basename(fp)}（{size_str}）")
            lines.append(f"  - {fp}")
    else:
        lines.append("- 最近 24h 未发现新产出文件（或工作区路径不可读）")
    lines.append("")
    return "\n".join(lines)


PROJCACHE_ROOT = os.path.join(DSH_HOME, "storages", "session_projcache", "sessions")


def load_projcache():
    """读取 session_projcache 下所有会话缓存，按 mtime 倒序。"""
    out = []
    if not os.path.isdir(PROJCACHE_ROOT):
        log_err(f"缓存目录不存在: {PROJCACHE_ROOT}")
        return out
    for fname in os.listdir(PROJCACHE_ROOT):
        if not fname.endswith(".json"):
            continue
        fp = os.path.join(PROJCACHE_ROOT, fname)
        try:
            mtime = os.path.getmtime(fp)
            with open(fp, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception as e:
            log_err(f"读取缓存失败 {fp}: {e}")
            continue
        rows = (data.get("record") or {}).get("rows") or {}
        tl = ((rows.get("contextTimeline") or {}).get("val") or {})
        surface = tl.get("surface") or []
        out.append({"path": fp, "fname": fname, "mtime": mtime, "rows": rows, "surface": surface})
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def timeline_summary(surface, last_n=6):
    """把 timeline 事件转成简短摘要行。"""
    items = []
    for ev in surface[-last_n:]:
        cat = ev.get("cat")
        t = ev.get("time") or 0
        ts = datetime.datetime.fromtimestamp(t / 1000).strftime("%H:%M:%S") if t else "-"
        if cat == "assistant":
            calls = ev.get("calls") or []
            if calls:
                items.append(f"[{ts}] 正在调用工具: {', '.join(calls[:3])}")
            else:
                text = (ev.get("text") or "").strip().replace("\n", " ")
                items.append(f"[{ts}] 回复: {text[:120]}")
        elif cat == "tool":
            items.append(f"[{ts}] 工具 {ev.get('tool')} 完成 (tokens={ev.get('tokens')})")
        elif cat == "user":
            items.append(f"[{ts}] 用户: {(ev.get('text') or '').strip()[:80]}")
        else:
            items.append(f"[{ts}] {cat}: {(ev.get('text') or '').strip()[:60]}")
    return items


def last_reply(surface):
    """取最近一条完整 assistant 文本回复。"""
    for ev in reversed(surface):
        if ev.get("cat") == "assistant" and ev.get("text"):
            return ev["text"].strip()
    return None


def _unwrap_val(v):
    """解包 {ver, seq, val} 结构，取 val 字符串。"""
    if isinstance(v, dict) and "val" in v:
        return v["val"]
    return v


def token_totals(rows):
    tu = ((rows.get("tokenUsage") or {}).get("val") or {})
    totals = tu.get("totals") or {}
    return totals


def collect_progress(session_id=None, active_minutes=30):
    caches = load_projcache()
    now = datetime.datetime.now().timestamp()
    for c in caches:
        c["active"] = (now - c["mtime"]) < active_minutes * 60
        c["age_min"] = max(0, int((now - c["mtime"]) / 60))
    if session_id:
        want = session_id if str(session_id).startswith("session-") else f"session-{session_id}"
        for c in caches:
            if c["fname"].startswith(want):
                return {"mode": "detail", "cache": c}
        return {"mode": "detail", "cache": None}
    return {"mode": "list", "caches": caches}


def render_progress(session_id=None, show_reply=False):
    data = collect_progress(session_id)
    lines = []
    if data["mode"] == "list":
        lines.append("## dsh 实时任务进度")
        lines.append("")
        caches = data["caches"]
        active = [c for c in caches if c["active"]]
        lines.append(f"### 活跃会话（{len(active)} 个，最近 30 分钟有活动）")
        if not active:
            lines.append("- 当前没有活跃会话（dsh 空闲）")
        for c in active:
            rows, surface = c["rows"], c["surface"]
            title = _unwrap_val(rows.get("title")) or "(未命名)"
            totals = token_totals(rows)
            inp = totals.get("uncachedInputTokens", 0) + totals.get("cacheReadTokens", 0)
            outp = totals.get("outputTokens", 0)
            last = timeline_summary(surface, 1)
            tail = last[0] if last else "无事件"
            lines.append(f"- **{title}** · {c['fname'].replace('session-', '').split('-')[0][:13]} · 最后活动 {c['age_min']} 分钟前")
            lines.append(f"  - {tail}")
            lines.append(f"  - 累计 tokens：输入 {inp:,} / 输出 {outp:,}")
        lines.append("")
        lines.append(f"### 全部会话（共 {len(caches)} 个缓存）")
        if caches:
            for c in caches[:5]:
                rows = c["rows"]
                title = _unwrap_val(rows.get("title")) or "(未命名)"
                status = "活跃" if c["active"] else "空闲"
                lines.append(f"- **{title}** · {status} · 最后活动 {c['age_min']} 分钟前")
        lines.append("")
        lines.append("追问详情可用：dsh_snapshot.py --progress <会话id>")
    else:
        c = data["cache"]
        if not c:
            lines.append("## dsh 任务进度详情")
            lines.append("")
            lines.append(f"- 未找到会话缓存：{session_id}（可能已过期清理）")
            return "\n".join(lines)
        rows, surface = c["rows"], c["surface"]
        title = _unwrap_val(rows.get("title")) or "(未命名)"
        totals = token_totals(rows)
        inp = totals.get("uncachedInputTokens", 0) + totals.get("cacheReadTokens", 0)
        outp = totals.get("outputTokens", 0)
        lines.append("## dsh 任务进度详情")
        lines.append("")
        lines.append(f"- **会话**：{title}")
        lines.append(f"- **ID**：{c['fname'].replace('.json', '')}")
        lines.append(f"- **状态**：{'活跃（正在运行）' if c['active'] else '空闲（已完成或暂停）'} · 最后活动 {c['age_min']} 分钟前")
        goal = _unwrap_val(rows.get("goal"))
        if isinstance(goal, dict):
            goal = goal.get("current")
        if goal:
            lines.append(f"- **目标**：{goal[:200]}")
        lines.append("")
        lines.append("### 最近进展")
        for item in timeline_summary(surface, 8):
            lines.append(f"- {item}")
        lines.append("")
        lines.append(f"### 累计用量")
        lines.append(f"- 输入 tokens：{inp:,}（uncached {totals.get('uncachedInputTokens', 0):,} + cacheRead {totals.get('cacheReadTokens', 0):,}）")
        lines.append(f"- 输出 tokens：{outp:,}")
        if show_reply:
            reply = last_reply(surface)
            lines.append("")
            lines.append("### 最近完整回复")
            lines.append("")
            lines.append(reply if reply else "- 暂无文本回复")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top-sessions", type=int, default=5)
    ap.add_argument("--top-files", type=int, default=5)
    ap.add_argument("--progress", nargs="?", const="__LIST__", default=None,
                    help="实时进度：不带值列出活跃会话；带会话ID输出详情")
    ap.add_argument("--reply", action="store_true", help="详情模式下附最近完整回复")
    args = ap.parse_args()

    if args.progress:
        sid = None if args.progress == "__LIST__" else args.progress
        print(render_progress(sid, show_reply=args.reply))
        return 0

    ws_data = load_json(WORKSPACE_PATH)
    ws_tables = ws_data.get("tables", {}).get("workspaces", {}) if ws_data else {}

    sessions = collect_sessions(args.top_sessions)
    cost = collect_cost()
    output_files = collect_output_files(ws_tables, args.top_files)

    print(render(sessions, cost, output_files, args.top_sessions, args.top_files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
