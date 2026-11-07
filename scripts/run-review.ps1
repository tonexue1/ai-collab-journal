param([string]$Date, [switch]$Offline)
$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ProjectDir
$ReviewArgs = @('src/cli.mjs', 'review')
if ($Date) { $ReviewArgs += @('--date', $Date) }
if ($Offline) { $ReviewArgs += '--offline' }
& node @ReviewArgs
exit $LASTEXITCODE
