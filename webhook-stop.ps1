$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$binary=Join-Path $projectRoot 'bin\cloudflared.exe'
$pidFile=Join-Path $projectRoot 'data\tunnel.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No tunnel PID'; exit 0 }
$tunnelPid=[int](Get-Content -LiteralPath $pidFile -Raw)
$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$tunnelPid" -ErrorAction SilentlyContinue
if ($proc) {
 if ($proc.ExecutablePath -ne $binary) { throw 'PID belongs to another process. Nothing stopped.' }
 Stop-Process -Id $tunnelPid -ErrorAction Stop
}
Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
$urlFile=Join-Path $projectRoot 'data\webhook-url.txt'
if (Test-Path -LiteralPath $urlFile) { Remove-Item -LiteralPath $urlFile }
Write-Output 'Webhook tunnel stopped.'
