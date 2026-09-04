$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
if (Test-Path -LiteralPath (Join-Path $projectRoot 'data\service-disabled')) { exit 0 }
$taskMutex=[Threading.Mutex]::new($false,'Local\CommentAssistantESWatchdog')
$acquired=$false
try {
 $acquired=$taskMutex.WaitOne(0)
 if (-not $acquired) { exit 0 }
 $healthy=$false
 try { $health=Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 4; $healthy=$health.service -eq 'Comment Assistant ES' } catch {}
 if (-not $healthy) {
  $serverPath=Join-Path $projectRoot 'server.mjs'
  $pidFile=Join-Path $projectRoot 'data\server.pid'
  $owned=$null
  if (Test-Path -LiteralPath $pidFile) {
   $serverPid=[int](Get-Content -LiteralPath $pidFile -Raw)
   $candidate=Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -ErrorAction SilentlyContinue
   if ($candidate -and $candidate.Name -eq 'node.exe' -and $candidate.CommandLine.Contains($serverPath)) { $owned=$candidate }
  }
  $failedFile=Join-Path $projectRoot 'data\unhealthy-since.txt'
  if ($owned) {
   if (-not (Test-Path -LiteralPath $failedFile)) { [IO.File]::WriteAllText($failedFile,[DateTime]::UtcNow.ToString('o')) }
   elseif (([DateTime]::UtcNow-[DateTime]::Parse((Get-Content -LiteralPath $failedFile -Raw))).TotalMinutes -ge 2) { Stop-Process -Id $owned.ProcessId; $owned=$null }
  }
  if (-not $owned) { & (Join-Path $projectRoot 'start.ps1') }
 } else {
  $failedFile=Join-Path $projectRoot 'data\unhealthy-since.txt'
  if (Test-Path -LiteralPath $failedFile) { Remove-Item -LiteralPath $failedFile }
 }
 & (Join-Path $projectRoot 'permanent-tunnel-start.ps1')
 [IO.File]::WriteAllText((Join-Path $projectRoot 'data\watchdog-last-run.txt'),[DateTime]::UtcNow.ToString('o'))
} finally {
 if ($acquired) { $taskMutex.ReleaseMutex() }
 $taskMutex.Dispose()
}
