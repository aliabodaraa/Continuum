# Continuum's alerts as Windows notifications on this PC (2026-11-12). Grafana, in the cluster, sends each alert that
# fires or ends to http://host.docker.internal:39871/alert, which Docker Desktop delivers to 127.0.0.1 here; this
# program checks the token (CONTINUUM_ALERT_TOKEN in deploy/k8s/overlays/local/secrets/grafana.env) and shows the
# alert's summary and description. It listens on this PC's own address only, and nothing leaves the machine.
# The rules: deploy/k8s/base/observability/alerting/continuum-alerts.yaml. Its log: %LOCALAPPDATA%\Continuum\alerts.log
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\alert-notifier.ps1 -Register     start now and at each sign-in
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\alert-notifier.ps1 -Test         one test notification
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\alert-notifier.ps1 -Unregister   stop and remove it
# A notification is not shown while Windows' "Do not disturb" is on; it waits in the notification centre.
param([switch]$Register, [switch]$Unregister, [switch]$Test)
$ErrorActionPreference = "Stop"
$Port = 39871
$TaskName = "Continuum alerts"
$Repo = Split-Path -Parent $PSScriptRoot
$SecretFile = Join-Path $Repo "deploy\k8s\overlays\local\secrets\grafana.env"
$State = Join-Path $env:LOCALAPPDATA "Continuum"
$Log = Join-Path $State "alerts.log"
New-Item -ItemType Directory -Force $State | Out-Null
function Say($m) { Add-Content -Path $Log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" -Encoding utf8 }

function Show-Toast([string]$Title, [string]$Body) {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $t = [System.Security.SecurityElement]::Escape($Title); $b = [System.Security.SecurityElement]::Escape($Body)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
  # Windows PowerShell's own application id: a notification needs a registered app to come from.
  $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
}

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like "*alert-notifier.ps1*" -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  "removed"; exit 0
}
if ($Test) { Show-Toast "Continuum" "تجربة: تنبيهات Continuum تصل إلى هذا الجهاز."; "a test notification was shown"; exit 0 }
if ($Register) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force `
    -Description "Shows Continuum's alerts (Grafana in the local cluster) as Windows notifications. scripts\alert-notifier.ps1" | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  "registered and started: $TaskName"; exit 0
}

# ---- the listener
$token = ""
if (Test-Path $SecretFile) {
  $line = Get-Content $SecretFile | Where-Object { $_ -like "CONTINUUM_ALERT_TOKEN=*" } | Select-Object -First 1
  if ($line) { $token = $line.Substring("CONTINUUM_ALERT_TOKEN=".Length).Trim() }
}
if (-not $token) { Say "no CONTINUUM_ALERT_TOKEN in $SecretFile (scripts/k8s-local.sh secrets makes it)"; exit 1 }
try { $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port); $listener.Start() }
catch { Say "port $Port is in use: another copy is running"; exit 0 }
Say "listening on 127.0.0.1:$Port"

function Send-Answer($stream, [int]$code, [string]$text) {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $code $text`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
  $stream.Write($bytes, 0, $bytes.Length)
}

function Handle($client) {
  $stream = $client.GetStream(); $stream.ReadTimeout = 5000
  $data = New-Object System.IO.MemoryStream; $buf = New-Object byte[] 8192; $end = -1
  while ($end -lt 0 -and $data.Length -lt 65536) {
    $n = $stream.Read($buf, 0, $buf.Length); if ($n -le 0) { return }
    $data.Write($buf, 0, $n)
    $end = [System.Text.Encoding]::ASCII.GetString($data.ToArray()).IndexOf("`r`n`r`n")
  }
  if ($end -lt 0) { return }
  $head = [System.Text.Encoding]::ASCII.GetString($data.ToArray(), 0, $end) -split "`r`n"
  $headers = @{}
  foreach ($h in $head[1..($head.Count - 1)]) { $i = $h.IndexOf(":"); if ($i -gt 0) { $headers[$h.Substring(0, $i).Trim().ToLower()] = $h.Substring($i + 1).Trim() } }
  if ($headers["authorization"] -ne "Bearer $token") { Send-Answer $stream 401 "Unauthorized"; Say "refused a request without the right token"; return }
  $length = [int]($headers["content-length"])
  while ($data.Length - ($end + 4) -lt $length) { $n = $stream.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $data.Write($buf, 0, $n) }
  $body = [System.Text.Encoding]::UTF8.GetString($data.ToArray(), $end + 4, [Math]::Min($length, $data.Length - ($end + 4)))
  Send-Answer $stream 200 "OK"
  $payload = $body | ConvertFrom-Json
  $alerts = @($payload.alerts)
  foreach ($a in ($alerts | Select-Object -First 3)) {
    $summary = if ($a.annotations.summary) { $a.annotations.summary } else { $a.labels.alertname }
    if ($a.status -eq "resolved") { $title = "Continuum: عاد إلى العمل"; $text = $summary }
    else { $title = "Continuum: $summary"; $text = [string]$a.annotations.description }
    Say "$($a.status): $($a.labels.alertname) $($a.labels.job)"
    Show-Toast $title $text
  }
  if ($alerts.Count -gt 3) { Show-Toast "Continuum" "و$($alerts.Count - 3) تنبيهات أخرى: افتح Grafana"; Say "$($alerts.Count) alerts in one message" }
}

while ($true) {
  $client = $listener.AcceptTcpClient()
  try { Handle $client } catch { Say "error: $($_.Exception.Message)" } finally { $client.Close() }
}
