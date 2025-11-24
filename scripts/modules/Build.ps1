# Build.ps1
# Build and packaging operations

Import-Module (Join-Path $PSScriptRoot "Constants.ps1") -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot "UI.ps1") -Force -DisableNameChecking

# Build TypeScript project
function Build-TypeScript {
    param([string]$WorkingDirectory = (Get-Location))

    Write-Status "Building TypeScript..."

    Push-Location $WorkingDirectory
    try {
        # Check if package.json exists
        if (!(Test-Path "package.json")) {
            throw "package.json not found in $WorkingDirectory"
        }

        # Run npm build
        $result = npm run build 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Build failed: $result"
        }

        Write-Success "Build complete"
        return $true
    } catch {
        Write-Error $_
        return $false
    } finally {
        Pop-Location
    }
}

# Create executable package
function New-Executable {
    param(
        [string]$WorkingDirectory = (Get-Location),
        [string]$OutputName = "adno-agent-windows-x64.exe"
    )

    Write-Status "Creating executable..."

    Push-Location $WorkingDirectory
    try {
        # Remove existing executable
        if (Test-Path $OutputName) {
            Remove-Item $OutputName -Force
        }

        # Run npm package
        $result = npm run package 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Package failed: $result"
        }

        # Verify output exists
        if (!(Test-Path $OutputName)) {
            throw "Expected output file not created: $OutputName"
        }

        $fullPath = (Get-Item $OutputName).FullName
        $size = (Get-Item $OutputName).Length
        Write-Detail -Key "Executable" -Value "$fullPath ($(Format-FileSize $size))"
        Write-Success "Package complete"

        return $fullPath
    } catch {
        Write-Error $_
        return $null
    } finally {
        Pop-Location
    }
}

# Get latest release from GitHub
function Get-LatestRelease {
    param(
        [string]$Owner = $Script:GitHub.Owner,
        [string]$Repo = $Script:GitHub.Repo,
        [string]$AssetName = $Script:GitHub.AssetName
    )

    Write-Status "Fetching latest release info..."

    try {
        $uri = "$($Script:GitHub.ApiUrl)/repos/$Owner/$Repo/releases/latest"
        $release = Invoke-RestMethod -Uri $uri -ErrorAction Stop

        # Find the Windows x64 asset
        $asset = $release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1

        if (!$asset) {
            throw "Asset '$AssetName' not found in latest release"
        }

        $info = @{
            Version = $release.tag_name
            DownloadUrl = $asset.browser_download_url
            Size = $asset.size
            Published = $release.published_at
        }

        Write-Detail -Key "Version" -Value (Format-Version $info.Version)
        Write-Detail -Key "Size" -Value (Format-FileSize $info.Size)

        return $info
    } catch {
        Write-Error "Failed to get release info: $_"
        return $null
    }
}

# Receive binary from URL
function Receive-Binary {
    param(
        [string]$Url,
        [string]$OutputPath,
        [long]$ExpectedSize = 0
    )

    Write-Status "Downloading agent binary..."

    try {
        # Create temp file
        $tempFile = [System.IO.Path]::GetTempFileName()

        # Download with progress
        $webClient = New-Object System.Net.WebClient
        $webClient.DownloadFileTaskAsync($Url, $tempFile).Wait()

        # Verify size if provided
        if ($ExpectedSize -gt 0) {
            $actualSize = (Get-Item $tempFile).Length
            if ($actualSize -ne $ExpectedSize) {
                throw "Download size mismatch. Expected: $ExpectedSize, Actual: $actualSize"
            }
        }

        # Move to final location
        Move-Item -Path $tempFile -Destination $OutputPath -Force

        Write-Success "Download complete"
        return $true
    } catch {
        Write-Error "Download failed: $_"
        return $false
    } finally {
        # Cleanup temp file
        if ($tempFile -and (Test-Path $tempFile)) {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# Build from source
function Build-FromSource {
    param([string]$SourceDirectory)

    Write-Status "Building from source..."

    Push-Location $SourceDirectory
    try {
        # Install dependencies
        Write-Status "Installing dependencies..."
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install dependencies"
        }

        # Build
        if (!(Build-TypeScript -WorkingDirectory $SourceDirectory)) {
            throw "Build failed"
        }

        # Package
        $executable = New-Executable -WorkingDirectory $SourceDirectory
        if (!$executable) {
            throw "Package failed"
        }

        return $executable
    } catch {
        Write-Error $_
        return $null
    } finally {
        Pop-Location
    }
}

# Clear build artifacts
function Clear-BuildArtifacts {
    param([string]$WorkingDirectory = (Get-Location))

    Write-Status "Cleaning build artifacts..."

    Push-Location $WorkingDirectory
    try {
        # Remove common build directories
        @("dist", "build", "out", ".next") | ForEach-Object {
            if (Test-Path $_) {
                Remove-Item $_ -Recurse -Force
                Write-Detail -Key "Removed" -Value $_
            }
        }

        # Remove executables
        Get-ChildItem -Filter "*.exe" | ForEach-Object {
            Remove-Item $_.FullName -Force
            Write-Detail -Key "Removed" -Value $_.Name
        }

        Write-Success "Clean complete"
        return $true
    } catch {
        Write-Error "Clean failed: $_"
        return $false
    } finally {
        Pop-Location
    }
}

Export-ModuleMember -Function Build-TypeScript, New-Executable, Get-LatestRelease, `
                              Receive-Binary, Build-FromSource, Clear-BuildArtifacts