$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TaskName = 'AI-Collab-Journal-CI-' + [Guid]::NewGuid().ToString('N')
$ConfigPath = Join-Path $ProjectDir 'config.json'
$DataDir = Join-Path $env:RUNNER_TEMP $TaskName
if (Test-Path $ConfigPath) { throw 'Schedule integration requires a clean checkout without config.json.' }
try {
  $Today = (& node --input-type=module -e "import {today} from './src/time.mjs'; console.log(today())").Trim()
  @{ dataDir = $DataDir; startDate = $Today; projects = @() } | ConvertTo-Json | Set-Content -Encoding utf8 $ConfigPath
  & (Join-Path $ProjectDir 'scripts\install-schedule.ps1') -TaskName $TaskName -NoWake
  [xml]$Xml = Export-ScheduledTask -TaskName $TaskName
  # Windows may serialize the same instant in UTC instead of retaining +08:00.
  $Boundary = [string]$Xml.Task.Triggers.CalendarTrigger.StartBoundary
  Write-Host "Exported boundary: $Boundary"
  $Zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
  $BeijingBoundary = [TimeZoneInfo]::ConvertTime([DateTimeOffset]::Parse($Boundary), $Zone)
  $NextRun = [TimeZoneInfo]::ConvertTime((Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime, $Zone)
  if ($BeijingBoundary.TimeOfDay -ne [TimeSpan]::FromHours(2) -or $NextRun.TimeOfDay -ne [TimeSpan]::FromHours(2)) { throw 'Incorrect Beijing boundary' }
  if ($Xml.Task.Triggers.CalendarTrigger.ScheduleByDay.DaysInterval -ne '1') { throw 'Task must repeat daily' }
  if ($Xml.Task.Settings.StartWhenAvailable -ne 'true') { throw 'Missed-run recovery not enabled' }
  if ($Xml.Task.Actions.Exec.WorkingDirectory -ne $ProjectDir) { throw 'Working directory lost' }
  if ($Xml.Task.Principals.Principal.LogonType -ne 'InteractiveToken') { throw 'Unexpected account mode' }
  # Verify the real clock trigger on this disposable task, without waiting until 02:00.
  $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(15)
  Set-ScheduledTask -TaskName $TaskName -Trigger $Trigger | Out-Null
  $Deadline = (Get-Date).AddSeconds(70)
  $Log = Join-Path $DataDir 'schedule.log'
  do {
    Start-Sleep -Seconds 2
    $Done = (Test-Path $Log) -and ((Get-Content -Raw $Log) -match 'SUCCESS 0')
  } while (-not $Done -and (Get-Date) -lt $Deadline)
  if (-not $Done) {
    Get-ScheduledTaskInfo -TaskName $TaskName | Format-List
    throw 'Real scheduled trigger did not complete the due command'
  }
  Write-Host 'PASS real Windows scheduled trigger executed Node due and wrote SUCCESS 0'
} finally {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Remove-Item $ConfigPath -ErrorAction SilentlyContinue
  Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
}
