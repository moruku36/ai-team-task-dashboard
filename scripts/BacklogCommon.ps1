# Shared helpers for the Backlog.md MVP scripts. Dot-source this file; do not run it.
# Pinned official release only. No custom UI/REST wrapper, no credential/firewall/auth changes.
Set-StrictMode -Version Latest

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:BacklogVersion = '1.53.0'
$script:BacklogSha256 = 'f5d4678ababa11e36866186e897a86e68e9f1f3c263d6c97034f674622abc689'
$script:BacklogUrl = 'https://github.com/MrLesk/Backlog.md/releases/download/v1.53.0/backlog-bun-windows-x64-baseline.exe'
$script:DefaultExe = Join-Path $script:RepoRoot '.runtime\backlog.exe'
$script:DesiredStatuses = @('To Do', 'In Progress', 'Awaiting Approval', 'Blocked', 'Verifying', 'Done')

function Get-DefaultDataRoot {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set; pass -DataRoot explicitly.' }
    Join-Path $env:LOCALAPPDATA 'ai-team-task-dashboard\data'
}

function Test-IsUnder([string]$Path, [string]$Parent) {
    $p = $Path.TrimEnd('\') + '\'
    $q = $Parent.TrimEnd('\') + '\'
    $p.StartsWith($q, [StringComparison]::OrdinalIgnoreCase)
}

# Resolves the data root and refuses locations that would mix task data with code or git workspaces.
function Resolve-SafeDataRoot([string]$DataRoot) {
    if (-not $DataRoot) { $DataRoot = Get-DefaultDataRoot }
    $full = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
    if (Test-IsUnder $full $script:RepoRoot) { throw "Refused: data root is inside the code repository: $full" }
    if (Test-IsUnder $script:RepoRoot $full) { throw "Refused: data root contains the code repository: $full" }
    for ($d = $full; $d; $d = Split-Path -Parent $d) {
        if ((Test-Path -LiteralPath $d) -and ((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refused: data root traverses a junction or symbolic link ($d). Use a direct local path."
        }
        if (Test-Path -LiteralPath (Join-Path $d '.git')) { throw "Refused: data root is inside an existing git workspace ($d). Use a separate no-git folder." }
    }
    $full
}

function Get-Sha256([string]$Path) {
    $s = [IO.File]::OpenRead($Path)
    try { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) } finally { $s.Dispose() }
}

function Assert-DataConfig([string]$DataRoot) {
    $config = Join-Path $DataRoot 'backlog\config.yml'
    if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Not initialized: run Initialize-DataRoot.ps1 first.' }
    $text = [IO.File]::ReadAllText($config)
    foreach ($entry in @('filesystem_only:true', 'remote_operations:false', 'auto_commit:false', 'check_active_branches:false')) {
        $key, $value = $entry.Split(':')
        if ($text -notmatch "(?m)^${key}:\s*${value}\s*$") { throw "Refused: existing config must explicitly set $entry (not modified)." }
    }
}

# Verifies the pinned binary by SHA256 before it is ever executed.
function Assert-BacklogExe([string]$ExePath) {
    if (-not $ExePath) { $ExePath = $script:DefaultExe }
    if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { throw "backlog.exe not found: $ExePath. Run scripts\Install-Backlog.ps1." }
    $hash = Get-Sha256 $ExePath
    if ($hash -ne $script:BacklogSha256) { throw "SHA256 mismatch for $ExePath (got $hash, expected $($script:BacklogSha256))." }
    (Resolve-Path -LiteralPath $ExePath).Path
}

# Runs the official CLI with BACKLOG_CWD pinned to the data root; the previous value is always restored.
function Invoke-Backlog([string]$Exe, [string]$DataRoot, [string[]]$Arguments) {
    $saved = [Environment]::GetEnvironmentVariable('BACKLOG_CWD', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('BACKLOG_CWD', $DataRoot, 'Process')
        & $Exe @Arguments | Out-Host
        return $LASTEXITCODE
    }
    finally {
        [Environment]::SetEnvironmentVariable('BACKLOG_CWD', $saved, 'Process')
    }
}
