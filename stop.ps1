$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$pidFile = Join-Path $projectRoot 'data\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No saved server PID.'; exit }
$serverPid = [int]([IO.File]::ReadAllText($pidFile))
$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"
$serverPath = Join-Path $projectRoot 'server.mjs'
if ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine.Contains($serverPath)) {
 Stop-Process -Id $serverPid -ErrorAction Stop
 Write-Output 'Server stopped.'
} elseif ($proc) { throw 'PID belongs to another process. Nothing was stopped.' }
Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
