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
#   -LocalBinary  (Optional) Path to local binary for development testing
#   -Force        (Optional) Force reinstall/reconfigure even if already up to date

param(
    [Parameter(Mandatory=$false, HelpMessage="Your adno agent API key")]
    [string]$ApiKey,

    [Parameter(Mandatory=$false)]
    [string]$ApiUrl = "https://app.adno.dev",

    [Parameter(Mandatory=$false)]
    [string]$Version = "latest",

    [Parameter(Mandatory=$false)]
    [string]$InstallDir = "$env:ProgramFiles\adno Agent",

    [Parameter(Mandatory=$false, HelpMessage="Path to local binary (for development)")]
    [string]$LocalBinary,

    [Parameter(Mandatory=$false)]
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Set UTF-8 encoding for proper symbol display
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Status {
    param([string]$Message)
    Write-Host "○ $Message" -ForegroundColor Cyan
}

function Write-Detail {
    param(
        [string]$Key,
        [string]$Value = ""
    )
    if ($Value) {
        $padding = " " * [Math]::Max(0, 20 - $Key.Length)
        Write-Host "  - ${Key}:${padding}$Value" -ForegroundColor Gray
    } else {
        Write-Host "  - $Key" -ForegroundColor Gray
    }
}

function Write-Info {
    param([string]$Message)
    Write-Host "$Message" -ForegroundColor White
}

function Write-Warn {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    $timestamp = (Get-Date).ToString("HH:mm:ss")
    Write-Host "⨯ [$timestamp] $Message" -ForegroundColor Red
}

function Format-Version {
    param([string]$Version)
    if ([string]::IsNullOrEmpty($Version)) {
        return ""
    }

    $clean = $Version -replace '^v', ''

    if ($clean -match '^(latest|dev-)') {
        return $clean
    }
    return "v$clean"
}

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

    # Dev versions (dev-YYYYMMDD-HHMMSS) are always considered different/newer
    # This forces reinstall prompts when testing local builds
    if ($Current -match '^dev-' -or $Target -match '^dev-') {
        if ($Current -eq $Target) { return 0 }
        return -1  # Treat as "current is older" to trigger update flow
    }

    # Parse semantic versions (e.g., "1.0.3")
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
        Write-Host "-------" -ForegroundColor DarkGray
        if ($attempt -eq 0) {
            Write-Host "Generate one at: $ApiUrl/settings/api-keys" -ForegroundColor Gray
            Write-Host "Format: agnt_ followed by 32 hex characters" -ForegroundColor Gray
            Write-Host ""
        }

        $apiKey = Read-Host "Enter your API key"

        if ($apiKey -match '^agnt_[a-f0-9]{32}$') {
            Write-Success "API key validated"
            return $apiKey
        }

        $attempt++
        Write-Host ""
        Write-Fail "Invalid API key format"

        if ($attempt -lt $maxAttempts) {
            Write-Host '    Expected: agnt_ followed by 32 hex characters (0-9, a-f)' -ForegroundColor Yellow
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
                Write-Warn "Download failed. Retrying in $waitTime seconds..."
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
Write-Host ""
Write-Info "adno Agent Installer"
Write-Host ""
Write-Detail "Target" $ApiUrl
Write-Detail "Installation" $InstallDir
Write-Detail "Version" $(Format-Version $Version)
if ($LocalBinary) {
    Write-Detail "Mode" "Development (local binary)"
}
if ($Force) {
    Write-Detail "Force" "Enabled"
}
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
    Write-Status "Resolving latest version..."
    try {
        $latestRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/r-wa/adno-agent/releases/latest" -UseBasicParsing
        $targetVersion = $latestRelease.tag_name -replace '^agent-v', ''
        Write-Detail "Latest" $(Format-Version $targetVersion)
    } catch {
        Write-Warn "Could not resolve latest version: $_"
    }
}

# Check installed version
$installedVersion = Get-InstalledVersion -InstallDir $InstallDir
if ($installedVersion) {
    Write-Detail "Installed" $(Format-Version $installedVersion)
    $comparison = Compare-Versions -Current $installedVersion -Target $targetVersion

    if ($comparison -eq 0) {
        Write-Success "Version resolved"

        # Check if service is already running (unless Force flag is set)
        if (-not $Force) {
            $serviceName = "AdnoAgent"
            $existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
            if ($existingService -and $existingService.Status -eq "Running") {
                Write-Host ""
                Write-Success "Agent already installed ($(Format-Version $installedVersion))"
                Write-Host ""
                Write-Host "To reinstall or reconfigure, run with -Force flag" -ForegroundColor Gray
                exit 0
            }

            Write-Detail "Status" "Service not running"
        }
        $skipDownload = $true
    } elseif ($comparison -lt 0) {
        Write-Detail "Action" "Upgrade"
        Write-Success "Version resolved"
        $skipDownload = $false
    } else {
        Write-Detail "Action" "Downgrade"
        Write-Warn "Downgrading version"
        $skipDownload = $false
    }
} else {
    Write-Success "Version resolved"
    $skipDownload = $false
}
Write-Host ""

# Create installation directory
Write-Status "Preparing installation..."
try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Success "Installation directory ready"
} catch {
    Write-Fail "Failed to create directory: $_"
    exit 1
}
Write-Host ""

# Stop and remove existing service if reconfiguring
$serviceName = "AdnoAgent"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Status "Removing existing service..."
    try {
        # Stop service if running or paused
        if ($existingService.Status -ne "Stopped") {
            Write-Detail "Stopping service (status: $($existingService.Status))"
            Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
        }

        # Kill any remaining processes
        $agentProcess = Get-Process -Name "adno-agent" -ErrorAction SilentlyContinue
        if ($agentProcess) {
            Write-Detail "Terminating process"
            $agentProcess | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }

        # Remove service
        $nssmPath = Join-Path $InstallDir "nssm.exe"
        if (Test-Path $nssmPath) {
            Write-Detail "Removing registration"
            & $nssmPath remove $serviceName confirm 2>&1 | Out-Null
            Start-Sleep -Seconds 2
        }

        Write-Success "Service removed"
    } catch {
        Write-Warn "Could not fully remove existing service: $_"
    }
    Write-Host ""
}

# Download binary and version file (skip if already up to date)
$binaryPath = Join-Path $InstallDir "adno-agent.exe"
$versionFilePath = Join-Path $InstallDir "adno-agent.exe.version"

# Developer mode: Use local binary if provided
if ($LocalBinary) {
    Write-Status "Installing agent binary..."

    if (-not (Test-Path $LocalBinary)) {
        Write-Fail "Local binary not found: $LocalBinary"
        exit 1
    }

    try {
        Copy-Item $LocalBinary $binaryPath -Force
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        "dev-$timestamp" | Out-File $versionFilePath -NoNewline -Encoding ASCII
        Write-Detail "Source" "Local binary"
        Write-Detail "Version" "dev-$timestamp"
        Write-Success "Binary installed"
    } catch {
        Write-Fail "Failed to copy local binary: $_"
        exit 1
    }
    Write-Host ""
}
elseif (-not $skipDownload) {
    Write-Status "Downloading agent binary..."
    try {
        Download-WithRetry -Url $downloadUrl -OutFile $binaryPath -Activity "Downloading agent binary"
        Write-Success "Download complete"
    } catch {
        Write-Fail "Download failed: $_"
        exit 1
    }

    # Download and verify checksum
    Write-Status "Verifying download integrity..."
    try {
        $checksumResponse = Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing
        $expectedHash = [System.Text.Encoding]::UTF8.GetString($checksumResponse.Content).Trim().Split()[0].ToLower()
        $actualHash = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()

        if ($actualHash -eq $expectedHash) {
            Write-Success "Checksum verified"
        } else {
            Write-Fail "Checksum verification failed"
            Write-Detail "Expected" $expectedHash
            Write-Detail "Actual" $actualHash
            Remove-Item $binaryPath -Force
            exit 1
        }
    } catch {
        Write-Warn "Could not verify checksum"
        $continue = Read-Host "  Continue anyway? (Y/N)"
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
    Write-Host ""
}

# Download and extract NSSM if not present
$nssmPath = Join-Path $InstallDir "nssm.exe"
if (!(Test-Path $nssmPath)) {
    Write-Status "Downloading service wrapper..."
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

        Write-Success "Service wrapper installed"
    } catch {
        Write-Fail "Failed to download service wrapper: $_"
        exit 1
    }
    Write-Host ""
}

# Prompt for API key if not provided
Write-Status "Configuration..."

if (-not $ApiKey -or [string]::IsNullOrWhiteSpace($ApiKey)) {
    $ApiKey = Get-ValidatedApiKey -ApiUrl $ApiUrl
} else {
    Write-Detail "API key" "Provided via parameter"
}
Write-Success "Configuration complete"
Write-Host ""

# Ensure we have an API key before proceeding
if (-not $ApiKey -or [string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Host ""
    Write-Fail "API key is required"
    exit 1
}

# Configure environment variables
Write-Host ""
Write-Info "Installing service..."
try {
    [Environment]::SetEnvironmentVariable("ADNO_API_KEY", $ApiKey, "Machine")
    [Environment]::SetEnvironmentVariable("ADNO_API_URL", $ApiUrl, "Machine")
} catch {
    Write-Fail "Failed to set environment variables: $_"
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
        if ($existingService.Status -eq "Paused") {
            sc.exe stop $serviceName 2>&1 | Out-Null
        } else {
            & $nssmPath stop $serviceName 2>&1 | Out-Null
        }
        Start-Sleep -Seconds 2
        & $nssmPath remove $serviceName confirm 2>&1 | Out-Null
        Start-Sleep -Seconds 2
    } catch {
        # Ignore errors from removing non-existent service
    }
}

# Create Windows service using NSSM
Write-Status "Configuring service..."
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

    # Configure for console application (not a Windows service)
    & $nssmPath set $serviceName AppStopMethodConsole 1500 2>&1 | Out-Null
    & $nssmPath set $serviceName AppStopMethodWindow 1500 2>&1 | Out-Null
    & $nssmPath set $serviceName AppStopMethodThreads 1500 2>&1 | Out-Null

    # Disable PAUSE/RESUME controls (Node.js doesn't support them)
    & $nssmPath set $serviceName AppStopMethodSkip 14 2>&1 | Out-Null

    # Disable file rotation (we handle it ourselves with pino)
    & $nssmPath set $serviceName AppRotateFiles 0 2>&1 | Out-Null

    Write-Detail "Display name" "Adno Agent"
    Write-Detail "Auto-start" "Enabled"
    Write-Detail "Log directory" $logDir
    Write-Success "Service configured"
} catch {
    Write-Fail "Failed to create service: $_"
    exit 1
}
Write-Host ""

# Start service
Write-Status "Starting agent..."
try {
    & $nssmPath start $serviceName 2>&1 | Out-Null
    Start-Sleep -Seconds 5

    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -eq "Running") {
        $installedVersion = Get-InstalledVersion -InstallDir $InstallDir
        Write-Success "Agent started"
        Write-Host ""
        Write-Detail "Binary" $binaryPath
        Write-Detail "Version" $(Format-Version $installedVersion)
        Write-Detail "Logs" $logDir
        Write-Host ""
        Write-Host "  → Open $ApiUrl/settings/agents to verify" -ForegroundColor Cyan
        Write-Host ""
    } else {
        Write-Fail "Installation failed - Service status: $($service.Status)"
        Write-Host ""
        Write-Host "Check logs: $logDir\agent-error.log" -ForegroundColor Yellow
        Write-Host ""
    }
} catch {
    Write-Fail "Failed to start service: $_"
    Write-Host ""
    Write-Host "The service was installed but could not start." -ForegroundColor Yellow
    Write-Host "Check logs: $logDir\agent-error.log" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
