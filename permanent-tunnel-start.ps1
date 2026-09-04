$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$runnerPath=Join-Path $projectRoot 'tunnel-runner.mjs'
$pidFile=Join-Path $projectRoot 'data\permanent-runner.pid'
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'data\cloudflare.dpapi'))) { Write-Output 'Permanent tunnel awaits configuration.'; exit 0 }
if (Test-Path -LiteralPath (Join-Path $projectRoot 'data\permanent-disabled')) { exit 0 }
if (Test-Path -LiteralPath $pidFile) {
 $runnerPid=[int](Get-Content -LiteralPath $pidFile -Raw)
 $existing=Get-CimInstance Win32_Process -Filter "ProcessId=$runnerPid" -ErrorAction SilentlyContinue
 if ($existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine.Contains($runnerPath)) { exit 0 }
 if ($existing) { throw 'Saved tunnel PID belongs to another process' }
}
$nodeExe=(Get-Command node.exe -ErrorAction Stop).Source
$proc=Start-Process -FilePath $nodeExe -ArgumentList ('"{0}"' -f $runnerPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'logs\permanent-runner.log') -RedirectStandardError (Join-Path $projectRoot 'logs\permanent-runner-error.log') -PassThru
[IO.File]::WriteAllText($pidFile,[string]$proc.Id)
Write-Output 'Permanent tunnel supervisor started.'
