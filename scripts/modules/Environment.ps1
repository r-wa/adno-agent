# Environment.ps1
# Environment variable and configuration management

Import-Module (Join-Path $PSScriptRoot "Constants.ps1") -Force -DisableNameChecking

# Import environment variables from .env file
function Import-EnvFile {
    param(
        [string]$Path = ".env",
        [switch]$OverrideExisting
    )

    if (!(Test-Path $Path)) {
        return @{}
    }

    $envVars = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and !$line.StartsWith('#')) {
            if ($line -match '^([^=]+)=(.*)$') {
                $key = $matches[1].Trim()
                $value = $matches[2].Trim()

                # Remove surrounding quotes if present
                if ($value -match '^["''](.*)["'']$') {
                    $value = $matches[1]
                }

                $envVars[$key] = $value

                # Optionally set as environment variable
                if ($OverrideExisting -or -not $env:PSBoundParameters.ContainsKey($key)) {
                    Set-Item -Path "env:$key" -Value $value
                }
            }
        }
    }

    return $envVars
}

# Get configuration value with precedence: CmdLine > EnvVar > .env > Default
function Get-ConfigValue {
    param(
        [string]$Name,
        [object]$CmdValue,
        [hashtable]$EnvFile = @{},
        [object]$Default,
        [switch]$Required
    )

    # Environment variable names are typically uppercase with underscores
    $envName = $Name.ToUpper().Replace('-', '_')

    # Check command line parameter
    if ($CmdValue) {
        return $CmdValue
    }

    # Check environment variable
    $envValue = [Environment]::GetEnvironmentVariable($envName)
    if ($envValue) {
        return $envValue
    }

    # Check .env file
    if ($EnvFile.ContainsKey($envName)) {
        return $EnvFile[$envName]
    }

    # Check defaults from Constants module
    if ($Script:Defaults.ContainsKey($Name)) {
        return $Script:Defaults[$Name]
    }

    # Use provided default
    if ($Default) {
        return $Default
    }

    # Error if required
    if ($Required) {
        throw "Required configuration value '$Name' not found in parameters, environment, or .env file"
    }

    return $null
}

# Export environment variables to .env file
function Export-EnvFile {
    param(
        [string]$Path = ".env",
        [hashtable]$Variables
    )

    $lines = @()
    $lines += "# Agent Configuration"
    $lines += "# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    $lines += ""

    foreach ($key in $Variables.Keys | Sort-Object) {
        $value = $Variables[$key]
        if ($value -match '\s') {
            $value = "`"$value`""
        }
        $lines += "$key=$value"
    }

    $lines | Set-Content -Path $Path -Encoding UTF8
}

# Merge multiple configuration sources
function Merge-Configuration {
    param(
        [hashtable]$CmdArgs = @{},
        [hashtable]$EnvFile = @{},
        [hashtable]$Defaults = @{}
    )

    $merged = @{}

    # Start with defaults
    foreach ($key in $Defaults.Keys) {
        $merged[$key] = $Defaults[$key]
    }

    # Override with .env file values
    foreach ($key in $EnvFile.Keys) {
        $merged[$key] = $EnvFile[$key]
    }

    # Override with command line arguments
    foreach ($key in $CmdArgs.Keys) {
        if ($CmdArgs[$key]) {
            $merged[$key] = $CmdArgs[$key]
        }
    }

    return $merged
}

# Get all agent-related environment variables
function Get-AgentEnvironment {
    param([hashtable]$EnvFile = @{})

    return @{
        ADNO_API_KEY            = Get-ConfigValue -Name "ADNO_API_KEY" -EnvFile $EnvFile
        ADNO_API_URL            = Get-ConfigValue -Name "ADNO_API_URL" -EnvFile $EnvFile -Default $Script:Defaults.ApiUrl
        LOG_LEVEL               = Get-ConfigValue -Name "LOG_LEVEL" -EnvFile $EnvFile -Default $Script:Defaults.LogLevel
        LOG_FORMAT              = Get-ConfigValue -Name "LOG_FORMAT" -EnvFile $EnvFile -Default $Script:Defaults.LogFormat
        POLL_INTERVAL_MS        = Get-ConfigValue -Name "POLL_INTERVAL_MS" -EnvFile $EnvFile -Default $Script:Defaults.PollIntervalMs
        HEARTBEAT_INTERVAL_MS   = Get-ConfigValue -Name "HEARTBEAT_INTERVAL_MS" -EnvFile $EnvFile -Default $Script:Defaults.HeartbeatIntervalMs
        MAX_CONCURRENT_TASKS    = Get-ConfigValue -Name "MAX_CONCURRENT_TASKS" -EnvFile $EnvFile -Default $Script:Defaults.MaxConcurrentTasks
    }
}

Export-ModuleMember -Function Import-EnvFile, Get-ConfigValue, Export-EnvFile, `
                              Merge-Configuration, Get-AgentEnvironment