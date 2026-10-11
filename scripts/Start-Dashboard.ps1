<#
.SYNOPSIS
Starts the official Backlog.md browser server in the foreground (--no-open; the server binds 127.0.0.1 only).
Stop with Ctrl+C. Open the printed URL yourself.
#>
[CmdletBinding()]
param([string]$DataRoot, [string]$ExePath, [ValidateRange(1, 65535)][int]$Port = 6420)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'BacklogCommon.ps1')

$root = Resolve-SafeDataRoot $DataRoot
$exe = Assert-BacklogExe $ExePath
Assert-DataConfig $root

Write-Host "Data root: $root"
Write-Host "URL: http://127.0.0.1:$Port  (if the port is busy, the next free port is used and printed below)"
$code = Invoke-Backlog $exe $root @('browser', '--no-open', '--non-interactive', '--port', "$Port")
exit $code
