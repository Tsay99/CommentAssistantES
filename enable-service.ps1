$ErrorActionPreference='Stop'
foreach ($name in @('service-disabled','permanent-disabled')) {
 $flag=Join-Path $PSScriptRoot ('data\'+$name)
 if (Test-Path -LiteralPath $flag) { Remove-Item -LiteralPath $flag }
}
& (Join-Path $PSScriptRoot 'watchdog.ps1')
Write-Output 'Local service enabled: http://127.0.0.1:8787'
