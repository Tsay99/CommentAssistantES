$ErrorActionPreference='Stop'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'data\service-disabled'),'paused')
& (Join-Path $PSScriptRoot 'permanent-tunnel-stop.ps1')
& (Join-Path $PSScriptRoot 'stop.ps1')
Write-Output 'Service disabled. START.cmd enables it again.'
