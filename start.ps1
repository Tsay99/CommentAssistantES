$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$serverPath = Join-Path $projectRoot 'server.mjs'
$logDir = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'data') | Out-Null
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2
  if ($health.service -eq 'Comment Assistant ES') { Write-Output 'Server is already running: http://127.0.0.1:8787'; exit 0 }
} catch {}
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$proc = Start-Process -FilePath $nodeExe -ArgumentList ('"{0}"' -f $serverPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'error.log') -PassThru
[IO.File]::WriteAllText((Join-Path $projectRoot 'data\server.pid'), [string]$proc.Id)
Start-Sleep -Seconds 2
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 5
if ($health.service -ne 'Comment Assistant ES') { throw 'The server did not start.' }
Write-Output 'Server is running: http://127.0.0.1:8787'
