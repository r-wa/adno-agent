# Agent.ps1
# Agent lifecycle management

# Test API connection
function Test-ApiConnection {
    param(
        [string]$ApiUrl,
        [string]$ApiKey,
        [int]$TimeoutSeconds = $Script:Timeouts.ApiTest
    )

    Write-Status "Testing API connection..."

    try {
        $headers = @{
            "X-API-Key" = $ApiKey
            "Content-Type" = "application/json"
        }

        $uri = "$ApiUrl/api/agent/register"
        $body = @{
            workerId = "test-connection"
            agentType = "FETCHER"
            version = "1.0.0"
            hostname = $env:COMPUTERNAME
        } | ConvertTo-Json

        $response = Invoke-RestMethod `
            -Uri $uri `
            -Method Post `
            -Headers $headers `
            -Body $body `
            -TimeoutSec $TimeoutSeconds `
            -ErrorAction Stop

        Write-Success "API connection successful"
        return $true
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -eq 401) {
            Write-Error "Invalid API key"
        } elseif ($statusCode -eq 404) {
            Write-Error "API endpoint not found - check URL"
        } else {
            Write-Error "API connection failed: $_"
        }
        return $false
    }
}

# Install agent files
function Install-AgentFiles {
    param(
        [string]$SourceBinary,
        [string]$TargetDirectory = "C:\Program Files\AdnoAgent"
    )

    Write-Status "Installing agent files..."

    # Create target directory
    if (!(Test-Path $TargetDirectory)) {
        New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
    }

    # Copy binary
    $targetBinary = Join-Path $TargetDirectory "adno-agent.exe"
    Copy-Item -Path $SourceBinary -Destination $targetBinary -Force
    Write-Detail -Key "Binary" -Value $targetBinary

    # Create tools directory and download NSSM if needed
    $toolsDir = Join-Path $TargetDirectory "tools"
    if (!(Test-Path $toolsDir)) {
        New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    }

    $nssmPath = Join-Path $toolsDir "nssm.exe"
    if (!(Test-Path $nssmPath)) {
        Install-NSSM -TargetPath $nssmPath
    }

    # Update paths in Constants
    $Script:Paths.NssmExe = $nssmPath
    $Script:Paths.AgentExe = $targetBinary

    Write-Success "Files installed"
    return $targetBinary
}

# Download and install NSSM
function Install-NSSM {
    param([string]$TargetPath)

    Write-Status "Downloading NSSM..."

    $nssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
    $tempZip = Join-Path $env:TEMP "nssm.zip"

    # Download NSSM
    Invoke-WebRequest -Uri $nssmUrl -OutFile $tempZip -UseBasicParsing

    # Extract NSSM
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tempDir = Join-Path $env:TEMP "nssm_extract"
    [System.IO.Compression.ZipFile]::ExtractToDirectory($tempZip, $tempDir)

    # Find and copy the 64-bit executable
    $nssmExe = Get-ChildItem -Path $tempDir -Filter "nssm.exe" -Recurse |
               Where-Object { $_.Directory.Name -eq "win64" } |
               Select-Object -First 1

    if ($nssmExe) {
        Copy-Item -Path $nssmExe.FullName -Destination $TargetPath -Force
        Write-Detail -Key "NSSM" -Value $TargetPath
    } else {
        throw "Failed to find NSSM executable in downloaded archive"
    }

    # Cleanup
    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Register agent (full installation flow)
function Register-Agent {
    param(
        [string]$ApiKey,
        [string]$ApiUrl,
        [string]$LocalBinary,
        [string]$Version = "latest",
        [switch]$Force,
        [hashtable]$AdditionalEnv = @{}
    )

    # Check for existing service
    if ((Test-ServiceExists) -and !$Force) {
        Write-Error "Service already exists. Use -Force to reinstall"
        return $false
    }

    # Remove existing service if Force
    if ($Force -and (Test-ServiceExists)) {
        Write-Status "Removing existing service..."
        Stop-ServiceSafely | Out-Null
        Remove-Service | Out-Null
        Start-Sleep -Seconds 2
    }

    # Install files
    $installedBinary = Install-AgentFiles -SourceBinary $LocalBinary

    # Prepare environment variables
    $environment = @{
        ADNO_API_KEY = $ApiKey
        ADNO_API_URL = $ApiUrl
    }

    # Add additional environment variables
    foreach ($key in $AdditionalEnv.Keys) {
        $environment[$key] = $AdditionalEnv[$key]
    }

    # Install service
    $installed = Install-ServiceWithNSSM `
        -BinaryPath $installedBinary `
        -Environment $environment

    if (!$installed) {
        Write-Error "Failed to install service"
        return $false
    }

    # Configure logging
    Set-ServiceLogging | Out-Null

    # Start service
    $started = Start-ServiceManaged
    if (!$started) {
        Write-Error "Service installed but failed to start"
        return $false
    }

    # Verify installation
    return Verify-Installation -ApiUrl $ApiUrl -ApiKey $ApiKey
}

# Verify agent installation
function Verify-Installation {
    param(
        [string]$ApiUrl,
        [string]$ApiKey
    )

    Write-Status "Verifying installation..."

    # Check service status
    $status = Get-ServiceStatus
    if ($status -ne "Running") {
        Write-Error "Service is not running (status: $status)"
        return $false
    }

    # Wait a moment for agent to register
    Start-Sleep -Seconds 2

    # Test API connection
    $connected = Test-ApiConnection -ApiUrl $ApiUrl -ApiKey $ApiKey
    if (!$connected) {
        Write-Info "Agent is running but API connection failed"
        Write-Info "Check logs at: $($Script:Paths.LogDir)"
        return $true  # Service is running, which is success even if API is down
    }

    Write-Success "Agent verified and connected"
    return $true
}

# Uninstall agent completely
function Uninstall-Agent {
    param([switch]$RemoveFiles)

    Write-Status "Uninstalling agent..."

    # Stop and remove service
    Stop-ServiceSafely | Out-Null
    Remove-Service | Out-Null

    if ($RemoveFiles) {
        Write-Status "Removing installation files..."
        $installDir = Split-Path $Script:Paths.AgentExe -Parent
        if (Test-Path $installDir) {
            Remove-Item $installDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-Success "Files removed"
        }
    }

    Write-Success "Agent uninstalled"
    return $true
}

