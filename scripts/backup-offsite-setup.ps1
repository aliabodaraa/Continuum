# One-time setup of the automatic off-machine backup (scripts/backup-offsite.ps1). Run it yourself, once, in a
# normal (not administrator) PowerShell window:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-offsite-setup.ps1
# It asks for a backup passphrase (keep it in your password manager: without it no backup can be restored), stores
# it with Windows DPAPI so only this Windows user on this PC can read it, records the destination folder, and
# registers the weekly task "Continuum off-site backup" (Sunday 14:00; a run missed while the PC was off starts
# when it is back). Remove the task with:  Unregister-ScheduledTask -TaskName "Continuum off-site backup"
param(
  [string]$Destination = (Join-Path $env:USERPROFILE "OneDrive\Continuum-backups"),
  [string]$Day = "Sunday",
  [string]$At = "14:00"
)
$ErrorActionPreference = "Stop"
$State = Join-Path $env:LOCALAPPDATA "Continuum"
New-Item -ItemType Directory -Force $State | Out-Null

$p1 = Read-Host "Backup passphrase (at least 12 characters)" -AsSecureString
$p2 = Read-Host "The same passphrase again" -AsSecureString
$plain = { param($s) $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) } }
$a = & $plain $p1; $b = & $plain $p2
if ($a -ne $b) { throw "the two passphrases differ; nothing was saved" }
if ($a.Length -lt 12) { throw "use at least 12 characters; nothing was saved" }
$a = $null; $b = $null
$p1 | ConvertFrom-SecureString | Set-Content -Path (Join-Path $State "backup-passphrase.dpapi") -Encoding ascii
@{ destination = $Destination } | ConvertTo-Json | Set-Content -Path (Join-Path $State "backup-offsite.json") -Encoding utf8
New-Item -ItemType Directory -Force $Destination | Out-Null
Write-Output "passphrase stored for this Windows user only; destination: $Destination"

$script = Join-Path $PSScriptRoot "backup-offsite.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName "Continuum off-site backup" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Encrypted full Continuum backup copied to $Destination (scripts/backup-offsite.ps1)" -Force | Out-Null
Write-Output "weekly task registered: $Day $At. Run the first backup now with:"
Write-Output "  Start-ScheduledTask -TaskName 'Continuum off-site backup'   (log: $State\backup-offsite.log)"
