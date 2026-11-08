# The full Kubernetes backup (scripts/k8s-backup.sh), encrypted, copied OFF this machine (a synced folder such as
# OneDrive) and checked, without anyone at the keyboard. Added 2026-11-08: every automatic copy (the database, the
# daily pg-backup slots, the models) lived on the same Docker disk on C:, and the newest copy elsewhere was weeks old.
#
# One-time setup, by the owner: scripts/backup-offsite-setup.ps1 (stores the passphrase with Windows DPAPI for this
# Windows user only, and registers the weekly scheduled task that runs this file).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-offsite.ps1 [-Destination <folder>] [-Keep 8]
# The passphrase never appears on a command line or in a file in plain text; restoring needs the same passphrase:
#   BACKUP_PASSPHRASE=... scripts/k8s-restore.sh <file.tgz.enc> --verify-only | --restore
param(
  [string]$Destination = "",
  [int]$Keep = 8
)
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$State = Join-Path $env:LOCALAPPDATA "Continuum"
$PassFile = Join-Path $State "backup-passphrase.dpapi"
$ConfFile = Join-Path $State "backup-offsite.json"
$Log = Join-Path $State "backup-offsite.log"
$Bash = "C:\Program Files\Git\bin\bash.exe"
New-Item -ItemType Directory -Force $State | Out-Null
function Say($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Output $line; Add-Content -Path $Log -Value $line -Encoding utf8 }

if (-not $Destination -and (Test-Path $ConfFile)) { $Destination = (Get-Content $ConfFile -Raw | ConvertFrom-Json).destination }
if (-not $Destination) { throw "no destination: run scripts\backup-offsite-setup.ps1 or pass -Destination" }
if (-not (Test-Path $PassFile)) { throw "no stored passphrase: run scripts\backup-offsite-setup.ps1 first" }
if (-not (Test-Path $Bash)) { throw "Git Bash not found at $Bash" }
New-Item -ItemType Directory -Force $Destination | Out-Null

$secure = Get-Content $PassFile | ConvertTo-SecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:BACKUP_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  Say "backup started (repository $Repo)"
  Push-Location $Repo
  try {
    & $Bash -lc "scripts/k8s-backup.sh" 2>&1 | ForEach-Object { Add-Content -Path $Log -Value "  $_" -Encoding utf8 }
    if ($LASTEXITCODE -ne 0) { throw "k8s-backup.sh failed (exit $LASTEXITCODE); see $Log" }
    $newest = Get-ChildItem (Join-Path $Repo "_backups") -Filter "continuum-k8s-backup-*.tgz.enc" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $newest -or $newest.LastWriteTime -lt (Get-Date).AddHours(-2)) { throw "no fresh encrypted backup was written" }
    & $Bash -lc "scripts/k8s-restore.sh '_backups/$($newest.Name)' --verify-only" 2>&1 | ForEach-Object { Add-Content -Path $Log -Value "  $_" -Encoding utf8 }
    if ($LASTEXITCODE -ne 0) { throw "the new backup did not verify; it was not copied" }
  } finally { Pop-Location }
  Copy-Item $newest.FullName -Destination $Destination -Force
  $copy = Join-Path $Destination $newest.Name
  if ((Get-FileHash $copy -Algorithm SHA256).Hash -ne (Get-FileHash $newest.FullName -Algorithm SHA256).Hash) { throw "the copy at $copy differs from the backup" }
  Say "copied $($newest.Name) ($([math]::Round($newest.Length / 1MB)) MB) to $Destination, verified"
  # Keep the newest $Keep encrypted copies at the destination; older ones go to the Recycle Bin, not deleted outright.
  $old = Get-ChildItem $Destination -Filter "continuum-k8s-backup-*.tgz.enc" | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
  if ($old) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    foreach ($f in $old) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin')
      Say "older copy moved to the Recycle Bin: $($f.Name)"
    }
  }
  Say "backup done"
} catch {
  Say "BACKUP FAILED: $($_.Exception.Message)"
  exit 1
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:\BACKUP_PASSPHRASE -ErrorAction SilentlyContinue
}
