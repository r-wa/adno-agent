# Quick Reinstall Script for Development
# Rebuilds the binary and reinstalls the service

$ErrorActionPreference = "Stop"

# Import modules
$ModulePath = Join-Path $PSScriptRoot "modules"
Import-Module (Join-Path $ModulePath "UI.psm1") -Force
Import-Module (Join-Path $ModulePath "Environment.psm1") -Force
Import-Module (Join-Path $ModulePath "Build.psm1") -Force
Import-Module (Join-Path $ModulePath "Agent.psm1") -Force

# Initialize
Set-EncodingUTF8
Show-Banner -Title "Agent Reinstall (Development)"

# Navigate to agent directory
$agentDir = Split-Path $PSScriptRoot
Set-Location $agentDir

# Load environment configuration
$envFile = Load-EnvFile -Path (Join-Path $agentDir ".env")

# Get configuration from .env
$config = @{
    ApiKey = Get-ConfigValue -Name "ADNO_API_KEY" -EnvFile $envFile -Required
    ApiUrl = Get-ConfigValue -Name "ADNO_API_URL" -EnvFile $envFile -Default "https://app.adno.dev"
}

# Additional environment variables
$additionalEnv = Get-AgentEnvironment -EnvFile $envFile

# Build TypeScript
if (!(Build-TypeScript -WorkingDirectory $agentDir)) {
    Write-Error "Build failed"
    exit 1
}

Write-Host ""

# Package executable
$binaryPath = Package-Executable -WorkingDirectory $agentDir
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