# Agent Installation Script
# Installs the agent as a Windows service

param(
    [string]$ApiKey,
    [string]$ApiUrl,
    [string]$LocalBinary,
    [string]$Version = "latest",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Set UTF-8 encoding
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Import modules
$ModulePath = Join-Path $PSScriptRoot "modules"
Import-Module (Join-Path $ModulePath "Constants.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $ModulePath "UI.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $ModulePath "Environment.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $ModulePath "Validation.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $ModulePath "Build.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $ModulePath "Agent.psm1") -Force -DisableNameChecking
Show-Banner -Title "Agent Installation"

# Load environment configuration
$envFile = Import-EnvFile -Path (Join-Path (Split-Path $PSScriptRoot) ".env")

# Get configuration values with precedence
$config = @{
    ApiKey = Get-ConfigValue -Name "ADNO_API_KEY" -CmdValue $ApiKey -EnvFile $envFile
    ApiUrl = Get-ConfigValue -Name "ADNO_API_URL" -CmdValue $ApiUrl -EnvFile $envFile -Default "https://app.adno.dev"
}

# Additional environment variables
$additionalEnv = @{
    LOG_LEVEL             = Get-ConfigValue -Name "LOG_LEVEL" -EnvFile $envFile -Default "info"
    LOG_FORMAT            = Get-ConfigValue -Name "LOG_FORMAT" -EnvFile $envFile -Default "json"
    POLL_INTERVAL_MS      = Get-ConfigValue -Name "POLL_INTERVAL_MS" -EnvFile $envFile -Default 30000
    HEARTBEAT_INTERVAL_MS = Get-ConfigValue -Name "HEARTBEAT_INTERVAL_MS" -EnvFile $envFile -Default 60000
    MAX_CONCURRENT_TASKS  = Get-ConfigValue -Name "MAX_CONCURRENT_TASKS" -EnvFile $envFile -Default 3
}

# Check prerequisites
$prereqs = Test-Prerequisites -Detailed
if (!$prereqs.AllPassed) {
    Write-Error "Prerequisites check failed. Please address the issues above."
    exit 1
}

# Prompt for missing values
if (!$config.ApiKey) {
    Write-Host ""
    $config.ApiKey = Read-Host "Enter your API key"
}

if (!$config.ApiUrl) {
    Write-Host ""
    $config.ApiUrl = Read-Host "Enter API URL (or press Enter for default)"
    if (!$config.ApiUrl) {
        $config.ApiUrl = "https://app.adno.dev"
    }
}

# Validate inputs
$validation = Test-AllInputs -ApiKey $config.ApiKey -ApiUrl $config.ApiUrl -BinaryPath $LocalBinary
if (!$validation.Valid) {
    Write-Host ""
    Write-Error "Validation failed:"
    $validation.Messages | ForEach-Object { Write-Error "  $_" }
    exit 1
}

# Get or download binary
Write-Host ""
if ($LocalBinary) {
    Write-Status "Using local binary..."
    Write-Detail -Key "Binary" -Value $LocalBinary
    $binaryPath = $LocalBinary
} else {
    # Download latest release
    $release = Get-LatestRelease
    if (!$release) {
        Write-Error "Failed to get latest release information"
        exit 1
    }

    $tempBinary = Join-Path $env:TEMP "adno-agent.exe"
    $downloaded = Receive-Binary `
        -Url $release.DownloadUrl `
        -OutputPath $tempBinary `
        -ExpectedSize $release.Size

    if (!$downloaded) {
        Write-Error "Failed to download agent binary"
        exit 1
    }

    $binaryPath = $tempBinary
}

# Install agent
Write-Host ""
$installed = Register-Agent `
    -ApiKey $config.ApiKey `
    -ApiUrl $config.ApiUrl `
    -LocalBinary $binaryPath `
    -Version $Version `
    -Force:$Force `
    -AdditionalEnv $additionalEnv

if (!$installed) {
    Write-Error "Installation failed"
    exit 1
}

# Display completion
Write-Host ""
Write-Success "Installation complete!"
Write-Host ""
Write-Detail -Key "Service" -Value "AdnoAgent"
Write-Detail -Key "Status" -Value "Running"
Write-Detail -Key "Logs" -Value "C:\ProgramData\AdnoAgent\logs"
Write-Host ""

# Cleanup temp files
if ($tempBinary -and (Test-Path $tempBinary)) {
    Remove-Item $tempBinary -Force -ErrorAction SilentlyContinue
}