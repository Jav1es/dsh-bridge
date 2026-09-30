# dsh_snapshot.ps1 - collect local dsh work snapshot, output Markdown (for mobile viewing)
#
# Usage:
#   .\dsh_snapshot.ps1                 # default Top5 sessions + Top5 files (snapshot)
#   .\dsh_snapshot.ps1 -TopSessions 3  # only top 3 sessions
#   .\dsh_snapshot.ps1 -TopFiles 8     # top 8 output files
#   .\dsh_snapshot.ps1 -Progress       # realtime progress: list active sessions
#   .\dsh_snapshot.ps1 -ProgressId d274cf5b -Reply   # single session detail + last full reply
#
# Exit codes: 0=ok; 1=python or dependency missing; 2=snapshot script failed

[CmdletBinding()]
param(
    [int]$TopSessions = 5,
    [int]$TopFiles = 5,
    [switch]$Progress,
    [string]$ProgressId = '',
    [switch]$Reply
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pyScript = Join-Path $scriptDir 'dsh_snapshot.py'

$python = $null
foreach ($c in @('python', 'python3', 'py')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) {
        $python = $cmd.Source
        break
    }
}
if (-not $python) {
    [Console]::Error.WriteLine('dsh_snapshot: python interpreter not found')
    exit 1
}

try {
    & $python -c "import zstandard" 2>$null
    if ($LASTEXITCODE -ne 0) {
        & $python -m pip install zstandard --quiet 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine('dsh_snapshot: failed to install zstandard')
            exit 1
        }
    }
} catch {
    [Console]::Error.WriteLine("dsh_snapshot: dependency check failed: $_")
    exit 1
}

$pyArgs = @('--top-sessions', $TopSessions, '--top-files', $TopFiles)
if ($Progress -or $ProgressId) {
    $pyArgs += '--progress'
    if ($ProgressId) { $pyArgs += $ProgressId }
}
if ($Reply) { $pyArgs += '--reply' }

$output = & $python $pyScript @pyArgs 2>&1
$code = $LASTEXITCODE
if ($code -ne 0) {
    [Console]::Error.WriteLine("dsh_snapshot: snapshot script failed (exit $code)")
    [Console]::Error.WriteLine($output)
    exit 2
}

$resultLines = @()
$diagLines = @()
foreach ($line in $output) {
    if ($line -match '^\[dsh_snapshot\]') {
        $diagLines += $line
    } else {
        $resultLines += $line
    }
}
if ($diagLines.Count -gt 0) {
    [Console]::Error.WriteLine(($diagLines -join "`n"))
}
Write-Output ($resultLines -join "`n")
exit 0
