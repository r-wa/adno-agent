# Clear stale Machine-level environment variables
# Run this script as Administrator

Write-Host "Clearing Machine-level ADNO environment variables..." -ForegroundColor Cyan

[Environment]::SetEnvironmentVariable('ADNO_API_URL', $null, 'Machine')
[Environment]::SetEnvironmentVariable('ADNO_API_KEY', $null, 'Machine')

Write-Host "Done. Restart your terminal for changes to take effect." -ForegroundColor Green
