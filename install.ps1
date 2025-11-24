# Wrapper script for backward compatibility
# Forwards to the actual script in scripts/ directory

& (Join-Path $PSScriptRoot "scripts\install.ps1") @args