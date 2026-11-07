param([switch]$Demo)
$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ProjectDir
if ($Demo) { & node 'src/cli.mjs' serve --demo } else { & node 'src/cli.mjs' serve }
exit $LASTEXITCODE
