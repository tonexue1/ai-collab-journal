param([string]$TaskName = 'AI-Collab-Journal', [switch]$NoWake)
$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$NodePath = (Get-Command node -ErrorAction Stop).Source
$Major = [int]((& $NodePath --version).Trim().TrimStart('v').Split('.')[0])
if ($Major -lt 24) { throw 'Node.js 24 or later is required.' }
$CliPath = Join-Path $ProjectDir 'src\cli.mjs'
$BeijingZone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
$BeijingNow = [TimeZoneInfo]::ConvertTime([DateTimeOffset]::Now, $BeijingZone)
$TargetDate = $BeijingNow.Date
if ($BeijingNow.Hour -ge 2) { $TargetDate = $TargetDate.AddDays(1) }
$Boundary = $TargetDate.ToString('yyyy-MM-dd') + 'T02:00:00+08:00'
$UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$EscapeXml = { param($Value) [Security.SecurityElement]::Escape($Value) }
$NodeXml = & $EscapeXml $NodePath
$ArgsXml = & $EscapeXml ('"' + $CliPath + '" due')
$DirXml = & $EscapeXml $ProjectDir
$Wake = if ($NoWake) { 'false' } else { 'true' }
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing -and $Existing.Actions[0].WorkingDirectory -ne $ProjectDir) {
  throw "A task named $TaskName belongs to another directory. Choose a different -TaskName."
}
$TaskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Local AI collaboration journal. Daily at 02:00 Asia/Shanghai. No source conversation is uploaded to Git.</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>$Boundary</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="CurrentUser"><UserId>$UserSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><WakeToRun>$Wake</WakeToRun><Enabled>true</Enabled><ExecutionTimeLimit>PT4H</ExecutionTimeLimit></Settings>
  <Actions Context="CurrentUser"><Exec><Command>$NodeXml</Command><Arguments>$ArgsXml</Arguments><WorkingDirectory>$DirXml</WorkingDirectory></Exec></Actions>
</Task>
"@
Register-ScheduledTask -TaskName $TaskName -Xml $TaskXml -Force | Out-Null
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
$Next = [TimeZoneInfo]::ConvertTime($Info.NextRunTime, $BeijingZone)
Write-Host "Installed: $TaskName"
Write-Host "Next run (Beijing): $($Next.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host "Account: current user; requires an active sign-in (locking the screen is OK)."
Write-Host "Power-off cannot be bypassed. Missed days are caught up on the next run."
Write-Host "Run now: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Pause:   Disable-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove:  Unregister-ScheduledTask -TaskName '$TaskName'"
