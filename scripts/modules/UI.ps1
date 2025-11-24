# UI.ps1
# Display and formatting functions

# Set UTF-8 encoding for proper symbol display
function Set-EncodingUTF8 {
    $OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}

# Status messages with symbols
function Write-Status {
    param([string]$Message)
    Write-Host "$($Script:Symbols.Pending) $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "$($Script:Symbols.Success) $Message" -ForegroundColor Green
}

function Write-Error {
    param([string]$Message)
    Write-Host "$($Script:Symbols.Error) $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "$($Script:Symbols.Info) $Message" -ForegroundColor Gray
}

# Detail formatting for key-value pairs
function Write-Detail {
    param(
        [string]$Key,
        [string]$Value,
        [int]$IndentSize = 20
    )
    $padding = " " * [Math]::Max(0, $IndentSize - $Key.Length)
    Write-Host "  - ${Key}:${padding}$Value" -ForegroundColor Gray
}

# Version formatting
function Format-Version {
    param([string]$Version)
    $clean = $Version -replace '^v', ''
    if ($clean -match '^(latest|dev-)') {
        return $clean
    }
    return "v$clean"
}

# File size formatting
function Format-FileSize {
    param([long]$Bytes)
    if ($Bytes -ge 1MB) {
        return "{0:N2} MB" -f ($Bytes / 1MB)
    } elseif ($Bytes -ge 1KB) {
        return "{0:N2} KB" -f ($Bytes / 1KB)
    } else {
        return "$Bytes bytes"
    }
}

# Product banner
function Show-Banner {
    param([string]$Title = "Agent Installation")
    Write-Host ""
    Write-Host $Title -ForegroundColor White
    Write-Host ""
}

# Progress indicator for long operations
function Show-Progress {
    param(
        [string]$Activity,
        [int]$PercentComplete
    )
    Write-Progress -Activity $Activity -PercentComplete $PercentComplete
}

# Clear progress when done
function Hide-Progress {
    Write-Progress -Activity " " -Completed
}

