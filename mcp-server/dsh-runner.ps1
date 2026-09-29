# dsh-runner.ps1 — 被 MCP server 调用的一次性 dsh 执行器
# 任务文本经文件传入，规避命令行引号与中文编码问题。
# dsh 不在 PATH 时逐个探测已知位置（MCP server 常被以精简环境启动）。
param(
    [Parameter(Mandatory = $true)][string]$TaskFile,
    [string]$SessionId,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$text = [System.IO.File]::ReadAllText($TaskFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text) -or $text.Trim() -eq '-') {
    [Console]::Error.WriteLine('dsh-runner: 任务文本为空')
    exit 2
}

# ---- 定位 dsh ----
$dsh = $null
$c = Get-Command dsh -ErrorAction SilentlyContinue
if ($c) {
    $dsh = $c.Source
} else {
    $cands = @(
        (Join-Path $env:APPDATA 'npm\dsh.ps1'),
        (Join-Path $env:APPDATA 'npm\dsh.cmd')
    )
    foreach ($p in $cands) { if ($p -and (Test-Path $p)) { $dsh = $p; break } }
}
if (-not $dsh) {
    [Console]::Error.WriteLine('dsh-runner: 找不到 dsh（PATH 与已知位置都没有）')
    exit 3
}

$a = @('--profile', 'headless')
if ($Json) { $a += '--json' }
if (-not [string]::IsNullOrWhiteSpace($SessionId)) { $a += @('--session-id', $SessionId) }

& $dsh @a $text
exit $LASTEXITCODE
