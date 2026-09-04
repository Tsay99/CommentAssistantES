$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$launcher=Join-Path $projectRoot 'bin\CommentAssistantES.Background.exe'
if (-not (Test-Path -LiteralPath $launcher)) { & (Join-Path $projectRoot 'build-background-launcher.ps1') }
$accountName=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskName='CommentAssistantES'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
 $belongs=$existing.Actions | Where-Object { ($_.Arguments -and $_.Arguments.Contains($projectRoot)) -or $_.Execute -eq $launcher }
 if (-not $belongs) { throw 'An unrelated task already uses this name. Nothing changed.' }
 Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $projectRoot 'data\autostart-backup.xml')
}
$action=New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $projectRoot
$triggers=@(
 (New-ScheduledTaskTrigger -AtLogOn -User $accountName),
 (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$principal=New-ScheduledTaskPrincipal -UserId $accountName -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Comment Assistant ES: start after Windows sign-in and restore local server and permanent Cloudflare tunnel after failures.' -Force | Select-Object TaskName,State
Start-ScheduledTask -TaskName $taskName
