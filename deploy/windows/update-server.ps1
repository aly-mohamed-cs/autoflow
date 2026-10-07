<#
.SYNOPSIS
  Updates the Autoflow Orchestrator to the latest version from GitHub.

.DESCRIPTION
  Run as administrator from the repository root:

      .\deploy\windows\update-server.ps1

  Backs up the database, pulls the latest code, rebuilds, restarts the service
  (database changes are applied automatically on start) and checks it answers.
  With -Installers it also downloads the latest Studio and Robot installers from
  the GitHub release into the Downloads page (needs the GitHub CLI signed in).
#>
[CmdletBinding()]
param(
    [string]$DataDir = "",
    [switch]$Installers,
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $DataDir) { $DataDir = Join-Path $Repo "data" }
$ServiceName = "AutoflowOrchestrator"
$serviceExe = Join-Path $Repo "deploy\windows\bin\$ServiceName.exe"

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $serviceExe)) { Fail "The service is not installed here. Run install-server.ps1 first." }

Step "Backing up the database"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "backup-server.ps1") -DataDir $DataDir
if ($LASTEXITCODE -ne 0) { Fail "Backup failed - nothing was changed." }

Push-Location $Repo
try {
    Step "Getting the latest version"
    $before = (& git rev-parse --short HEAD).Trim()
    & git fetch origin $Branch
    & git merge --ff-only "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { Fail "Could not update the code (local changes?). Run 'git status' to see why." }
    $after = (& git rev-parse --short HEAD).Trim()
    if ($before -eq $after) { Write-Host "Already up to date ($after)." } else { Write-Host "Updated $before -> $after"; & git log --oneline "$before..$after" | Select-Object -First 15 }

    Step "Building"
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed. The running service was not touched." }
    & pnpm --filter "@autoflow/server" --filter "@autoflow/dashboard" build
    if ($LASTEXITCODE -ne 0) { Fail "The build failed. Run 'git checkout $before' and rebuild to go back." }
} finally {
    Pop-Location
}

if ($Installers) {
    Step "Downloading the latest installers"
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Warning "GitHub CLI (gh) is not installed - skipped. Copy installers into $DataDir\installers by hand."
    } else {
        $remote = (& git -C $Repo remote get-url origin).Trim()
        $slug = ($remote -replace '^.*github\.com[:/]', '') -replace '\.git$', ''
        & gh release download --repo $slug --pattern "*.exe" --dir (Join-Path $DataDir "installers") --clobber
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not download installers (no release yet, or gh is not signed in)." }
    }
}

Step "Restarting the service"
& $serviceExe restart
if ($LASTEXITCODE -ne 0) { Fail "The service did not restart. See $DataDir\logs." }

$port = 8443
$configFile = Join-Path $DataDir "config.json"
if (Test-Path $configFile) { $port = (Get-Content $configFile -Raw | ConvertFrom-Json).port }
for ($i = 0; $i -lt 30; $i++) {
    $res = & curl.exe -sk "https://localhost:$port/health"
    if ($res -match '"ok":true') {
        Write-Host ""
        Write-Host "Update complete: $res" -ForegroundColor Green
        exit 0
    }
    Start-Sleep -Seconds 2
}
Fail "The service restarted but is not answering. See $DataDir\logs\$ServiceName.out.log. The backup from before the update is in $DataDir\backups."
