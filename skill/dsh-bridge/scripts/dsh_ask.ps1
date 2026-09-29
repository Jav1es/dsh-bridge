# dsh_ask.ps1 — 把 DeepSeek Harness 当作一次性子代理调用
#
# 用法：
#   .\dsh_ask.ps1 "帮我把这个目录里的 xlsx 汇总成一张表"
#   "问题文本" | .\dsh_ask.ps1                      # 管道传入
#   Get-Content task.txt -Raw | .\dsh_ask.ps1       # 从文件传入
#   .\dsh_ask.ps1 "继续上次" -SessionId session-abc123
#   .\dsh_ask.ps1 "..." -Json                      # 输出 NDJSON 事件流
#
# 退出码：0=成功；2=参数错/任务为空；3=找不到 dsh；124=超时；其它=dsh 自身退出码
# 约定：最终回答走 stdout（可被管道/重定向捕获），诊断走 stderr。
#
# 实现说明：任务文本经「临时文件」传给子进程，不经命令行、不经 stdin 管道，
#          因此中文、换行、引号、超长文本都不会出问题。

[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromPipeline = $true)]
    [string]$Task,

    [int]$TimeoutSeconds = 900,

    [string]$SessionId,

    [string]$WorkDir,

    [switch]$Json,

    [string]$DshPath = 'dsh'
)

begin {
    $collected = [System.Collections.Generic.List[string]]::new()
}

process {
    if ($PSBoundParameters.ContainsKey('Task') -and -not [string]::IsNullOrWhiteSpace($Task)) {
        $collected.Add($Task)
    }
}

end {
    $text = ($collected -join "`n").Trim()

    # 未从参数/管道拿到内容时，尝试读真正的控制台 stdin（父进程非 PowerShell 的场景）
    if ([string]::IsNullOrWhiteSpace($text)) {
        try { $stdin = [Console]::In.ReadToEnd() } catch { $stdin = '' }
        if (-not [string]::IsNullOrWhiteSpace($stdin)) { $text = $stdin.Trim() }
    }

    if ([string]::IsNullOrWhiteSpace($text) -or $text -eq '-') {
        [Console]::Error.WriteLine('dsh_ask: 任务文本为空')
        exit 2
    }

    # ---- 解析 dsh ----
    $dsh = $DshPath
    if ($DshPath -eq 'dsh') {
        $cmd = Get-Command dsh -ErrorAction SilentlyContinue
        if (-not $cmd) {
            [Console]::Error.WriteLine('dsh_ask: PATH 里找不到 dsh 命令')
            exit 3
        }
        $dsh = $cmd.Source
    }

    # ---- 宿主 PowerShell（兼容 5.1 / 7+）----
    $hostExe = $null
    foreach ($n in @('pwsh', 'powershell')) {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        if ($c) { $hostExe = $c.Source; break }
    }
    if (-not $hostExe) { $hostExe = 'powershell.exe' }

    # ---- 临时工作区 ----
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh_ask_" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $taskFile = Join-Path $tmpDir 'task.txt'
    $runFile = Join-Path $tmpDir 'run.ps1'

    try {
        # 任务文本：UTF-8 无 BOM
        [System.IO.File]::WriteAllText($taskFile, $text, [System.Text.UTF8Encoding]::new($false))

        # 子脚本：全部用变量传参，零转义风险；UTF-8 带 BOM，保证中文路径可读
        $sq = { param($s) "'" + ($s -replace "'", "''") + "'" }
        $runLines = @()
        $runLines += '$ErrorActionPreference = ''Stop'''
        $runLines += ('$t = [System.IO.File]::ReadAllText(' + (& $sq $taskFile) + ', [System.Text.Encoding]::UTF8)')
        $dshArgs = @((& $sq $dsh), "'--profile'", "'headless'")
        if ($Json) { $dshArgs += "'--json'" }
        if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
            $dshArgs += "'--session-id'"
            $dshArgs += (& $sq $SessionId)
        }
        $runLines += ('& ' + ($dshArgs -join ' ') + ' $t')
        $runLines += 'exit $LASTEXITCODE'
        $runText = ($runLines -join "`n") + "`n"
        [System.IO.File]::WriteAllText($runFile, $runText, [System.Text.UTF8Encoding]::new($true))

        # ---- 启动 ----
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $hostExe
        $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $runFile + '"'
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

        $proc = [System.Diagnostics.Process]::Start($psi)
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()

        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            try { $proc.Kill($true) } catch { }
            [Console]::Error.WriteLine("dsh_ask: 超过 $TimeoutSeconds 秒未完成，已终止")
            exit 124
        }

        $stdout = $outTask.GetAwaiter().GetResult()
        $stderr = $errTask.GetAwaiter().GetResult()
        $code = $proc.ExitCode

        if ($stdout) { Write-Output $stdout.TrimEnd() }
        if ($stderr) { [Console]::Error.Write($stderr) }

        exit $code
    }
    finally {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
