# adno Agent Installer for Windows
# Downloads and installs the latest adno agent as a Windows service
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ApiKey "your-api-key"
#
# Parameters:
#   -ApiKey       (Required) Your adno agent API key from the web dashboard
#   -ApiUrl       (Optional) adno server URL (default: https://app.adno.dev)
#   -Version      (Optional) Specific version to install (default: latest)
#   -InstallDir   (Optional) Installation directory (default: C:\Program Files\adno Agent)

param(
    [Parameter(Mandatory=$true, HelpMessage="Your adno agent API key")]
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

# Check if running as administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Fail "Error: This script must be run as Administrator"
    Write-Info "Right-click PowerShell and select 'Run as Administrator'"
    exit 1
}

# Validate API key format (skip for placeholder)
if ($ApiKey -ne "ROTATE_KEY_FIRST" -and $ApiKey -notlike "agnt_*") {
    Write-Fail "Error: Invalid API key format (must start with 'agnt_')"
    Write-Fail "Received: $ApiKey"
    exit 1
}

Write-Info "================================"
Write-Info "adno Agent Installer"
Write-Info "================================"
Write-Info "Version: $Version"
Write-Info "API URL: $ApiUrl"
Write-Info "Install Directory: $InstallDir"
Write-Info ""

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
        Write-Info "Latest version: $targetVersion"
    } catch {
        Write-Warn "Warning: Could not resolve latest version: $_"
        Write-Info "Continuing with download..."
    }
}

# Check installed version
$installedVersion = Get-InstalledVersion -InstallDir $InstallDir
if ($installedVersion) {
    Write-Info "Installed version: $installedVersion"
    $comparison = Compare-Versions -Current $installedVersion -Target $targetVersion

    if ($comparison -eq 0) {
        Write-Success "Version $installedVersion is already installed and up to date!"
        Write-Info "Skipping download, proceeding to service configuration..."
        $skipDownload = $true
    } elseif ($comparison -lt 0) {
        Write-Info "Upgrading from v$installedVersion to v$targetVersion"
        $skipDownload = $false
    } else {
        Write-Warn "Warning: Downgrading from v$installedVersion to v$targetVersion"
        $skipDownload = $false
    }
} else {
    Write-Info "No existing installation detected"
    $skipDownload = $false
}

# Create installation directory
Write-Info "Creating installation directory..."
try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Success "[OK] Directory created"
} catch {
    Write-Fail "Failed to create directory: $_"
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
        Write-Info "Stopping service before file replacement..."
        Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    Write-Info "Downloading agent binary..."
    Write-Info "URL: $downloadUrl"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $downloadUrl -OutFile $binaryPath -UseBasicParsing
        Write-Success "[OK] Binary downloaded"
    } catch {
        Write-Fail "Failed to download binary: $_"
        exit 1
    }

    # Download and verify checksum
    Write-Info "Verifying checksum..."
    try {
        $checksumResponse = Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing
        $expectedHash = [System.Text.Encoding]::UTF8.GetString($checksumResponse.Content).Trim()
        $actualHash = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash

        if ($actualHash -eq $expectedHash) {
            Write-Success "[OK] Checksum verified"
        } else {
            Write-Fail "Checksum mismatch!"
            Write-Fail "Expected: $expectedHash"
            Write-Fail "Actual: $actualHash"
            Write-Warn "Removing potentially corrupted file..."
            Remove-Item $binaryPath -Force
            exit 1
        }
    } catch {
        Write-Warn "Warning: Could not verify checksum: $_"
        Write-Warn "Continuing anyway (use at your own risk)..."
    }

    # Download version file for future version checks
    Write-Info "Downloading version metadata..."
    try {
        $versionUrl = if ($Version -eq "latest") {
            "https://github.com/r-wa/adno-agent/releases/latest/download/$binaryName.version"
        } else {
            "https://github.com/r-wa/adno-agent/releases/download/$Version/$binaryName.version"
        }
        Invoke-WebRequest -Uri $versionUrl -OutFile $versionFilePath -UseBasicParsing
        Write-Success "[OK] Version metadata downloaded"
    } catch {
        Write-Warn "Warning: Could not download version file: $_"
        # Create version file manually if download fails
        if ($targetVersion) {
            $targetVersion | Out-File -FilePath $versionFilePath -Encoding ASCII -NoNewline
            Write-Info "Created version file manually"
        }
    }
} else {
    Write-Info "Using existing binary at: $binaryPath"
}

# Download and extract NSSM
Write-Info "Downloading NSSM (service wrapper)..."
$nssmZip = Join-Path $env:TEMP "nssm.zip"
$nssmExtract = Join-Path $env:TEMP "nssm"
try {
    Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -UseBasicParsing
    Expand-Archive -Path $nssmZip -DestinationPath $nssmExtract -Force

    # Copy the appropriate architecture nssm.exe to install directory
    $nssmExe = Join-Path $nssmExtract "nssm-$nssmVersion\win64\nssm.exe"
    $nssmPath = Join-Path $InstallDir "nssm.exe"
    Copy-Item $nssmExe $nssmPath -Force

    # Cleanup
    Remove-Item $nssmZip -Force -ErrorAction SilentlyContinue
    Remove-Item $nssmExtract -Recurse -Force -ErrorAction SilentlyContinue

    Write-Success "[OK] NSSM downloaded"
} catch {
    Write-Fail "Failed to download NSSM: $_"
    exit 1
}

# Configure environment variables
Write-Info "Configuring environment variables..."
try {
    [Environment]::SetEnvironmentVariable("ADNO_API_KEY", $ApiKey, "Machine")
    [Environment]::SetEnvironmentVariable("ADNO_API_URL", $ApiUrl, "Machine")
    Write-Success "[OK] Environment variables set"
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
Write-Info "Configuration saved to: $envFile"

# Remove existing service if it exists
$serviceName = "AdnoAgent"
$nssmPath = Join-Path $InstallDir "nssm.exe"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Info "Removing existing service..."
    try {
        & $nssmPath stop $serviceName | Out-Null
        Start-Sleep -Seconds 2
        & $nssmPath remove $serviceName confirm | Out-Null
        Start-Sleep -Seconds 2
        Write-Success "[OK] Existing service removed"
    } catch {
        Write-Warn "Warning: Could not remove existing service: $_"
    }
}

# Create Windows service using NSSM
Write-Info "Creating Windows service..."
try {
    # Install the service
    & $nssmPath install $serviceName $binaryPath | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Service installation failed with exit code $LASTEXITCODE"
    }

    # Set service description
    & $nssmPath set $serviceName Description "Background processing agent for adno workspace automation" | Out-Null

    # Set display name
    & $nssmPath set $serviceName DisplayName "adno Agent" | Out-Null

    # Set startup directory
    & $nssmPath set $serviceName AppDirectory $InstallDir | Out-Null

    # Set environment variables for the service
    & $nssmPath set $serviceName AppEnvironmentExtra "ADNO_API_KEY=$ApiKey" "ADNO_API_URL=$ApiUrl" | Out-Null

    # Configure service to start automatically
    & $nssmPath set $serviceName Start SERVICE_AUTO_START | Out-Null

    # Configure service to restart on failure
    & $nssmPath set $serviceName AppExit Default Restart | Out-Null
    & $nssmPath set $serviceName AppRestartDelay 10000 | Out-Null

    # Set output logging
    $logDir = Join-Path $InstallDir "logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    & $nssmPath set $serviceName AppStdout (Join-Path $logDir "service-output.log") | Out-Null
    & $nssmPath set $serviceName AppStderr (Join-Path $logDir "service-error.log") | Out-Null

    Write-Success "[OK] Service created"
} catch {
    Write-Fail "Failed to create service: $_"
    exit 1
}

# Start service
Write-Info "Starting service..."
try {
    Start-Service -Name $serviceName -ErrorAction Stop
    Start-Sleep -Seconds 2

    $service = Get-Service -Name $serviceName
    if ($service.Status -eq "Running") {
        Write-Success "[OK] Service started successfully"
    } else {
        throw "Service is not running (status: $($service.Status))"
    }
} catch {
    Write-Fail "Failed to start service: $_"
    Write-Info "The service was installed but could not start."
    Write-Info "Check Event Viewer for error details."
    exit 1
}

# Success!
Write-Success ""
Write-Success "================================"
Write-Success "[OK] Installation Complete!"
Write-Success "================================"
Write-Info ""
Write-Info "Service Management Commands:"
Write-Host "  Status:  " -NoNewline; Write-Host "Get-Service -Name $serviceName" -ForegroundColor Yellow
Write-Host "  Stop:    " -NoNewline; Write-Host "Stop-Service -Name $serviceName" -ForegroundColor Yellow
Write-Host "  Start:   " -NoNewline; Write-Host "Start-Service -Name $serviceName" -ForegroundColor Yellow
Write-Host "  Restart: " -NoNewline; Write-Host "Restart-Service -Name $serviceName" -ForegroundColor Yellow
Write-Info ""
Write-Info "View logs:"
Write-Host "  Get-EventLog -LogName Application -Source $serviceName -Newest 50" -ForegroundColor Yellow
Write-Info ""
Write-Info "Configuration file:"
Write-Host "  $envFile" -ForegroundColor Yellow
Write-Info ""
Write-Success "The agent is now running and will start automatically on system boot."
Write-Info "Check the adno web dashboard to verify the agent connection."
