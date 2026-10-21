<#
.SYNOPSIS
Initializes the separate shared no-git task data root with the official CLI, then sets the four statuses (To Do / In Progress / Blocked / Done).
-LegacySixStatuses is for compatibility tests of pre-change data roots only. Existing config is never rewritten.
Default root: %LOCALAPPDATA%\ai-team-task-dashboard\data. Existing config is preserved untouched.
#>
[CmdletBinding()]
param([string]$DataRoot, [string]$ExePath, [switch]$LegacySixStatuses)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'BacklogCommon.ps1')

$root = Resolve-SafeDataRoot $DataRoot
$exe = Assert-BacklogExe $ExePath
$configPath = Join-Path $root 'backlog\config.yml'

if (Test-Path -LiteralPath $configPath) {
    Assert-DataConfig $root
    Write-Host "Existing config preserved (not modified): $configPath"
    return
}

if ((Test-Path -LiteralPath $root) -and @(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) {
    throw 'Refused: uninitialized data root is nonempty. Choose a new empty folder; existing contents are preserved.'
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
# --integration-mode none must NOT be combined with --agent-instructions none (verified by probe).
$code = Invoke-Backlog $exe $root @('init', 'AI Team Tasks', '--defaults', '--no-git', '--integration-mode', 'none', '--auto-open-browser', 'false')
if ($code -ne 0) { throw "backlog init failed (exit $code)" }

# `config set statuses` is unsupported in v1.53.0: edit only the statuses line of the freshly generated config.
$generated = '(?m)^statuses: \["To Do", "In Progress", "Done"\]\r?$'
$text = [IO.File]::ReadAllText($configPath)
if ($text -notmatch $generated) { throw "Unexpected generated config; statuses left unchanged: $configPath" }
$statusSet = if ($LegacySixStatuses) { $script:LegacyStatuses } else { $script:DesiredStatuses }
$list = ($statusSet | ForEach-Object { '"' + $_ + '"' }) -join ', '
$text = [regex]::Replace($text, $generated, { param($m) 'statuses: [' + $list + ']' + $(if ($m.Value.EndsWith("`r")) { "`r" } else { '' }) })
[IO.File]::WriteAllText($configPath, $text, (New-Object Text.UTF8Encoding($false)))
Write-Host "Initialized: $root"
Write-Host "Statuses: $($statusSet -join ', ')"
