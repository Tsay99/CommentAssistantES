$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$binary=Join-Path $projectRoot 'bin\cloudflared.exe'
$pidFile=Join-Path $projectRoot 'data\tunnel.pid'
$urlFile=Join-Path $projectRoot 'data\webhook-url.txt'
if (-not (Test-Path -LiteralPath $binary)) { throw 'cloudflared.exe is missing from bin' }
if (Test-Path -LiteralPath $pidFile) {
 $tunnelPid=[int](Get-Content -LiteralPath $pidFile -Raw)
 $existing=Get-CimInstance Win32_Process -Filter "ProcessId=$tunnelPid" -ErrorAction SilentlyContinue
 if ($existing -and $existing.ExecutablePath -eq $binary) {
  Write-Output 'Tunnel is already running.'
  if (Test-Path -LiteralPath $urlFile) { Get-Content -LiteralPath $urlFile }
  exit 0
 }
}
$logFile=Join-Path $projectRoot 'logs\tunnel.log'
# Separate listener: do not point a public tunnel at the admin port 8787.
$proc=Start-Process -FilePath $binary -ArgumentList 'tunnel --url http://127.0.0.1:8788 --protocol http2 --no-autoupdate' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'logs\tunnel-out.log') -RedirectStandardError $logFile -PassThru
[IO.File]::WriteAllText($pidFile,[string]$proc.Id)
for ($i=0; $i -lt 25; $i++) {
 Start-Sleep -Seconds 1
 if (Test-Path -LiteralPath $logFile) {
  $log=Get-Content -LiteralPath $logFile -Raw
  $match=[regex]::Match($log,'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($match.Success) {
   $url=$match.Value+'/webhooks/instagram'
   [IO.File]::WriteAllText($urlFile,$url)
   Write-Output $url
   Write-Output 'Temporary URL. Copy it in the Webhooks page of the local panel.'
   exit 0
  }
 }
 if ($proc.HasExited) { throw 'Tunnel exited. See logs\tunnel.log' }
}
throw 'Tunnel address not ready. Check logs\tunnel.log'
