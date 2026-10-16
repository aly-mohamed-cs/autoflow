<#
.SYNOPSIS
  Installs the Autoflow Orchestrator on this Windows computer as a Windows service.

.DESCRIPTION
  Run from the root of a git clone of the Autoflow repository, in an elevated
  PowerShell ("Run as administrator"):

      .\deploy\windows\install-server.ps1

  It builds the server and dashboard, creates the data folder, protects the
  credential-vault key with Windows DPAPI, creates (or imports) the HTTPS
  certificate, registers and starts the "Autoflow Orchestrator" service, opens
  the firewall port and schedules a nightly backup. Safe to run again.

.PARAMETER Port
  HTTPS port. Default 8443.

.PARAMETER HostName
  Name people and robots use to reach this server. Default: this computer's
  fully qualified name.

.PARAMETER PfxPath
  Optional company certificate (.pfx). Without it a self-signed certificate is
  created; robots and Studio then confirm its fingerprint once.

.PARAMETER DataDir
  Where the database, screenshots and keys live. Default: <repo>\data.
#>

#Requires -RunAsAdministrator
# The data folder is for administrators and SYSTEM only: start PowerShell with "Run as administrator".
[CmdletBinding()]
param(
    [int]$Port = 8443,
    [string]$HostName = "",
    [string]$PfxPath = "",
    [SecureString]$PfxPassword,
    [string]$DataDir = "",
    [int]$RetentionDays = 90
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $DataDir) { $DataDir = Join-Path $Repo "data" }
$ServiceName = "AutoflowOrchestrator"
$WinswVersion = "v2.12.0"

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }

# -- 0. checks ------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "Run this script in PowerShell opened with 'Run as administrator'."
}

Step "Checking prerequisites"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org and run this script again." }
$nodeVersion = (& node --version).TrimStart("v")
if ([int]($nodeVersion.Split(".")[0]) -lt 24) { Fail "Node.js $nodeVersion is too old. Install Node.js 24 LTS or newer." }
Write-Host "Node.js $nodeVersion"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "Git is not installed. Install Git for Windows from https://git-scm.com." }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pnpm..."
    & npm install -g pnpm@10 | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Fail "Could not install pnpm. Run 'npm install -g pnpm' and try again." }
}
Write-Host "pnpm $(& pnpm --version)"

if (-not $HostName) {
    $HostName = [System.Net.Dns]::GetHostEntry([Environment]::MachineName).HostName
}
$PublicUrl = "https://$($HostName):$Port"

# -- 1. build -------------------------------------------------------------------------
Step "Building the Orchestrator (this takes a few minutes the first time)"
Push-Location $Repo
try {
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed." }
    & pnpm --filter "@autoflow/server" --filter "@autoflow/dashboard" build
    if ($LASTEXITCODE -ne 0) { Fail "The build failed. See the messages above." }
} finally {
    Pop-Location
}

# -- 2. data folder, vault key, certificate --------------------------------------------
Step "Preparing the data folder $DataDir"
New-Item -ItemType Directory -Force -Path $DataDir, (Join-Path $DataDir "tls"), (Join-Path $DataDir "installers"), (Join-Path $DataDir "backups"), (Join-Path $DataDir "logs") | Out-Null
# Only Administrators and SYSTEM may read the data folder (it holds the database and keys).
& icacls $DataDir /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null

Add-Type -AssemblyName System.Security
$vaultFile = Join-Path $DataDir "vault.key.dpapi"
if (-not (Test-Path $vaultFile)) {
    $plainKeyFile = Join-Path $DataDir "vault.key"
    if (Test-Path $plainKeyFile) {
        $key = [Convert]::FromBase64String((Get-Content $plainKeyFile -Raw).Trim())
    } else {
        $key = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key)
    }
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($key, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    Set-Content -Path $vaultFile -Value ([Convert]::ToBase64String($protected)) -NoNewline
    if (Test-Path $plainKeyFile) { Remove-Item $plainKeyFile -Force }
    Write-Host "Created the credential-vault key (protected with Windows DPAPI)."
} else {
    Write-Host "Vault key already exists - kept."
}

$pfxTarget = Join-Path $DataDir "tls\server.pfx"
$passFile = Join-Path $DataDir "tls\passphrase.txt"
if ($PfxPath) {
    Step "Importing the company certificate"
    if (-not $PfxPassword) { $PfxPassword = Read-Host "Password of $PfxPath" -AsSecureString }
    Copy-Item $PfxPath $pfxTarget -Force
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($PfxPassword))
    Set-Content -Path $passFile -Value $plain -NoNewline
} elseif (-not (Test-Path $pfxTarget)) {
    Step "Creating a self-signed HTTPS certificate for $HostName"
    $names = @($HostName, [Environment]::MachineName, "localhost") | Select-Object -Unique
    $cert = New-SelfSignedCertificate -DnsName $names -CertStoreLocation "Cert:\LocalMachine\My" `
        -FriendlyName "Autoflow Orchestrator" -NotAfter (Get-Date).AddYears(5) -KeyExportPolicy Exportable `
        -KeyAlgorithm RSA -KeyLength 2048
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $pass = [Convert]::ToBase64String($bytes)
    $securePass = ConvertTo-SecureString $pass -AsPlainText -Force
    try {
        # AES keeps the file readable by Node/OpenSSL 3; older Windows lack the option and use their default.
        Export-PfxCertificate -Cert $cert -FilePath $pfxTarget -Password $securePass -CryptoAlgorithmOption AES256_SHA256 | Out-Null
    } catch {
        Export-PfxCertificate -Cert $cert -FilePath $pfxTarget -Password $securePass | Out-Null
    }
    Set-Content -Path $passFile -Value $pass -NoNewline
    Write-Host "Certificate fingerprint (SHA-256):"
    $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData)
    Write-Host (($sha | ForEach-Object { $_.ToString("X2") }) -join ":") -ForegroundColor Yellow
} else {
    Write-Host "Certificate already exists - kept."
}

$configFile = Join-Path $DataDir "config.json"
$config = @{ port = $Port; publicUrl = $PublicUrl; retentionDays = $RetentionDays }
if (Test-Path $configFile) {
    $existing = Get-Content $configFile -Raw | ConvertFrom-Json
    foreach ($p in $existing.PSObject.Properties) { if (-not $config.ContainsKey($p.Name)) { $config[$p.Name] = $p.Value } }
}
# Without a byte-order mark: Windows PowerShell 5.1's "-Encoding UTF8" adds one, which JSON readers reject.
[System.IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

# -- 3. Windows service (WinSW) ---------------------------------------------------------
Step "Registering the Windows service"
$binDir = Join-Path $Repo "deploy\windows\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$serviceExe = Join-Path $binDir "$ServiceName.exe"
if (-not (Test-Path $serviceExe)) {
    $url = "https://github.com/winsw/winsw/releases/download/$WinswVersion/WinSW-x64.exe"
    Write-Host "Downloading the service wrapper (WinSW $WinswVersion) from $url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $serviceExe -UseBasicParsing
}
$xml = @"
<service>
  <id>$ServiceName</id>
  <name>Autoflow Orchestrator</name>
  <description>Autoflow RPA: API, dashboard, scheduler and robot gateway.</description>
  <executable>$($node.Source)</executable>
  <arguments>--disable-warning=ExperimentalWarning "$Repo\apps\server\dist\index.js"</arguments>
  <workingdirectory>$Repo\apps\server</workingdirectory>
  <env name="AUTOFLOW_DATA_DIR" value="$DataDir" />
  <env name="NODE_ENV" value="production" />
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>20 sec</stoptimeout>
  <logpath>$DataDir\logs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
"@
Set-Content -Path (Join-Path $binDir "$ServiceName.xml") -Value $xml -Encoding UTF8

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq "Running") { & $serviceExe stop | Out-Null; Start-Sleep -Seconds 2 }
    & $serviceExe uninstall | Out-Null
}
& $serviceExe install
if ($LASTEXITCODE -ne 0) { Fail "Could not register the service." }
& $serviceExe start
if ($LASTEXITCODE -ne 0) { Fail "The service did not start. See $DataDir\logs." }

# -- 4. firewall & backups -------------------------------------------------------------------
Step "Opening firewall port $Port"
Get-NetFirewallRule -DisplayName "Autoflow Orchestrator" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Autoflow Orchestrator" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Domain,Private | Out-Null

Step "Scheduling the nightly backup (02:00)"
$backupScript = Join-Path $Repo "deploy\windows\backup-server.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`" -DataDir `"$DataDir`""
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
Register-ScheduledTask -TaskName "Autoflow Orchestrator backup" -Action $action -Trigger $trigger -User "SYSTEM" -RunLevel Highest -Force | Out-Null

# -- 5. check ---------------------------------------------------------------------------------
Step "Waiting for the Orchestrator to answer"
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $res = & curl.exe -sk "https://localhost:$Port/health"
        if ($res -match '"ok":true') { $ok = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
}
if (-not $ok) { Fail "The service is installed but not answering yet. Check $DataDir\logs\$ServiceName.out.log." }

Write-Host ""
Write-Host "Autoflow Orchestrator is running." -ForegroundColor Green
Write-Host "  Dashboard:  $PublicUrl"
Write-Host "  Data:       $DataDir"
Write-Host "  Service:    $ServiceName (services.msc)"
Write-Host ""
Write-Host "Next: open the dashboard, create the administrator account, then set up"
Write-Host "directory sign-in under Settings. Updates: .\deploy\windows\update-server.ps1"
