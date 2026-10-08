<#
.SYNOPSIS
  Installs a new Autoflow Robot version that the robot downloaded and checked.

.DESCRIPTION
  Started by the robot (autoflow_robot/updater.py) right before it exits, from a copy in
  <Root>\.update so that nothing it runs from gets replaced:

    1. waits for the old robot to stop,
    2. swaps <Root>\python for the new one, keeping the old one as python.previous,
    3. starts the robot again and waits until the new version reports that it started,
    4. if it doesn't, puts the old version back, starts it, and records that this version
       failed (the robot won't try it again by itself).

  Progress goes to <Root>\.update\update.log.
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Staged,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$StateFile,
    [int]$WaitPid = 0,
    [int]$HealthTimeoutSec = 120,
    [string]$TaskName = "Autoflow Robot"
)

$ErrorActionPreference = "Stop"
$updateDir = Join-Path $Root ".update"
$log = Join-Path $updateDir "update.log"
$current = Join-Path $Root "python"
$previous = Join-Path $Root "python.previous"
$bundleFiles = "install-robot.ps1", "ROBOT-SETUP.md", "VERSION.txt"

function Log([string]$message) {
    Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message) -Encoding UTF8
}

function Retry([scriptblock]$action, [string]$what) {
    # Virus scanners and Explorer briefly lock files that were just written.
    for ($i = 1; $i -le 20; $i++) {
        try { & $action; return }
        catch {
            if ($i -eq 20) { throw "$what failed: $($_.Exception.Message)" }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Start-Robot {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Start-ScheduledTask -TaskName $TaskName
    } else {
        Start-Process -FilePath (Join-Path $current "pythonw.exe") -ArgumentList "-m", "autoflow_robot.cli", "run" -WindowStyle Hidden
    }
}

function Stop-Robot {
    Get-Process -Name python, pythonw -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($current, [StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

function Read-State {
    try { return (Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return [pscustomobject]@{} }
}

function Test-Started {
    return (Read-State).running_version -eq $Version
}

function Set-Failed([string]$why) {
    $state = Read-State
    if (-not $state.failed) { $state | Add-Member -NotePropertyName failed -NotePropertyValue ([pscustomobject]@{}) -Force }
    $state.failed | Add-Member -NotePropertyName $Version -NotePropertyValue $why -Force
    $state | ConvertTo-Json -Depth 5 | Set-Content -Path $StateFile -Encoding UTF8
}

# -- 1 and 2: stop the old robot and put the new version in place --------------------------
try {
    Log "Installing version $Version"
    if ($WaitPid) {
        $proc = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
        if ($proc -and -not $proc.WaitForExit(120000)) {
            Log "The robot did not stop by itself; ending it"
            Stop-Process -Id $WaitPid -Force
        }
    }
    $newPython = Join-Path $Staged "python"
    if (-not (Test-Path (Join-Path $newPython "python.exe"))) { throw "The new version is incomplete ($newPython)." }
    if (Test-Path $previous) { Retry { Remove-Item $previous -Recurse -Force } "Removing an older backup" }
    Retry { Move-Item $current $previous } "Moving the current version aside"
    try {
        Retry { Move-Item $newPython $current } "Putting the new version in place"
    } catch {
        Retry { Move-Item $previous $current } "Restoring the current version"
        throw
    }
    # The files next to python\ come with the package too; keep the old ones in case we go back.
    $previousFiles = Join-Path $updateDir "previous-files"
    if (Test-Path $previousFiles) { Remove-Item $previousFiles -Recurse -Force }
    New-Item -ItemType Directory -Path $previousFiles | Out-Null
    foreach ($file in $bundleFiles) {
        $existing = Join-Path $Root $file
        if (Test-Path $existing) { Copy-Item $existing $previousFiles -Force }
        $source = Join-Path $Staged $file
        if (Test-Path $source) { Copy-Item $source $existing -Force }
    }
} catch {
    Log "Could not install $Version`: $($_.Exception.Message)"
    Set-Failed $_.Exception.Message
    Start-Robot
    exit 1
}

# -- 3: start it and wait until it says it is running ---------------------------------------
Start-Robot
$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
while ((Get-Date) -lt $deadline -and -not (Test-Started)) { Start-Sleep -Seconds 2 }
if (Test-Started) {
    Log "Version $Version is running"
    foreach ($leftover in $previous, $Staged, (Join-Path $updateDir "previous-files")) {
        Remove-Item $leftover -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

# -- 4: it didn't start: go back to the previous version -----------------------------------
Log "Version $Version did not start within $HealthTimeoutSec seconds; going back to the previous version"
try {
    Stop-Robot
    $broken = Join-Path $updateDir "failed-$Version"
    if (Test-Path $broken) { Remove-Item $broken -Recurse -Force }
    Retry { Move-Item $current $broken } "Moving the new version aside"
    Retry { Move-Item $previous $current } "Restoring the previous version"
    $previousFiles = Join-Path $updateDir "previous-files"
    foreach ($file in $bundleFiles) {
        $saved = Join-Path $previousFiles $file
        if (Test-Path $saved) { Copy-Item $saved (Join-Path $Root $file) -Force }
    }
    Remove-Item $previousFiles, $Staged -Recurse -Force -ErrorAction SilentlyContinue
    Set-Failed "It did not start within $HealthTimeoutSec seconds."
} catch {
    Log "Going back failed: $($_.Exception.Message)"
}
Start-Robot
exit 2
