<#
.SYNOPSIS
Runs the official Backlog.md CLI against the fixed data root (BACKLOG_CWD saved/restored).
Example: .\scripts\backlog.ps1 task list --plain
Optional leading overrides: -DataRoot <path> and/or -ExePath <path>. All other arguments go to the CLI unchanged.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'BacklogCommon.ps1')

$dataRoot = $null; $exePath = $null
$rest = @($args)
while ($rest.Count -ge 2 -and $rest[0] -in '-DataRoot', '-ExePath') {
    if ($rest[0] -eq '-DataRoot') { $dataRoot = $rest[1] } else { $exePath = $rest[1] }
    $rest = @($rest | Select-Object -Skip 2)
}
$root = Resolve-SafeDataRoot $dataRoot
$exe = Assert-BacklogExe $exePath
Assert-DataConfig $root
if (@($rest | Where-Object { $_ -eq '--cwd' -or $_ -like '--cwd=*' }).Count -gt 0) { throw 'Refused: --cwd would override the fixed shared data root.' }
exit (Invoke-Backlog $exe $root $rest)
