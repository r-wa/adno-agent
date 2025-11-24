# Constants.psm1
# Shared constants and configuration values

# Unicode symbols using code points for cross-platform compatibility
$Script:Symbols = @{
    Pending = [char]0x25CB    # ○
    Success = [char]0x2713    # ✓
    Error   = [char]0x2A2F    # ⨯
    Info    = [char]0x2022    # •
}

# Service configuration
$Script:ServiceConfig = @{
    Name        = "AdnoAgent"
    DisplayName = "adno Agent"
    Description = "adno background agent for processing jobs"
}

# Default configuration values
$Script:Defaults = @{
    ApiUrl              = "https://app.adno.dev"
    PollIntervalMs      = 30000
    HeartbeatIntervalMs = 60000
    MaxConcurrentTasks  = 3
    LogLevel            = "info"
    LogFormat           = "json"
}

# File paths
$Script:Paths = @{
    NssmExe    = "C:\Program Files\AdnoAgent\tools\nssm.exe"
    AgentExe   = "C:\Program Files\AdnoAgent\adno-agent.exe"
    LogDir     = "C:\ProgramData\AdnoAgent\logs"
    ConfigFile = ".env"
}

# GitHub release configuration
$Script:GitHub = @{
    Owner      = "your-org"  # Will be updated from actual repo
    Repo       = "adno"
    ApiUrl     = "https://api.github.com"
    AssetName  = "adno-agent-windows-x64.exe"
}

# Timeouts and intervals
$Script:Timeouts = @{
    ServiceStart = 30  # seconds
    ServiceStop  = 10  # seconds
    ApiTest      = 5   # seconds
}

# Export symbols and configuration
Export-ModuleMember -Variable Symbols, ServiceConfig, Defaults, Paths, GitHub, Timeouts