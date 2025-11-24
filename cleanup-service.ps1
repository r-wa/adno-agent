# Cleanup stuck AdnoAgent service
# Run this script as Administrator

Write-Host "[INFO] Attempting to clean up stuck AdnoAgent service..." -ForegroundColor Cyan

# Try to stop the service first
Write-Host "[INFO] Attempting to stop service..." -ForegroundColor Yellow
try {
    Stop-Service -Name AdnoAgent -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Service stopped" -ForegroundColor Green
} catch {
    Write-Host "[WARN] Could not stop service normally: $_" -ForegroundColor Yellow
}

# Kill any adno-agent processes
Write-Host "[INFO] Checking for adno-agent.exe processes..." -ForegroundColor Yellow
$processes = Get-Process -Name "adno-agent" -ErrorAction SilentlyContinue
if ($processes) {
    Write-Host "[INFO] Found $($processes.Count) process(es), killing..." -ForegroundColor Yellow
    $processes | Stop-Process -Force
    Write-Host "[OK] Processes killed" -ForegroundColor Green
} else {
    Write-Host "[INFO] No adno-agent.exe processes running" -ForegroundColor Gray
}

# Delete the service using sc.exe
Write-Host "[INFO] Deleting service registration..." -ForegroundColor Yellow
$result = sc.exe delete AdnoAgent 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Service deleted successfully" -ForegroundColor Green
} else {
    Write-Host "[FAIL] Failed to delete service: $result" -ForegroundColor Red
    exit 1
}

# Wait a moment for Windows to clean up
Start-Sleep -Seconds 2

# Verify service is gone
Write-Host "[INFO] Verifying service removal..." -ForegroundColor Yellow
$service = Get-Service -Name AdnoAgent -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "[FAIL] Service still exists!" -ForegroundColor Red
    exit 1
} else {
    Write-Host "[OK] Service successfully removed" -ForegroundColor Green
}

Write-Host ""
Write-Host "[SUCCESS] Cleanup complete! You can now run install.ps1 again." -ForegroundColor Green
