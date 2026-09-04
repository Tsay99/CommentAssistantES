$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
[IO.File]::WriteAllText((Join-Path $projectRoot 'data\permanent-disabled'),'paused')
$binary=Join-Path $projectRoot 'bin\cloudflared.exe'
$runnerPath=Join-Path $projectRoot 'tunnel-runner.mjs'
$pidFile=Join-Path $projectRoot 'data\permanent-runner.pid'
if (Test-Path -LiteralPath $pidFile) {
 $runnerPid=[int](Get-Content -LiteralPath $pidFile -Raw)
 $existing=Get-CimInstance Win32_Process -Filter "ProcessId=$runnerPid" -ErrorAction SilentlyContinue
 if ($existing) {
  if ($existing.Name -ne 'node.exe' -or -not $existing.CommandLine.Contains($runnerPath)) { throw 'Saved PID belongs to another process' }
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$runnerPid" | Where-Object { $_.ExecutablePath -eq $binary } | ForEach-Object { Stop-Process -Id $_.ProcessId }
  Stop-Process -Id $runnerPid
 }
 Remove-Item -LiteralPath $pidFile
}
Write-Output 'Permanent tunnel stopped.'
