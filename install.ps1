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

# Check if running as administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Fail "Error: This script must be run as Administrator"
    Write-Info "Right-click PowerShell and select 'Run as Administrator'"
    exit 1
}

# Validate API key format
if (-not $ApiKey.StartsWith("agnt_")) {
    Write-Fail "Error: Invalid API key format (must start with 'agnt_')"
    exit 1
}

Write-Info "================================"
Write-Info "adno Agent Installer"
Write-Info "================================"
Write-Info "Version: $Version"
Write-Info "API URL: $ApiUrl"
Write-Info "Install Directory: $InstallDir"
Write-Info ""

# Determine download URL
$binaryName = "adno-agent-windows-x64.exe"
if ($Version -eq "latest") {
    $downloadUrl = "https://github.com/r-wa/adno-agent/releases/latest/download/$binaryName"
    $checksumUrl = "https://github.com/r-wa/adno-agent/releases/latest/download/$binaryName.sha256"
} else {
    $downloadUrl = "https://github.com/r-wa/adno-agent/releases/download/$Version/$binaryName"
    $checksumUrl = "https://github.com/r-wa/adno-agent/releases/download/$Version/$binaryName.sha256"
}

# Create installation directory
Write-Info "Creating installation directory..."
try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Success "✓ Directory created"
} catch {
    Write-Fail "Failed to create directory: $_"
    exit 1
}

# Download binary
$binaryPath = Join-Path $InstallDir "adno-agent.exe"
Write-Info "Downloading agent binary..."
Write-Info "URL: $downloadUrl"
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $downloadUrl -OutFile $binaryPath -UseBasicParsing
    Write-Success "✓ Binary downloaded"
} catch {
    Write-Fail "Failed to download binary: $_"
    exit 1
}

# Download and verify checksum
Write-Info "Verifying checksum..."
try {
    $expectedHash = (Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing).Content.Trim()
    $actualHash = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash

    if ($actualHash -eq $expectedHash) {
        Write-Success "✓ Checksum verified"
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

# Configure environment variables
Write-Info "Configuring environment variables..."
try {
    [Environment]::SetEnvironmentVariable("ADNO_API_KEY", $ApiKey, "Machine")
    [Environment]::SetEnvironmentVariable("ADNO_API_URL", $ApiUrl, "Machine")
    Write-Success "✓ Environment variables set"
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
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Info "Removing existing service..."
    try {
        Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        sc.exe delete $serviceName | Out-Null
        Start-Sleep -Seconds 2
        Write-Success "✓ Existing service removed"
    } catch {
        Write-Warn "Warning: Could not remove existing service: $_"
    }
}

# Create Windows service
Write-Info "Creating Windows service..."
try {
    $scResult = sc.exe create $serviceName binPath="`"$binaryPath`"" DisplayName="adno Agent" start=auto
    if ($LASTEXITCODE -ne 0) {
        throw "Service creation failed with exit code $LASTEXITCODE"
    }

    # Set service description
    sc.exe description $serviceName "Background processing agent for adno workspace automation" | Out-Null

    # Configure service to restart on failure
    sc.exe failure $serviceName reset=86400 actions=restart/10000/restart/10000/restart/10000 | Out-Null

    Write-Success "✓ Service created"
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
        Write-Success "✓ Service started successfully"
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
Write-Success "✓ Installation Complete!"
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
