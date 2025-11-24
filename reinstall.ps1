# Quick reinstall script for development
# Rebuilds the binary and reinstalls the service

$ErrorActionPreference = "Stop"

Write-Host "=== adno Agent Reinstall (Development) ===" -ForegroundColor Cyan
Write-Host ""

# Navigate to adno-agent directory
$agentDir = "c:\Users\ryanw\source\repos\adno-agent"
Set-Location $agentDir

# Build
Write-Host "[1/3] Building TypeScript..." -ForegroundColor Yellow
npm run build

# Package
Write-Host "[2/3] Creating executable..." -ForegroundColor Yellow
Remove-Item "adno-agent-windows-x64.exe" -ErrorAction SilentlyContinue
npm run package

# Install
Write-Host "[3/3] Installing service..." -ForegroundColor Yellow
$binaryPath = Join-Path $agentDir "adno-agent-windows-x64.exe"

if (!(Test-Path $binaryPath)) {
    Write-Host "ERROR: Binary not found at $binaryPath" -ForegroundColor Red
    exit 1
}

# Run install script with local binary and valid API key
.\install.ps1 -LocalBinary $binaryPath -ApiKey "agnt_051cee40387d467b1de11ef3488c9a45" -Force

Write-Host ""
Write-Host "=== Reinstall Complete ===" -ForegroundColor Green
