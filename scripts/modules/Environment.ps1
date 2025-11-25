# Environment.ps1
# Environment variable and configuration management

# Import environment variables from .env file
function Import-EnvFile {
    param(
        [string]$Path = ".env",
        [switch]$OverrideExisting
    )

    # Return empty hashtable if path is null or empty
    if ([string]::IsNullOrWhiteSpace($Path)) {
        Write-Warning "No .env path specified"
        return @{}
    }

    # Return empty hashtable if file doesn't exist
    if (!(Test-Path $Path -ErrorAction SilentlyContinue)) {
        Write-Warning ".env file not found at: $Path"
        return @{}
    }

    $envVars = @{}

    try {
        # Read file content
        $content = Get-Content $Path -ErrorAction Stop
        if (-not $content) {
            Write-Warning ".env file is empty: $Path"
            return @{}
        }

        # Ensure content is an array
        $lines = @($content)

        foreach ($rawLine in $lines) {
            if (-not $rawLine) { continue }

            $line = "$rawLine".Trim()
            if (-not $line) { continue }
            if ($line[0] -eq '#') { continue }

            $eqIndex = $line.IndexOf('=')
            if ($eqIndex -gt 0) {
                $key = $line.Substring(0, $eqIndex).Trim()
                $value = $line.Substring($eqIndex + 1).Trim()

                # Remove surrounding quotes if present
                if ($value.Length -ge 2) {
                    $firstChar = $value[0]
                    $lastChar = $value[$value.Length - 1]
                    if (($firstChar -eq '"' -or $firstChar -eq "'") -and $firstChar -eq $lastChar) {
                        $value = $value.Substring(1, $value.Length - 2)
                    }
                }

                $envVars[$key] = $value
            }
        }
    } catch {
        Write-Error "Failed to read .env file at line: $rawLine - Error: $_"
        return @{}
    }

    return $envVars
}

# Get configuration value with precedence: CmdLine > .env > EnvVar > Default
# Note: .env takes priority over system env vars for development workflows
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

    # Check command line parameter (highest priority)
    if ($CmdValue) {
        return $CmdValue
    }

    # Check .env file (takes priority over system env vars)
    if ($EnvFile.ContainsKey($envName)) {
        return $EnvFile[$envName]
    }

    # Check system environment variable
    $envValue = [Environment]::GetEnvironmentVariable($envName)
    if ($envValue) {
        return $envValue
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

# Get the source of a configuration value for diagnostics
function Get-ConfigSource {
    param(
        [string]$Name,
        [object]$CmdValue,
        [hashtable]$EnvFile = @{}
    )

    $envName = $Name.ToUpper().Replace('-', '_')

    if ($CmdValue) {
        return "parameter"
    }

    if ($EnvFile.ContainsKey($envName)) {
        return ".env"
    }

    $envValue = [Environment]::GetEnvironmentVariable($envName)
    if ($envValue) {
        return "system env"
    }

    if ($Script:Defaults.ContainsKey($Name)) {
        return "default"
    }

    return "not set"
}

# Show configuration with sources for debugging
function Show-Configuration {
    param(
        [hashtable]$EnvFile = @{},
        [hashtable]$Config = @{}
    )

    Write-Status "Configuration"

    # Show key configuration values with their sources
    $apiUrl = Get-ConfigValue -Name "ADNO_API_URL" -EnvFile $EnvFile
    $apiUrlSource = Get-ConfigSource -Name "ADNO_API_URL" -EnvFile $EnvFile

    $apiKey = Get-ConfigValue -Name "ADNO_API_KEY" -EnvFile $EnvFile
    $apiKeySource = Get-ConfigSource -Name "ADNO_API_KEY" -EnvFile $EnvFile
    $apiKeyDisplay = if ($apiKey) { $apiKey.Substring(0, [Math]::Min(12, $apiKey.Length)) + "..." } else { "(not set)" }

    Write-Detail -Key "API URL" -Value "$apiUrl ($apiUrlSource)"
    Write-Detail -Key "API Key" -Value "$apiKeyDisplay ($apiKeySource)"

    # Check for potential conflicts (system env var differs from .env)
    $systemApiUrl = [Environment]::GetEnvironmentVariable("ADNO_API_URL")
    if ($systemApiUrl -and $EnvFile.ContainsKey("ADNO_API_URL") -and $systemApiUrl -ne $EnvFile["ADNO_API_URL"]) {
        Write-Warning "System env ADNO_API_URL='$systemApiUrl' differs from .env (using .env)"
    }
}

