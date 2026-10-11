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
        if ($d -ne $full) {
            foreach ($relative in @('backlog.config.yml', 'backlog\config.yml', '.backlog\config.yml')) {
                if (Test-Path -LiteralPath (Join-Path $d $relative)) { throw 'Refused: data root is nested inside another Backlog root.' }
            }
        }
    }
    Assert-NoDataReparsePoints $full
    $full
}

# Enumerate one directory level at a time: never recurse into a junction before checking it.
function Assert-NoDataReparsePoints([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $queue.Enqueue($Root)
    while ($queue.Count -gt 0) {
        foreach ($item in @(Get-ChildItem -LiteralPath $queue.Dequeue() -Force)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refused: existing data contains a junction or symbolic link (not followed or modified).' }
            if ($item.Name -eq '.git') { throw 'Refused: existing data contains a git workspace.' }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
        }
    }
}

function Get-Sha256([string]$Path) {
    $s = [IO.File]::OpenRead($Path)
    try { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) } finally { $s.Dispose() }
}

function Assert-DataConfig([string]$DataRoot) {
    Assert-NoDataReparsePoints $DataRoot
    foreach ($relative in @('backlog.config.yml', '.backlog', 'backlog\config.yaml')) {
        if (Test-Path -LiteralPath (Join-Path $DataRoot $relative)) { throw 'Refused: alternate/root Backlog configuration is unsupported; existing data is unchanged.' }
    }
    $config = Join-Path $DataRoot 'backlog\config.yml'
    if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Not initialized: run Initialize-DataRoot.ps1 first.' }
    $text = [IO.File]::ReadAllText($config)
    foreach ($entry in @('filesystem_only:true', 'remote_operations:false', 'auto_commit:false', 'check_active_branches:false')) {
        $key, $value = $entry.Split(':')
        $normalized = $key.Replace('_', '').ToLowerInvariant()
        $declarations = @($text.Split("`n") | Where-Object {
            $line = $_.Trim()
            if ($line.StartsWith('#') -or -not $line.Contains(':')) { return $false }
            $candidate = $line.Substring(0, $line.IndexOf(':')).Trim()
            $candidate.Replace('_', '').ToLowerInvariant() -eq $normalized
        })
        if ($declarations.Count -ne 1 -or $declarations[0] -cnotmatch "^${key}:\s*${value}\s*$") {
            throw "Refused: require exactly one canonical $entry declaration; duplicates/aliases/contradictions are unsupported (not modified)."
        }
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
function ConvertTo-WindowsArgument([AllowEmptyString()][string]$Argument) {
    # Win32/C runtime quoting, including empty arguments and trailing backslashes.
    $escaped = [regex]::Replace($Argument, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-Backlog([string]$Exe, [string]$DataRoot, [string[]]$Arguments) {
    $saved = [Environment]::GetEnvironmentVariable('BACKLOG_CWD', 'Process')
    $savedLock = [Environment]::GetEnvironmentVariable('USE_GLOBAL_TASK_ID_LOCK', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('BACKLOG_CWD', $DataRoot, 'Process')
        [Environment]::SetEnvironmentVariable('USE_GLOBAL_TASK_ID_LOCK', 'true', 'Process')
        # PowerShell 5.1 native argument binding drops empty strings and embedded quotes.
        # Launch directly with explicit Win32 quoting and stream raw stdout/stderr to the host.
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $Exe
        $start.Arguments = ($Arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $isMcp = $null -ne $Arguments -and $Arguments.Count -gt 0 -and $Arguments[0] -eq 'mcp'
        $start.RedirectStandardInput = $isMcp
        $process = [Diagnostics.Process]::Start($start)
        try {
            $stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
            $stderr = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
            if ($isMcp) {
                if (-not ('BacklogStdioPump' -as [type])) {
                    Add-Type -TypeDefinition @'
using System.IO;
using System.Threading.Tasks;
public static class BacklogStdioPump {
    public static async Task Forward(Stream input, Stream output) {
        var buffer = new byte[8192];
        int n;
        while ((n = await input.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0) {
            await output.WriteAsync(buffer, 0, n).ConfigureAwait(false);
            await output.FlushAsync().ConfigureAwait(false);
        }
    }
}
'@
                }
                $stdin = [BacklogStdioPump]::Forward([Console]::OpenStandardInput(), $process.StandardInput.BaseStream)
            }
            while (-not $process.WaitForExit(100)) {
                if ($isMcp -and $stdin.IsCompleted) { $process.StandardInput.Close() }
            }
            $null = $stdout.GetAwaiter().GetResult(); $null = $stderr.GetAwaiter().GetResult()
            return $process.ExitCode
        } finally {
            if (-not $process.HasExited) { $process.Kill() }
            $process.Dispose()
        }
    }
    finally {
        [Environment]::SetEnvironmentVariable('BACKLOG_CWD', $saved, 'Process')
        [Environment]::SetEnvironmentVariable('USE_GLOBAL_TASK_ID_LOCK', $savedLock, 'Process')
    }
}
