<#
.SYNOPSIS
Downloads the pinned official Backlog.md v1.53.0 Windows x64 binary into .runtime\ after SHA256 validation.
#>
[CmdletBinding()]
param([string]$ExePath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'BacklogCommon.ps1')
if (-not $ExePath) { $ExePath = $script:DefaultExe }

if (Test-Path -LiteralPath $ExePath) {
    $null = Assert-BacklogExe $ExePath   # throws on mismatch; never overwrites an unknown file
    Write-Host "Already installed and verified: $ExePath"
    return
}

$dir = Split-Path -Parent ([IO.Path]::GetFullPath($ExePath))
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tmp = Join-Path $dir ('backlog.download.' + [guid]::NewGuid().ToString('N'))
try {
    Invoke-WebRequest -Uri $script:BacklogUrl -OutFile $tmp -UseBasicParsing
    $hash = Get-Sha256 $tmp
    if ($hash -ne $script:BacklogSha256) { throw "SHA256 mismatch (got $hash, expected $($script:BacklogSha256)). Download discarded." }
    Move-Item -LiteralPath $tmp -Destination $ExePath
}
finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
}
$ver = (& $ExePath --version | Select-Object -First 1)
if ($ver -ne $script:BacklogVersion) { throw "Unexpected version: $ver" }
Write-Host "Installed Backlog.md $ver (SHA256 verified): $ExePath"
