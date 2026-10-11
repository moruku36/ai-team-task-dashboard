# Synthetic negative regressions. No real data/configuration is read or modified.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\BacklogCommon.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ai-ttd-safety-' + [guid]::NewGuid().ToString('N'))
$testRoot = [IO.Path]::GetFullPath($testRoot)
if (-not $testRoot.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid temp root' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$checks = 0
$links = New-Object 'Collections.Generic.List[string]'
$safe = "project_name: Synthetic`nfilesystem_only: true`nremote_operations: false`nauto_commit: false`ncheck_active_branches: false`n"
function Check([string]$Name, [bool]$Ok) {
    if (-not $Ok) { throw "FAIL $Name" }
    $script:checks++; Write-Host "PASS $Name"
}
function New-Fixture([string]$Name, [string]$Config = $safe) {
    $dir = Join-Path $testRoot $Name
    New-Item -ItemType Directory -Path (Join-Path $dir 'backlog\tasks') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $dir 'backlog\config.yml'), $Config)
    [IO.File]::WriteAllText((Join-Path $dir 'backlog\tasks\synthetic.md'), 'synthetic sentinel')
    return $dir
}
function Expect-Refused([string]$Name, [string]$Root) {
    $config = Join-Path $Root 'backlog\config.yml'
    $before = if (Test-Path -LiteralPath $config -PathType Leaf) { [IO.File]::ReadAllBytes($config) } else { $null }
    $rejected = $false
    try { $null = Resolve-SafeDataRoot $Root; Assert-DataConfig $Root } catch { $rejected = $_.Exception.Message.StartsWith('Refused:') }
    Check $Name $rejected
    if ($before) { Check "$Name preserves config" ([Convert]::ToBase64String($before) -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($config))) }
}
try {
    $ordinary = New-Fixture 'ordinary'
    $null = Resolve-SafeDataRoot $ordinary; Assert-DataConfig $ordinary
    Check 'canonical no-git config accepted' $true
    $rootConfig = New-Fixture 'root-config'
    [IO.File]::WriteAllText((Join-Path $rootConfig 'backlog.config.yml'), "filesystem_only: false`nremote_operations: true")
    Expect-Refused 'root config precedence refused' $rootConfig
    foreach ($entry in @('filesystem_only: false', 'remote_operations: true', 'auto_commit: true', 'check_active_branches: true', 'filesystemOnly: false', 'filesystemOnly: true', 'filesystem_only: true', '  filesystem_only: false')) {
        $dir = New-Fixture ('duplicate-' + $checks) ($safe + $entry + "`n")
        Expect-Refused "duplicate/alias/contradiction $entry" $dir
    }
    $nested = Join-Path $ordinary 'child'
    New-Item -ItemType Directory -Path $nested | Out-Null
    Expect-Refused 'nested Backlog root refused' $nested
    foreach ($relative in @('backlog', 'backlog\tasks', 'backlog\config.yml')) {
        $dir = Join-Path $testRoot ('junction-' + $checks)
        New-Item -ItemType Directory -Path $dir | Out-Null
        $link = Join-Path $dir $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $link) -Force | Out-Null
        $target = Join-Path $testRoot ('target-' + $checks)
        New-Item -ItemType Directory -Path $target | Out-Null
        [IO.File]::WriteAllText((Join-Path $target 'keep.txt'), 'synthetic outside-link sentinel')
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        $links.Add($link)
        Expect-Refused "internal reparse point $relative refused" $dir
        Check 'junction target preserved' ([IO.File]::ReadAllText((Join-Path $target 'keep.txt')) -eq 'synthetic outside-link sentinel')
        [IO.Directory]::Delete($link); $null = $links.Remove($link)
    }
    $savedCwd = [Environment]::GetEnvironmentVariable('BACKLOG_CWD', 'Process')
    $savedLock = [Environment]::GetEnvironmentVariable('USE_GLOBAL_TASK_ID_LOCK', 'Process')
    try {
        $env:BACKLOG_CWD = 'synthetic-original'; $env:USE_GLOBAL_TASK_ID_LOCK = 'false'
        $probe = Join-Path $testRoot 'probe.json'
        $command = '[IO.File]::WriteAllText(''' + $probe.Replace("'", "''") + ''', ($env:USE_GLOBAL_TASK_ID_LOCK + ''|'' + $env:BACKLOG_CWD))'
        $powershell = (Get-Command powershell.exe).Source
        $code = Invoke-Backlog $powershell $ordinary @('-NoProfile', '-NonInteractive', '-Command', $command)
        Check 'child receives enabled lock and fixed root' ($code -eq 0 -and [IO.File]::ReadAllText($probe) -eq ('true|' + $ordinary))
        Check 'success restores both process environment values' ($env:BACKLOG_CWD -eq 'synthetic-original' -and $env:USE_GLOBAL_TASK_ID_LOCK -eq 'false')
        try { $null = Invoke-Backlog 'synthetic-nonexistent.exe' $ordinary @() } catch {}
        Check 'exception restores both process environment values' ($env:BACKLOG_CWD -eq 'synthetic-original' -and $env:USE_GLOBAL_TASK_ID_LOCK -eq 'false')
    } finally {
        [Environment]::SetEnvironmentVariable('BACKLOG_CWD', $savedCwd, 'Process')
        [Environment]::SetEnvironmentVariable('USE_GLOBAL_TASK_ID_LOCK', $savedLock, 'Process')
    }
    Write-Host "OK: $checks safety checks (additional to integration suite)"
} finally {
    foreach ($link in $links) {
        if (-not [IO.Path]::GetFullPath($link).StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected cleanup path' }
        [IO.Directory]::Delete($link)
    }
    Assert-NoDataReparsePoints $testRoot
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
