<#
.SYNOPSIS
  Builds the Autoflow installers into build\release:
    Autoflow-Studio-Setup-<version>.exe   designer app with its own Python engine
    Autoflow-Robot-<version>.zip          robot: portable Python + install-robot.ps1

.DESCRIPTION
  Needs Node.js 24, pnpm and uv. Used by .github/workflows/release.yml and locally:
      .\deploy\build\build-release.ps1 -Version 0.2.0
#>
[CmdletBinding()]
param([string]$Version = "")

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $Version) { $Version = (Get-Content (Join-Path $Repo "apps\studio\package.json") -Raw | ConvertFrom-Json).version }
$Out = Join-Path $Repo "build\release"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

Push-Location $Repo
try {
    Step "Installing dependencies"
    & pnpm install --frozen-lockfile; Check "pnpm install"

    Step "Bundling Python for Studio and Robot"
    & python deploy/build/bundle_python.py --out build/python-studio; Check "Studio Python bundle"
    & python deploy/build/bundle_python.py --out build/python-robot --robot; Check "Robot Python bundle"

    Step "Building Autoflow Studio $Version"
    Push-Location apps/studio
    try {
        & pnpm exec electron-vite build; Check "electron-vite build"
        & pnpm exec electron-builder --win --publish never "-c.extraMetadata.version=$Version"; Check "electron-builder"
    } finally { Pop-Location }
    Copy-Item "build\studio\Autoflow-Studio-Setup-$Version.exe" $Out -Force

    Step "Packaging Autoflow Robot $Version"
    $staging = Join-Path $Repo "build\robot-staging\Autoflow-Robot"
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Copy-Item "build\python-robot" (Join-Path $staging "python") -Recurse
    Copy-Item "deploy\windows\install-robot.ps1" $staging
    Copy-Item "deploy\ROBOT-SETUP.md" $staging
    Set-Content -Path (Join-Path $staging "VERSION.txt") -Value $Version
    $zip = Join-Path $Out "Autoflow-Robot-$Version.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path $staging -DestinationPath $zip -CompressionLevel Optimal
} finally {
    Pop-Location
}

Step "Done"
Get-ChildItem $Out | ForEach-Object { "{0,-45} {1,8:N0} MB" -f $_.Name, ($_.Length / 1MB) }
