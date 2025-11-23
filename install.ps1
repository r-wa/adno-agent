# adno Agent Installer for Windows
# Downloads and installs the latest adno agent as a Windows service
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ApiUrl "https://app.adno.dev"
#
# Parameters:
#   -ApiKey       (Optional) Your adno agent API key (will prompt if not provided)
#   -ApiUrl       (Optional) adno server URL (default: https://app.adno.dev)
#   -Version      (Optional) Specific version to install (default: latest)
#   -InstallDir   (Optional) Installation directory (default: C:\Program Files\adno Agent)

param(
    [Parameter(Mandatory=$false, HelpMessage="Your adno agent API key")]
    [string]$ApiKey,

    [Parameter(Mandatory=$false)]
    [string]$ApiUrl = "https://app.adno.dev",

    [Parameter(Mandatory=$false)]
    [string]$Version = "latest",

    [Parameter(Mandatory=$false)]
    [string]$InstallDir = "$env:ProgramFiles\adno Agent"
)

$ErrorActionPreference = "Stop"

# Colors for output
function Write-Success { param([string]$Message) Write-Host $Message -ForegroundColor Green }
function Write-Info { param([string]$Message) Write-Host $Message -ForegroundColor Cyan }
function Write-Warn { param([string]$Message) Write-Host $Message -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host $Message -ForegroundColor Red }

# Helper function: Get installed version
function Get-InstalledVersion {
    param([string]$InstallDir)
    $versionFile = Join-Path $InstallDir "adno-agent.exe.version"
    if (Test-Path $versionFile) {
        return (Get-Content $versionFile -Raw).Trim()
    }
    return $null
}

# Helper function: Compare semantic versions
function Compare-Versions {
    param(
        [string]$Current,
        [string]$Target
    )

    if ($Current -eq $Target) { return 0 }
    if (-not $Current) { return -1 }
    if (-not $Target) { return 1 }

    $currentParts = $Current.Split('.')
    $targetParts = $Target.Split('.')

    for ($i = 0; $i -lt [Math]::Max($currentParts.Length, $targetParts.Length); $i++) {
        $currentNum = if ($i -lt $currentParts.Length) { [int]$currentParts[$i] } else { 0 }
        $targetNum = if ($i -lt $targetParts.Length) { [int]$targetParts[$i] } else { 0 }

        if ($currentNum -lt $targetNum) { return -1 }
        if ($currentNum -gt $targetNum) { return 1 }
    }

    return 0
}

# Helper function: Prompt for API key with validation
function Get-ValidatedApiKey {
    param([string]$ApiUrl)
    $maxAttempts = 3
    $attempt = 0

    while ($attempt -lt $maxAttempts) {
        Write-Host ""
        Write-Host "API Key" -ForegroundColor Cyan
        Write-Host "━━━━━━━" -ForegroundColor DarkGray
        if ($attempt -eq 0) {
            Write-Host "Generate one at: $ApiUrl/settings/api-keys" -ForegroundColor Gray
            Write-Host "Format: agnt_ followed by 40 hex characters" -ForegroundColor Gray
            Write-Host ""
        }

        $apiKey = Read-Host "Enter your API key"

        if ($apiKey -match '^agnt_[a-f0-9]{40}$') {
            Write-Host "  ✓ API key validated" -ForegroundColor Green
            return $apiKey
        }

        $attempt++
        Write-Host ""
        Write-Host "  ✗ Invalid format" -ForegroundColor Red

        if ($attempt -lt $maxAttempts) {
            Write-Host "    Expected: agnt_ followed by 40 hex characters (0-9, a-f)" -ForegroundColor Yellow
            Write-Host "    Please try again ($attempt/$maxAttempts)" -ForegroundColor Yellow
        } else {
            Write-Host "    Too many failed attempts. Please check your API key and try again." -ForegroundColor Red
            exit 1
        }
    }
}

# Helper function: Download with retry and progress
function Download-WithRetry {
    param([string]$Url, [string]$OutFile, [string]$Activity, [int]$MaxRetries = 3)
    $retryCount = 0
    while ($retryCount -lt $MaxRetries) {
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

            $webClient = New-Object System.Net.WebClient
            $webClient.Headers.Add("User-Agent", "Adno-Installer/1.0")

            Register-ObjectEvent -InputObject $webClient -EventName DownloadProgressChanged -SourceIdentifier WebClient.DownloadProgressChanged -Action {
                $percent = $EventArgs.ProgressPercentage
                $received = $EventArgs.BytesReceived / 1MB
                $total = $EventArgs.TotalBytesToReceive / 1MB
                Write-Progress -Activity $Activity -Status ("$([math]::Round($received, 1)) MB / $([math]::Round($total, 1)) MB") -PercentComplete $percent
            } | Out-Null

            $webClient.DownloadFileTaskAsync($Url, $OutFile).Wait()
            Write-Progress -Activity $Activity -Completed
            Unregister-Event -SourceIdentifier WebClient.DownloadProgressChanged -ErrorAction SilentlyContinue
            $webClient.Dispose()
            return
        } catch {
            Write-Progress -Activity $Activity -Completed
            Unregister-Event -SourceIdentifier WebClient.DownloadProgressChanged -ErrorAction SilentlyContinue
            $retryCount++
            if ($retryCount -lt $MaxRetries) {
                $waitTime = [math]::Pow(2, $retryCount)
                Write-Host "  ✗ Download failed. Retrying in $waitTime seconds..." -ForegroundColor Yellow
                Start-Sleep -Seconds $waitTime
            } else {
                throw "Failed to download after $MaxRetries attempts: $_"
            }
        }
    }
}

# Check if running as administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Fail "Error: This script must be run as Administrator"
    Write-Info "Right-click PowerShell and select 'Run as Administrator'"
    exit 1
}

# Welcome screen
Clear-Host
Write-Host ""
Write-Host "Adno Agent Installer" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""
Write-Host "This will install the workspace agent as a Windows service." -ForegroundColor White
Write-Host "Estimated time: ~1 minute" -ForegroundColor Gray
Write-Host ""
Write-Host "Configuration:" -ForegroundColor Cyan
Write-Host "  Version:     $Version" -ForegroundColor Gray
Write-Host "  API URL:     $ApiUrl" -ForegroundColor Gray
Write-Host "  Install Dir: $InstallDir" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Enter to begin..." -ForegroundColor Gray -NoNewline
Read-Host
Write-Host ""

# Determine download URLs
$binaryName = "adno-agent-windows-x64.exe"
if ($Version -eq "latest") {
    $downloadUrl = "https://github.com/r-wa/adno-agent/releases/latest/download/$binaryName"
    $checksumUrl = "https://github.com/r-wa/adno-agent/releases/latest/download/$binaryName.sha256"
} else {
    $downloadUrl = "https://github.com/r-wa/adno-agent/releases/download/$Version/$binaryName"
    $checksumUrl = "https://github.com/r-wa/adno-agent/releases/download/$Version/$binaryName.sha256"
}

# NSSM (Non-Sucking Service Manager) for Windows service wrapper
$nssmVersion = "2.24"
$nssmUrl = "https://nssm.cc/release/nssm-$nssmVersion.zip"

# Resolve target version (if "latest", fetch from GitHub API)
$targetVersion = $Version
if ($Version -eq "latest") {
    Write-Info "Resolving latest version..."
    try {
        $latestRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/r-wa/adno-agent/releases/latest" -UseBasicParsing
        $targetVersion = $latestRelease.tag_name -replace '^agent-v', ''
        Write-Host "  Latest version: $targetVersion" -ForegroundColor Gray
    } catch {
        Write-Warn "  ⚠ Could not resolve latest version: $_"
    }
}

# Check installed version
$installedVersion = Get-InstalledVersion -InstallDir $InstallDir
if ($installedVersion) {
    Write-Host "  Installed version: $installedVersion" -ForegroundColor Gray
    $comparison = Compare-Versions -Current $installedVersion -Target $targetVersion

    if ($comparison -eq 0) {
        Write-Success "  ✓ Version $installedVersion is already up to date"
        Write-Host "  Skipping download, proceeding to service configuration..." -ForegroundColor Gray
        $skipDownload = $true
    } elseif ($comparison -lt 0) {
        Write-Host "  Upgrading from v$installedVersion to v$targetVersion" -ForegroundColor Cyan
        $skipDownload = $false
    } else {
        Write-Warn "  ⚠ Downgrading from v$installedVersion to v$targetVersion"
        $skipDownload = $false
    }
} else {
    Write-Host "  No existing installation detected" -ForegroundColor Gray
    $skipDownload = $false
}

# Create installation directory
Write-Host ""
Write-Info "Preparing installation..."
try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Success "  ✓ Installation directory ready"
} catch {
    Write-Fail "  ✗ Failed to create directory: $_"
    exit 1
}

# Download binary and version file (skip if already up to date)
$binaryPath = Join-Path $InstallDir "adno-agent.exe"
$versionFilePath = Join-Path $InstallDir "adno-agent.exe.version"

if (-not $skipDownload) {
    # Stop service before replacing binary (if it exists and is running)
    $serviceName = "AdnoAgent"
    $existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($existingService -and $existingService.Status -eq "Running") {
        Write-Host "  Stopping existing service..." -ForegroundColor Gray
        Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    Write-Host ""
    Write-Info "Downloading agent binary..."
    try {
        Download-WithRetry -Url $downloadUrl -OutFile $binaryPath -Activity "Downloading agent binary"
        Write-Success "  ✓ Agent binary downloaded"
    } catch {
        Write-Host ""
        Write-Fail "  ✗ Download failed: $_"
        exit 1
    }

    # Download and verify checksum
    Write-Host ""
    Write-Info "Verifying download integrity..."
    try {
        $checksumResponse = Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing
        $expectedHash = [System.Text.Encoding]::UTF8.GetString($checksumResponse.Content).Trim().Split()[0].ToLower()
        $actualHash = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()

        if ($actualHash -eq $expectedHash) {
            Write-Success "  ✓ SHA256 checksum verified"
        } else {
            Write-Fail "  ✗ Checksum verification failed"
            Write-Fail "    Expected: $expectedHash"
            Write-Fail "    Actual: $actualHash"
            Remove-Item $binaryPath -Force
            exit 1
        }
    } catch {
        Write-Warn "  ⚠ Could not verify checksum"
        $continue = Read-Host "    Continue anyway? (Y/N)"
        if ($continue -ne 'Y') {
            Remove-Item $binaryPath -Force
            exit 0
        }
    }

    # Download version file for future version checks
    try {
        $versionUrl = if ($Version -eq "latest") {
            "https://github.com/r-wa/adno-agent/releases/latest/download/$binaryName.version"
        } else {
            "https://github.com/r-wa/adno-agent/releases/download/$Version/$binaryName.version"
        }
        Invoke-WebRequest -Uri $versionUrl -OutFile $versionFilePath -UseBasicParsing
    } catch {
        # Create version file manually if download fails
        if ($targetVersion) {
            $targetVersion | Out-File -FilePath $versionFilePath -Encoding ASCII -NoNewline
        }
    }
}

# Download and extract NSSM if not present
$nssmPath = Join-Path $InstallDir "nssm.exe"
if (!(Test-Path $nssmPath)) {
    Write-Host ""
    Write-Info "Downloading service wrapper..."
    $nssmZip = Join-Path $env:TEMP "nssm.zip"
    $nssmExtract = Join-Path $env:TEMP "nssm"
    try {
        Download-WithRetry -Url $nssmUrl -OutFile $nssmZip -Activity "Downloading NSSM"

        $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
        Expand-Archive -Path $nssmZip -DestinationPath $nssmExtract -Force
        Copy-Item "$nssmExtract\nssm-$nssmVersion\$arch\nssm.exe" $nssmPath -Force

        # Cleanup
        Remove-Item $nssmZip -Force -ErrorAction SilentlyContinue
        Remove-Item $nssmExtract -Recurse -Force -ErrorAction SilentlyContinue

        Write-Success "  ✓ Service wrapper installed"
    } catch {
        Write-Host ""
        Write-Fail "  ✗ Failed to download service wrapper: $_"
        exit 1
    }
}

# Prompt for API key if not provided
if (-not $ApiKey) {
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host "Configuration" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    $ApiKey = Get-ValidatedApiKey -ApiUrl $ApiUrl
}

# Configure environment variables
Write-Host ""
Write-Info "Installing service..."
try {
    [Environment]::SetEnvironmentVariable("ADNO_API_KEY", $ApiKey, "Machine")
    [Environment]::SetEnvironmentVariable("ADNO_API_URL", $ApiUrl, "Machine")
} catch {
    Write-Fail "  ✗ Failed to set environment variables: $_"
    exit 1
}

# Create .env file for reference
$envFile = Join-Path $InstallDir ".env"
$envContent = @"
# adno Agent Configuration
ADNO_API_KEY=$ApiKey
ADNO_API_URL=$ApiUrl

# Optional: Azure DevOps Configuration
# ADO_ORGANIZATION=your-org
# ADO_PROJECT=your-project
# ADO_PAT_TOKEN=your-pat

# Optional: Azure OpenAI Configuration
# AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
# AZURE_OPENAI_API_KEY=your-key
# AZURE_OPENAI_DEPLOYMENT=gpt-4

# Agent Settings
POLL_INTERVAL_MS=30000
HEARTBEAT_INTERVAL_MS=60000
MAX_CONCURRENT_TASKS=3
LOG_LEVEL=info
"@
$envContent | Out-File -FilePath $envFile -Encoding UTF8

# Remove existing service if it exists
$serviceName = "AdnoAgent"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
    try {
        & $nssmPath stop $serviceName 2>&1 | Out-Null
        Start-Sleep -Seconds 2
        & $nssmPath remove $serviceName confirm 2>&1 | Out-Null
        Start-Sleep -Seconds 2
    } catch {
        # Ignore errors from removing non-existent service
    }
}

# Create Windows service using NSSM
try {
    # Install the service
    & $nssmPath install $serviceName $binaryPath 2>&1 | Out-Null
    & $nssmPath set $serviceName DisplayName "Adno Agent" 2>&1 | Out-Null
    & $nssmPath set $serviceName Description "Background agent for Adno workspace tasks" 2>&1 | Out-Null
    & $nssmPath set $serviceName Start SERVICE_AUTO_START 2>&1 | Out-Null
    & $nssmPath set $serviceName AppEnvironmentExtra "ADNO_API_KEY=$ApiKey" "ADNO_API_URL=$ApiUrl" 2>&1 | Out-Null

    # Set output logging
    $logDir = Join-Path $InstallDir "logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    & $nssmPath set $serviceName AppStdout (Join-Path $logDir "agent.log") 2>&1 | Out-Null
    & $nssmPath set $serviceName AppStderr (Join-Path $logDir "agent-error.log") 2>&1 | Out-Null
    & $nssmPath set $serviceName AppStdoutCreationDisposition 4 2>&1 | Out-Null
    & $nssmPath set $serviceName AppStderrCreationDisposition 4 2>&1 | Out-Null

    # Configure service to restart on failure
    & $nssmPath set $serviceName AppExit Default Restart 2>&1 | Out-Null
    & $nssmPath set $serviceName AppRestartDelay 5000 2>&1 | Out-Null

    Write-Success "  ✓ Service configured"
} catch {
    Write-Fail "  ✗ Failed to create service: $_"
    exit 1
}

# Start service
Write-Host ""
Write-Info "Starting agent..."
try {
    & $nssmPath start $serviceName 2>&1 | Out-Null
    Write-Host "  Waiting for service to start (this may take up to 30 seconds)..." -ForegroundColor Gray
    Start-Sleep -Seconds 5

    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -eq "Running") {
        Write-Host ""
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
        Write-Host "✓ Installation Complete!" -ForegroundColor Green
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
        Write-Host ""
        Write-Host "Your agent is now running as a Windows service." -ForegroundColor White
        Write-Host ""
        Write-Host "Next: Verify agent status" -ForegroundColor Cyan
        Write-Host "  → Open: $ApiUrl/settings/agents" -ForegroundColor Gray
        Write-Host "  → You should see your agent listed as 'Online'" -ForegroundColor Gray
        Write-Host "  → Pending tasks will begin processing automatically" -ForegroundColor Gray
        Write-Host ""
        Write-Host "Logs: $logDir" -ForegroundColor DarkGray
    } else {
        Write-Host ""
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Red
        Write-Host "✗ Installation Failed" -ForegroundColor Red
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Red
        Write-Host ""
        Write-Host "Service status: $($service.Status)" -ForegroundColor Yellow
        Write-Host "Check logs: $logDir\agent-error.log" -ForegroundColor Yellow
    }
} catch {
    Write-Host ""
    Write-Fail "  ✗ Failed to start service: $_"
    Write-Host ""
    Write-Host "The service was installed but could not start." -ForegroundColor Yellow
    Write-Host "Check Event Viewer or $logDir\agent-error.log for details." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
