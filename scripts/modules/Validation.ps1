# Validation.ps1
# Input validation and prerequisites checking

# Validate API key format
function Test-ApiKey {
    param([string]$ApiKey)

    if ([string]::IsNullOrWhiteSpace($ApiKey)) {
        return @{
            Valid = $false
            Message = "API key is required"
        }
    }

    # Check format (agnt_ prefix)
    if (!($ApiKey -match '^agnt_[a-f0-9]{32}$')) {
        return @{
            Valid = $false
            Message = "Invalid API key format (expected: agnt_xxxxx...)"
        }
    }

    return @{
        Valid = $true
        Message = "Valid format"
    }
}

# Validate API URL
function Test-ApiUrl {
    param([string]$ApiUrl)

    if ([string]::IsNullOrWhiteSpace($ApiUrl)) {
        return @{
            Valid = $false
            Message = "API URL is required"
        }
    }

    # Check URL format
    try {
        $uri = [System.Uri]::new($ApiUrl)
        if ($uri.Scheme -ne "http" -and $uri.Scheme -ne "https") {
            return @{
                Valid = $false
                Message = "URL must use http or https protocol"
            }
        }
    } catch {
        return @{
            Valid = $false
            Message = "Invalid URL format"
        }
    }

    return @{
        Valid = $true
        Message = "Valid URL"
    }
}

# Check prerequisites
function Test-Prerequisites {
    param([switch]$Detailed)

    $results = @{
        AllPassed = $true
        Checks = @()
    }

    # Check if running as admin
    $isAdmin = ([Security.Principal.WindowsPrincipal] `
                [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
                [Security.Principal.WindowsBuiltInRole]::Administrator)

    $results.Checks += @{
        Name = "Administrator privileges"
        Passed = $isAdmin
        Message = if ($isAdmin) { "Running as administrator" } else { "Not running as administrator" }
    }

    if (!$isAdmin) {
        $results.AllPassed = $false
    }

    # Check Node.js
    $nodeVersion = $null
    try {
        $nodeVersion = node --version 2>$null
        $hasNode = $LASTEXITCODE -eq 0 -and $nodeVersion
    } catch {
        $hasNode = $false
    }

    $results.Checks += @{
        Name = "Node.js"
        Passed = $hasNode
        Message = if ($hasNode) { "Node.js $nodeVersion installed" } else { "Node.js not found" }
    }

    # Check npm
    $npmVersion = $null
    try {
        $npmVersion = npm --version 2>$null
        $hasNpm = $LASTEXITCODE -eq 0 -and $npmVersion
    } catch {
        $hasNpm = $false
    }

    $results.Checks += @{
        Name = "npm"
        Passed = $hasNpm
        Message = if ($hasNpm) { "npm $npmVersion installed" } else { "npm not found" }
    }

    # Check Windows version
    $osVersion = [System.Environment]::OSVersion.Version
    $isSupported = $osVersion.Major -ge 10 -or ($osVersion.Major -eq 6 -and $osVersion.Minor -ge 1)

    $results.Checks += @{
        Name = "Windows version"
        Passed = $isSupported
        Message = "Windows $($osVersion.Major).$($osVersion.Minor)"
    }

    if (!$isSupported) {
        $results.AllPassed = $false
    }

    # Display results if detailed
    if ($Detailed) {
        Write-Status "Checking prerequisites..."
        foreach ($check in $results.Checks) {
            if ($check.Passed) {
                Write-Success "$($check.Name): $($check.Message)"
            } else {
                Write-Error "$($check.Name): $($check.Message)"
            }
        }
    }

    return $results
}

# Confirm user action
function Confirm-UserAction {
    param(
        [string]$Message,
        [switch]$DefaultYes
    )

    $choices = @(
        [System.Management.Automation.Host.ChoiceDescription]::new("&Yes", "Proceed with the action")
        [System.Management.Automation.Host.ChoiceDescription]::new("&No", "Cancel the action")
    )

    $default = if ($DefaultYes) { 0 } else { 1 }
    $result = $host.UI.PromptForChoice("", $Message, $choices, $default)

    return $result -eq 0
}

# Validate file path
function Test-FilePath {
    param(
        [string]$Path,
        [switch]$MustExist,
        [switch]$IsDirectory
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return @{
            Valid = $false
            Message = "Path is empty"
        }
    }

    $exists = Test-Path $Path

    if ($MustExist -and !$exists) {
        return @{
            Valid = $false
            Message = "Path does not exist: $Path"
        }
    }

    if ($exists) {
        $item = Get-Item $Path
        if ($IsDirectory -and !$item.PSIsContainer) {
            return @{
                Valid = $false
                Message = "Path is not a directory: $Path"
            }
        } elseif (!$IsDirectory -and $item.PSIsContainer) {
            return @{
                Valid = $false
                Message = "Path is a directory, expected file: $Path"
            }
        }
    }

    return @{
        Valid = $true
        Message = "Valid path"
    }
}

# Validate port number
function Test-Port {
    param([int]$Port)

    if ($Port -lt 1 -or $Port -gt 65535) {
        return @{
            Valid = $false
            Message = "Port must be between 1 and 65535"
        }
    }

    # Check if port is in use
    $tcpListener = $null
    try {
        $tcpListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)
        $tcpListener.Start()
        $inUse = $false
    } catch {
        $inUse = $true
    } finally {
        if ($tcpListener) {
            $tcpListener.Stop()
        }
    }

    if ($inUse) {
        return @{
            Valid = $false
            Message = "Port $Port is already in use"
        }
    }

    return @{
        Valid = $true
        Message = "Port available"
    }
}

# Validate all inputs
function Test-AllInputs {
    param(
        [string]$ApiKey,
        [string]$ApiUrl,
        [string]$BinaryPath
    )

    $allValid = $true
    $messages = @()

    # Validate API key
    $keyResult = Test-ApiKey -ApiKey $ApiKey
    if (!$keyResult.Valid) {
        $allValid = $false
        $messages += "API Key: $($keyResult.Message)"
    }

    # Validate API URL
    $urlResult = Test-ApiUrl -ApiUrl $ApiUrl
    if (!$urlResult.Valid) {
        $allValid = $false
        $messages += "API URL: $($urlResult.Message)"
    }

    # Validate binary path if provided
    if ($BinaryPath) {
        $pathResult = Test-FilePath -Path $BinaryPath -MustExist
        if (!$pathResult.Valid) {
            $allValid = $false
            $messages += "Binary: $($pathResult.Message)"
        }
    }

    return @{
        Valid = $allValid
        Messages = $messages
    }
}

