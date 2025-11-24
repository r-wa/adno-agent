# Quick reinstall script for development
# Rebuilds the binary and reinstalls the service

$ErrorActionPreference = "Stop"

# Set UTF-8 encoding for proper symbol display
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host ""
Write-Host "adno Agent Reinstall (Development)" -ForegroundColor White
Write-Host ""

# Navigate to adno-agent directory
$agentDir = "c:\Users\ryanw\source\repos\adno-agent"
Set-Location $agentDir

# Build
Write-Host "○ Building TypeScript..." -ForegroundColor Cyan
npm run build
Write-Host "✓ Build complete" -ForegroundColor Green
Write-Host ""

# Package
Write-Host "○ Creating executable..." -ForegroundColor Cyan
Remove-Item "adno-agent-windows-x64.exe" -ErrorAction SilentlyContinue
npm run package
Write-Host "✓ Package complete" -ForegroundColor Green
Write-Host ""

# Install
Write-Host "○ Installing service..." -ForegroundColor Cyan
$binaryPath = Join-Path $agentDir "adno-agent-windows-x64.exe"

if (!(Test-Path $binaryPath)) {
    Write-Host "⨯ Binary not found at $binaryPath" -ForegroundColor Red
    exit 1
}

# Run install script with local binary and valid API key
.\install.ps1 -LocalBinary $binaryPath -ApiKey "agnt_051cee40387d467b1de11ef3488c9a45" -Force
