# Cleanup Stuck Service
# Run as Administrator to remove stuck or problematic service

$ErrorActionPreference = "Stop"

# Set UTF-8 encoding
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Import modules
$ModulePath = Join-Path $PSScriptRoot "modules"
Import-Module (Join-Path $ModulePath "UI.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $ModulePath "Service.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $ModulePath "Validation.psm1") -Force -DisableNameChecking
Show-Banner -Title "Service Cleanup"

# Check if running as administrator
$prereqs = Test-Prerequisites
if (!$prereqs.AllPassed) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

# Stop service if running
Stop-ServiceSafely

# Remove service registration
$removed = Remove-Service
if (!$removed) {
    Write-Error "Failed to remove service completely"
    exit 1
}

# Wait for Windows to process the removal
Write-Status "Waiting for Windows to process removal..."
Start-Sleep -Seconds 2

# Verify service is gone
Write-Status "Verifying service removal..."
if (Test-ServiceExists) {
    Write-Error "Service still exists after removal attempt"
    Write-Info "You may need to restart Windows to complete the removal"
    exit 1
} else {
    Write-Success "Service successfully removed"
}

Write-Host ""
Write-Success "Cleanup complete!"
Write-Info "You can now run install.ps1 to reinstall the service"