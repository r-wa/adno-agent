# Service.ps1
# Windows service management operations

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

        # Force stop processes if normal stop fails
        Stop-ServiceProcess -ServiceName $ServiceName -Force
        return $false
    }
}

# Stop service processes forcefully
function Stop-ServiceProcess {
    param(
        [string]$ServiceName = $Script:ServiceConfig.Name,
        [switch]$Force
    )

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

    # Clear any existing environment variables (important for reinstalls)
    & $Script:Paths.NssmExe reset $ServiceName AppEnvironmentExtra 2>&1 | Out-Null

    # Configure restart behavior
    & $Script:Paths.NssmExe set $ServiceName AppRestartDelay 1000 | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppExit Default Restart | Out-Null

    # Disable PAUSE/RESUME controls (not compatible with Node.js)
    & $Script:Paths.NssmExe set $ServiceName AppStopMethodSkip 14 | Out-Null

    # Set environment variables (NSSM requires + prefix to append, not overwrite)
    $isFirst = $true
    foreach ($key in $Environment.Keys) {
        if ($Environment[$key]) {
            if ($isFirst) {
                # First var: set without + prefix
                & $Script:Paths.NssmExe set $ServiceName AppEnvironmentExtra "${key}=$($Environment[$key])" | Out-Null
                $isFirst = $false
            } else {
                # Subsequent vars: use + prefix to append
                & $Script:Paths.NssmExe set $ServiceName AppEnvironmentExtra "+${key}=$($Environment[$key])" | Out-Null
            }
        }
    }

    Write-Success "Service installed"
    return $true
}

# Configure service logging
# NSSM logs go to logs/nssm/, Pino app logs go to logs/app/ (handled by logger.ts)
function Set-ServiceLogging {
    param(
        [string]$ServiceName = $Script:ServiceConfig.Name,
        [string]$LogDirectory = $Script:Paths.LogDir
    )

    if (!(Test-Path $Script:Paths.NssmExe)) {
        return $false
    }

    # Use nssm subdirectory for NSSM service logs
    $nssmLogDir = Join-Path $LogDirectory "nssm"

    # Create log directories
    if (!(Test-Path $nssmLogDir)) {
        New-Item -ItemType Directory -Path $nssmLogDir -Force | Out-Null
    }

    # Also ensure app log directory exists (for Pino logs)
    $appLogDir = Join-Path $LogDirectory "app"
    if (!(Test-Path $appLogDir)) {
        New-Item -ItemType Directory -Path $appLogDir -Force | Out-Null
    }

    # Configure stdout and stderr redirection to nssm subdirectory
    $stdoutLog = Join-Path $nssmLogDir "service.log"
    $stderrLog = Join-Path $nssmLogDir "service-error.log"

    & $Script:Paths.NssmExe set $ServiceName AppStdout $stdoutLog | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppStderr $stderrLog | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppRotateFiles 1 | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppRotateOnline 1 | Out-Null
    & $Script:Paths.NssmExe set $ServiceName AppRotateBytes 10485760 | Out-Null  # 10MB

    Write-Detail -Key "NSSM logs" -Value $nssmLogDir
    Write-Detail -Key "App logs" -Value $appLogDir
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
        # Start service (suppress default PowerShell warnings)
        Start-Service -Name $ServiceName -ErrorAction Stop -WarningAction SilentlyContinue

        # Custom wait loop with our warning style
        $service = Get-Service -Name $ServiceName
        $startTime = Get-Date
        $timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
        $warningShown = $false

        while ($service.Status -ne 'Running') {
            $elapsed = (Get-Date) - $startTime
            if ($elapsed -ge $timeout) {
                throw "Service did not start within $TimeoutSeconds seconds"
            }

            # Show warning after 2 seconds of waiting
            if (!$warningShown -and $elapsed.TotalSeconds -ge 2) {
                Write-Warning "Waiting for service to start..."
                $warningShown = $true
            }

            Start-Sleep -Milliseconds 500
            $service.Refresh()
        }

        Write-Success "Service started"

        # Check for startup errors in log files (now in nssm subdirectory)
        Start-Sleep -Seconds 2
        $nssmLogDir = Join-Path $Script:Paths.LogDir "nssm"
        $errorLogFile = Join-Path $nssmLogDir "service-error.log"
        $mainLogFile = Join-Path $nssmLogDir "service.log"

        if ((Test-Path $errorLogFile) -and (Get-Item $errorLogFile).Length -gt 0) {
            Write-Warning "Errors detected in service-error.log:"
            Get-Content $errorLogFile -Tail 5 | ForEach-Object {
                Write-Info "  $_"
            }
        }

        if ((Test-Path $mainLogFile) -and (Get-Item $mainLogFile).Length -eq 0) {
            Write-Warning "service.log is empty - service may have failed silently"
        }

        return $true
    } catch {
        Write-Error "Failed to start service: $_"

        # Show log file contents on failure for debugging
        $nssmLogDir = Join-Path $Script:Paths.LogDir "nssm"
        $errorLogFile = Join-Path $nssmLogDir "service-error.log"
        if ((Test-Path $errorLogFile) -and (Get-Item $errorLogFile).Length -gt 0) {
            Write-Info "Error log contents:"
            Get-Content $errorLogFile -Tail 10 | ForEach-Object {
                Write-Info "  $_"
            }
        }

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

