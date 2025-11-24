# Service.psm1
# Windows service management operations

Import-Module (Join-Path $PSScriptRoot "Constants.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "UI.psm1") -Force

# Check if service exists
function Test-ServiceExists {
    param([string]$ServiceName = $Script:ServiceConfig.Name)

    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    return $null -ne $service
}

# Get service status
function Get-ServiceStatus {
    param([string]$ServiceName = $Script:ServiceConfig.Name)

    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service) {
        return $service.Status
    }
    return "NotFound"
}

# Stop service safely
function Stop-ServiceSafely {
    param(
        [string]$ServiceName = $Script:ServiceConfig.Name,
        [int]$TimeoutSeconds = $Script:Timeouts.ServiceStop
    )

    Write-Status "Stopping service..."

    try {
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (!$service) {
            Write-Info "Service not found"
            return $true
        }

        if ($service.Status -eq 'Stopped') {
            Write-Info "Service already stopped"
            return $true
        }

        Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($TimeoutSeconds))
        Write-Success "Service stopped"
        return $true
    } catch {
        Write-Error "Failed to stop service: $_"

        # Force kill processes if normal stop fails
        Kill-ServiceProcesses -ServiceName $ServiceName
        return $false
    }
}

# Kill service processes forcefully
function Kill-ServiceProcesses {
    param([string]$ServiceName = $Script:ServiceConfig.Name)

    Write-Status "Checking for running processes..."

    $processName = "adno-agent"
    $processes = Get-Process -Name $processName -ErrorAction SilentlyContinue

    if ($processes) {
        Write-Status "Found $($processes.Count) process(es), terminating..."
        $processes | Stop-Process -Force
        Write-Success "Processes terminated"
    } else {
        Write-Info "No processes running"
    }
}

# Remove service using NSSM or sc.exe
function Remove-Service {
    param([string]$ServiceName = $Script:ServiceConfig.Name)

    Write-Status "Removing service registration..."

    # Try NSSM first if available
    if (Test-Path $Script:Paths.NssmExe) {
        $result = & $Script:Paths.NssmExe remove $ServiceName confirm 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Service removed via NSSM"
            return $true
        }
    }

    # Fallback to sc.exe
    $result = sc.exe delete $ServiceName 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Service removed"
        return $true
    } elseif ($result -match "MARKED_FOR_DELETE") {
        Write-Info "Service marked for deletion (will be removed after reboot)"
        return $true
    } else {
        Write-Error "Failed to remove service: $result"
        return $false
    }
}

# Install service using NSSM
function Install-ServiceWithNSSM {
    param(
        [string]$ServiceName = $Script:ServiceConfig.Name,
        [string]$BinaryPath,
        [string]$DisplayName = $Script:ServiceConfig.DisplayName,
        [string]$Description = $Script:ServiceConfig.Description,
        [hashtable]$Environment = @{}
    )

    if (!(Test-Path $Script:Paths.NssmExe)) {
        throw "NSSM not found at $($Script:Paths.NssmExe)"
    }

    if (!(Test-Path $BinaryPath)) {
        throw "Binary not found at $BinaryPath"
    }

    Write-Status "Installing Windows service..."

    # Install the service
    & $Script:Paths.NssmExe install $ServiceName $BinaryPath
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install service"
    }

    # Configure service properties
    & $Script:Paths.NssmExe set $ServiceName DisplayName $DisplayName | Out-Null
    & $Script:Paths.NssmExe set $ServiceName Description $Description | Out-Null

    # Set startup type
    & $Script:Paths.NssmExe set $ServiceName Start SERVICE_AUTO_START | Out-Null

    # Configure restart behavior
    & $Script:Paths.NssmExe set $ServiceName AppRestartDelay 1000 | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppExit Default Restart | Out-Null

    # Disable PAUSE/RESUME controls (not compatible with Node.js)
    & $Script:Paths.NssmExe set $ServiceName AppStopMethodSkip 14 | Out-Null

    # Set environment variables
    foreach ($key in $Environment.Keys) {
        if ($Environment[$key]) {
            & $Script:Paths.NssmExe set $ServiceName AppEnvironmentExtra "${key}=$($Environment[$key])" | Out-Null
        }
    }

    Write-Success "Service installed"
    return $true
}

# Configure service logging
function Set-ServiceLogging {
    param(
        [string]$ServiceName = $Script:ServiceConfig.Name,
        [string]$LogDirectory = $Script:Paths.LogDir
    )

    if (!(Test-Path $Script:Paths.NssmExe)) {
        return $false
    }

    # Create log directory
    if (!(Test-Path $LogDirectory)) {
        New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    }

    # Configure stdout and stderr redirection
    $stdoutLog = Join-Path $LogDirectory "agent.log"
    $stderrLog = Join-Path $LogDirectory "agent-error.log"

    & $Script:Paths.NssmExe set $ServiceName AppStdout $stdoutLog | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppStderr $stderrLog | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppRotateFiles 1 | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppRotateOnline 1 | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppRotateBytes 10485760 | Out-Null  # 10MB

    Write-Detail -Key "Log directory" -Value $LogDirectory
    return $true
}

# Start service
function Start-ServiceManaged {
    param(
        [string]$ServiceName = $Script:ServiceConfig.Name,
        [int]$TimeoutSeconds = $Script:Timeouts.ServiceStart
    )

    Write-Status "Starting service..."

    try {
        Start-Service -Name $ServiceName -ErrorAction Stop

        # Wait for service to start
        $service = Get-Service -Name $ServiceName
        $service.WaitForStatus('Running', [TimeSpan]::FromSeconds($TimeoutSeconds))

        Write-Success "Service started"
        return $true
    } catch {
        Write-Error "Failed to start service: $_"
        return $false
    }
}

# Wait for service state change
function Wait-ForServiceState {
    param(
        [string]$ServiceName = $Script:ServiceConfig.Name,
        [string]$DesiredState = "Running",
        [int]$TimeoutSeconds = $Script:Timeouts.ServiceStart
    )

    $startTime = Get-Date
    $timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)

    while ((Get-Date) - $startTime -lt $timeout) {
        $status = Get-ServiceStatus -ServiceName $ServiceName
        if ($status -eq $DesiredState) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    }

    return $false
}

Export-ModuleMember -Function Test-ServiceExists, Get-ServiceStatus, Stop-ServiceSafely, `
                              Kill-ServiceProcesses, Remove-Service, Install-ServiceWithNSSM, `
                              Set-ServiceLogging, Start-ServiceManaged, Wait-ForServiceState