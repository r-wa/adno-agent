# Quick Reinstall Script for Development
# Rebuilds the binary and reinstalls the service

$ErrorActionPreference = "Stop"

# Set UTF-8 encoding
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Import modules by dot-sourcing
$ModulePath = Join-Path $PSScriptRoot "modules"
. (Join-Path $ModulePath "Constants.ps1")
. (Join-Path $ModulePath "UI.ps1")
. (Join-Path $ModulePath "Environment.ps1")
. (Join-Path $ModulePath "Build.ps1")
. (Join-Path $ModulePath "Service.ps1")
. (Join-Path $ModulePath "Agent.ps1")
Show-Banner -Title "Agent Reinstall (Development)"

# Navigate to agent directory
$agentDir = Split-Path $PSScriptRoot -Parent
Write-Host ""
Write-Host "Debug: PSScriptRoot = $PSScriptRoot" -ForegroundColor Yellow
Write-Host "Debug: agentDir = $agentDir" -ForegroundColor Yellow
Write-Host "Debug: Current Location = $(Get-Location)" -ForegroundColor Yellow
Write-Host ""

# Load environment configuration
$envFile = Import-EnvFile -Path (Join-Path $agentDir ".env")

# Get configuration from .env
$config = @{
    ApiKey = Get-ConfigValue -Name "ADNO_API_KEY" -EnvFile $envFile -Required
    ApiUrl = Get-ConfigValue -Name "ADNO_API_URL" -EnvFile $envFile -Default "https://app.adno.dev"
}

# Additional environment variables
$additionalEnv = Get-AgentEnvironment -EnvFile $envFile

# Build TypeScript
Write-Host "Debug: About to call Build-TypeScript with WorkingDirectory = $agentDir" -ForegroundColor Yellow
if (!(Build-TypeScript -WorkingDirectory $agentDir)) {
    Write-Error "Build failed"
    exit 1
}

Write-Host ""

# Package executable
$binaryPath = New-Executable -WorkingDirectory $agentDir
if (!$binaryPath) {
    Write-Error "Package failed"
    exit 1
}

Write-Host ""

# Reinstall service
$installed = Register-Agent `
    -ApiKey $config.ApiKey `
    -ApiUrl $config.ApiUrl `
    -LocalBinary $binaryPath `
    -Force `
    -AdditionalEnv $additionalEnv

if (!$installed) {
    Write-Error "Reinstallation failed"
    exit 1
}

Write-Host ""
Write-Success "Reinstall complete!"