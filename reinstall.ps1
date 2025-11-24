# Quick reinstall script for development
# Rebuilds the binary and reinstalls the service

$ErrorActionPreference = "Stop"

# Set UTF-8 encoding for proper symbol display
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Define symbols using Unicode code points
$SymbolPending = [char]0x25CB    # ○
$SymbolSuccess = [char]0x2713    # ✓
$SymbolError = [char]0x2A2F      # ⨯

Write-Host ""
Write-Host "adno Agent Reinstall (Development)" -ForegroundColor White
Write-Host ""

# Navigate to adno-agent directory
$agentDir = "c:\Users\ryanw\source\repos\adno-agent"
Set-Location $agentDir

# Load .env file for default values
function Load-EnvFile {
    param([string]$Path)

    if (!(Test-Path $Path)) {
        return @{}
    }

    $env = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and !$line.StartsWith('#')) {
            if ($line -match '^([^=]+)=(.*)$') {
                $key = $matches[1].Trim()
                $value = $matches[2].Trim()
                $env[$key] = $value
            }
        }
    }
    return $env
}

$envVars = Load-EnvFile (Join-Path $agentDir ".env")
$apiKey = if ($envVars['ADNO_API_KEY']) { $envVars['ADNO_API_KEY'] } else { Read-Host "Enter API key" }
$apiUrl = if ($envVars['ADNO_API_URL']) { $envVars['ADNO_API_URL'] } else { "https://app.adno.dev" }

# Build
Write-Host "$SymbolPending Building TypeScript..." -ForegroundColor Cyan
npm run build
Write-Host "$SymbolSuccess Build complete" -ForegroundColor Green
Write-Host ""

# Package
Write-Host "$SymbolPending Creating executable..." -ForegroundColor Cyan
Remove-Item "adno-agent-windows-x64.exe" -ErrorAction SilentlyContinue
npm run package
Write-Host "$SymbolSuccess Package complete" -ForegroundColor Green
Write-Host ""

# Install
Write-Host "$SymbolPending Installing service..." -ForegroundColor Cyan
$binaryPath = Join-Path $agentDir "adno-agent-windows-x64.exe"

if (!(Test-Path $binaryPath)) {
    Write-Host "$SymbolError Binary not found at $binaryPath" -ForegroundColor Red
    exit 1
}

# Run install script with values from .env
.\install.ps1 -LocalBinary $binaryPath -ApiKey $apiKey -ApiUrl $apiUrl -Force
