# adno Agent

Background processing agent for [adno](https://github.com/r-wa/adno) workspace automation.

## Overview

The adno agent is a Windows service that runs in the background to process tasks for your adno workspace. It handles:

- **Azure DevOps Sync**: Synchronizes work items from Azure DevOps
- **Clarity Suggestions**: Generates AI-powered improvement suggestions for unclear work items
- **Consensus Evaluation**: Evaluates voting consensus on suggestions

## Installation

### Prerequisites

- Windows 10/11 or Windows Server 2016+
- Administrator privileges
- Active adno workspace account

### Quick Install (Recommended)

Download and run the installation script:

```powershell
# Download installer
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/r-wa/adno-agent/main/install.ps1" -OutFile "install.ps1"

# Run with your API key (will prompt for admin privileges)
.\install.ps1 -ApiKey "agnt_your-key-here"
```

**Optional parameters:**
- `-ApiUrl` - Custom adno server URL (default: `https://app.adno.dev`)
- `-Version` - Specific version to install (default: `latest`)
- `-InstallDir` - Custom installation directory (default: `C:\Program Files\adno Agent`)

The installer will:
- Download the agent binary with checksum verification
- Configure environment variables
- Install as a Windows service with auto-restart on failure
- Start the agent automatically

### Web UI Install

1. **Get your API key** from the adno web app at `/settings/agents`
2. **Copy the installation command** provided in the UI
3. **Paste and run** in PowerShell (will prompt for admin privileges automatically)

### Manual Installation

1. **Download the binary**:
   ```powershell
   Invoke-WebRequest -Uri "https://github.com/r-wa/adno-agent/releases/latest/download/adno-agent-windows-x64.exe" -OutFile "adno-agent.exe"
   ```

2. **Verify checksum** (optional but recommended):
   ```powershell
   $hash = Get-FileHash -Path adno-agent.exe -Algorithm SHA256
   $expectedHash = (Invoke-WebRequest -Uri "https://github.com/r-wa/adno-agent/releases/latest/download/adno-agent-windows-x64.exe.sha256").Content
   if ($hash.Hash -eq $expectedHash) {
       Write-Host "Checksum verified!" -ForegroundColor Green
   } else {
       Write-Host "Checksum mismatch! Do not run this binary." -ForegroundColor Red
   }
   ```

3. **Configure environment variables**:
   ```powershell
   [Environment]::SetEnvironmentVariable('ADNO_API_KEY', 'your-api-key-here', 'Machine')
   [Environment]::SetEnvironmentVariable('ADNO_API_URL', 'https://app.adno.dev', 'Machine')
   ```

4. **Install as Windows service**:
   ```powershell
   sc.exe create AdnoAgent binPath="`"$PWD\adno-agent.exe`"" DisplayName="adno Agent" start=auto
   Start-Service AdnoAgent
   ```

## Configuration

The agent is configured via environment variables:

### Required

- `ADNO_API_KEY`: Your agent API key from the adno web app
- `ADNO_API_URL`: URL of your adno instance (e.g., `https://app.adno.dev`)

### Optional

- `POLL_INTERVAL_MS`: How often to check for new tasks (default: 30000 = 30 seconds)
- `HEARTBEAT_INTERVAL_MS`: How often to send heartbeat signal (default: 60000 = 60 seconds)
- `MAX_CONCURRENT_TASKS`: Maximum tasks to process in parallel (default: 3)
- `LOG_LEVEL`: Logging level - `debug`, `info`, `warn`, `error` (default: `info`)

## Service Management

### View status
```powershell
Get-Service -Name AdnoAgent
```

### Start service
```powershell
Start-Service -Name AdnoAgent
```

### Stop service
```powershell
Stop-Service -Name AdnoAgent
```

### Restart service
```powershell
Restart-Service -Name AdnoAgent
```

### View logs
```powershell
Get-EventLog -LogName Application -Source AdnoAgent -Newest 50
```

### Uninstall
```powershell
Stop-Service -Name AdnoAgent
sc.exe delete AdnoAgent
[Environment]::SetEnvironmentVariable('ADNO_API_KEY', $null, 'Machine')
[Environment]::SetEnvironmentVariable('ADNO_API_URL', $null, 'Machine')
```

## Development

### Prerequisites

- Node.js 20+
- npm or pnpm

### Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build TypeScript
npm run build

# Run compiled version
npm start

# Type check
npm run type-check
```

### Building Binary

```bash
# Build TypeScript first
npm run build

# Package as Windows executable
npm run package

# Output: adno-agent-windows-x64.exe
```

### Project Structure

```
adno-agent/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config.ts                # Configuration loader
│   ├── api/
│   │   └── BackendApiClient.ts  # API client for adno backend
│   ├── runtime/
│   │   ├── AgentRuntime.ts      # Main agent runtime
│   │   └── TaskExecutor.ts      # Task execution engine
│   ├── tasks/
│   │   ├── AdoSyncHandler.ts             # Azure DevOps sync
│   │   ├── ClaritySuggestionHandler.ts   # AI suggestions
│   │   └── ConsensusEvaluationHandler.ts # Consensus evaluation
│   ├── utils/
│   │   └── logger.ts            # Logging utility
│   └── version/
│       └── VersionChecker.ts    # Version checking
├── .github/
│   └── workflows/
│       └── release.yml          # Automated releases
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### Agent won't start

1. **Check service status**: `Get-Service -Name AdnoAgent`
2. **View error logs**: `Get-EventLog -LogName Application -Source AdnoAgent -Newest 10`
3. **Verify environment variables**:
   ```powershell
   [Environment]::GetEnvironmentVariable('ADNO_API_KEY', 'Machine')
   [Environment]::GetEnvironmentVariable('ADNO_API_URL', 'Machine')
   ```

### Agent not processing tasks

1. **Check dashboard**: Visit `/settings/agents` in the adno web app
2. **Verify API key**: Ensure it hasn't been rotated
3. **Check network**: Ensure agent can reach `ADNO_API_URL`
4. **Restart service**: `Restart-Service -Name AdnoAgent`

### High CPU/memory usage

1. **Reduce concurrency**: Lower `MAX_CONCURRENT_TASKS` environment variable
2. **Increase polling interval**: Raise `POLL_INTERVAL_MS` to reduce API calls
3. **Check task types**: Disable unnecessary task types in the web UI

## Security

- **API Key**: Never commit API keys to version control. They are stored in machine-level environment variables
- **HTTPS**: Always use HTTPS for `ADNO_API_URL` in production
- **Permissions**: The service runs with the permissions of the installing user
- **Updates**: Keep the agent updated to receive security patches

## License

MIT

## Support

- **Issues**: https://github.com/r-wa/adno-agent/issues
- **Documentation**: https://github.com/r-wa/adno
- **Main Project**: https://github.com/r-wa/adno
