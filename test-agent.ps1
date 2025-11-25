# Quick test script for adno-agent development
# Usage: .\test-agent.ps1 <API_KEY> [API_URL]
#
# Example:
#   .\test-agent.ps1 "agnt_1234..." "http://localhost:3001"

param(
    [Parameter(Mandatory=$true, Position=0, HelpMessage="Your adno agent API key")]
    [string]$ApiKey,

    [Parameter(Mandatory=$true, Position=1, HelpMessage="adno API URL (e.g., http://localhost:3000)")]
    [string]$ApiUrl
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Adno Agent - Development Test" -ForegroundColor Cyan
Write-Host "-----------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "API URL: $ApiUrl" -ForegroundColor Gray
Write-Host "API Key: ${ApiKey.Substring(0,10)}..." -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

# Set environment variables
$env:ADNO_API_KEY = $ApiKey
$env:ADNO_API_URL = $ApiUrl

# Run the agent
& ".\adno-agent-windows-x64.exe"
