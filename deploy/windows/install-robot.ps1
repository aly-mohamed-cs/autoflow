<#
.SYNOPSIS
  Sets up this computer as an Autoflow robot.

.DESCRIPTION
  Run in PowerShell while signed in as the Windows account the robot should use
  (a dedicated account such as "rpa.robot01" - not a personal account):

      .\install-robot.ps1 -Server https://rpa.company.local:8443 -Key afe_xxxxx

  It enrolls the robot with a one-time key from the dashboard (Robots > Add robot)
  and makes Autoflow Robot start every time this account signs in, restarting it
  if it ever stops. Desktop automation needs a signed-in, unlocked session, so
  the robot account should sign in automatically (see ROBOT-SETUP.md).

.PARAMETER Server
  Orchestrator address, e.g. https://rpa.company.local:8443

.PARAMETER Key
  One-time enrollment key (Dashboard > Robots > Add robot).

.PARAMETER Name
  Name shown in the dashboard. Default: this computer's name.

.PARAMETER TrustCertificate
  Trust the Orchestrator's self-signed certificate (compare the fingerprint first).
#>
[CmdletBinding()]
param(
    [string]$Server = "",
    [string]$Key = "",
    [string]$Name = $env:COMPUTERNAME,
    [switch]$TrustCertificate
)

$ErrorActionPreference = "Stop"
function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }

# Where is Python with the robot installed?
#   installed robot:  <install dir>\python\python.exe   (this script lives in <install dir>)
#   source checkout:  <repo>\robot\.venv\Scripts\python.exe (created with "uv sync")
$candidates = @(
    (Join-Path $PSScriptRoot "python\python.exe"),
    (Join-Path $PSScriptRoot "..\..\robot\.venv\Scripts\python.exe")
)
$python = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $python) {
    $robotDir = Join-Path $PSScriptRoot "..\..\robot"
    if ((Test-Path $robotDir) -and (Get-Command uv -ErrorAction SilentlyContinue)) {
        Step "Installing the robot's Python environment"
        Push-Location $robotDir
        try { & uv sync --no-dev; if ($LASTEXITCODE -ne 0) { Fail "uv sync failed." } } finally { Pop-Location }
        $python = Join-Path $robotDir ".venv\Scripts\python.exe"
    } else {
        Fail "Autoflow Robot is not installed. Run the Autoflow Robot installer first (Dashboard > Settings > Downloads)."
    }
}
$python = (Resolve-Path $python).Path
Write-Host "Using $python"

$configFile = Join-Path $env:LOCALAPPDATA "Autoflow\Robot\robot.json"
if (Test-Path $configFile) {
    Write-Host "This computer is already enrolled ($configFile). Delete that file to enroll again."
} else {
    if (-not $Server) { $Server = Read-Host "Orchestrator address (e.g. https://rpa.company.local:8443)" }
    if (-not $Key) { $Key = Read-Host "Enrollment key from the dashboard" }
    Step "Enrolling as '$Name'"
    $enrollArgs = @("-m", "autoflow_robot.cli", "enroll", "--server", $Server, "--key", $Key, "--name", $Name)
    if ($TrustCertificate) { $enrollArgs += "--trust-certificate" }
    & $python @enrollArgs
    if ($LASTEXITCODE -ne 0) { Fail "Enrollment failed (see the message above)." }
}

Step "Starting the robot at every sign-in of $env:USERNAME"
$pythonw = Join-Path (Split-Path $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }
$action = New-ScheduledTaskAction -Execute $pythonw -Argument "-m autoflow_robot.cli run"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "Autoflow Robot" -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null
Start-ScheduledTask -TaskName "Autoflow Robot"

Step "Keeping the desktop available for automations"
# Desktop automation can't click on a locked or sleeping screen.
& powercfg /change standby-timeout-ac 0 | Out-Null
& powercfg /change monitor-timeout-ac 0 | Out-Null
Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name ScreenSaveActive -Value "0"

Write-Host ""
Write-Host "Done. The robot is running and should show as Online in the dashboard within a minute." -ForegroundColor Green
Write-Host "Logs: $env:LOCALAPPDATA\Autoflow\Robot\logs\robot.log"
Write-Host "For unattended use, set this account to sign in automatically (see ROBOT-SETUP.md)."
