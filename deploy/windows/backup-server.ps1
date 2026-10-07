<#
.SYNOPSIS
  Copies the Autoflow database and settings into <data>\backups (keeps the last 14).

.DESCRIPTION
  Runs nightly as a scheduled task (created by install-server.ps1) and before
  every update. The database is copied while the server keeps running.

  Note: the credential-vault key is protected for THIS computer only. To move to a
  new server, re-enter credentials there (or ask IT to transfer the key securely).
#>
[CmdletBinding()]
param(
    [string]$DataDir = "",
    [int]$Keep = 14
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $DataDir) { $DataDir = Join-Path $Repo "data" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $DataDir "backups\$stamp"
New-Item -ItemType Directory -Force -Path $target | Out-Null

$env:AUTOFLOW_DATA_DIR = $DataDir
& node --disable-warning=ExperimentalWarning (Join-Path $Repo "apps\server\dist\index.js") backup (Join-Path $target "autoflow.db")
if ($LASTEXITCODE -ne 0) { Write-Error "Database backup failed."; exit 1 }
foreach ($file in @("config.json", "vault.key.dpapi")) {
    $source = Join-Path $DataDir $file
    if (Test-Path $source) { Copy-Item $source $target }
}

Get-ChildItem (Join-Path $DataDir "backups") -Directory | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Recurse -Force
Write-Host "Backup saved to $target"
