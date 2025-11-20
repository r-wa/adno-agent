# Setup Instructions for adno-agent Repository

## Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Fill in the details:
   - **Repository name**: `adno-agent`
   - **Description**: `Background processing agent for adno workspace automation`
   - **Visibility**: **Public** ✅ (IMPORTANT!)
   - **Initialize repository**: Leave unchecked (we already have files)
3. Click **Create repository**

## Step 2: Push Local Repository to GitHub

Open PowerShell in the `adno-agent` directory and run:

```powershell
# Add GitHub as remote
git remote add origin https://github.com/r-wa/adno-agent.git

# Push code to GitHub
git push -u origin master
```

## Step 3: Create First Release

```powershell
# Create and push version tag
git tag -a v1.0.0 -m "Release v1.0.0: Initial public release"
git push origin v1.0.0
```

This will trigger the GitHub Actions workflow to:
1. Build the TypeScript code
2. Package as Windows executable (`adno-agent-windows-x64.exe`)
3. Generate SHA256 checksum
4. Create a GitHub Release with downloadable binaries

## Step 4: Verify Release

1. Go to https://github.com/r-wa/adno-agent/releases
2. Wait for the workflow to complete (takes ~2-3 minutes)
3. Verify the release contains:
   - `adno-agent-windows-x64.exe`
   - `adno-agent-windows-x64.exe.sha256`

## Step 5: Test Public Download

Try downloading the binary without authentication:

```powershell
# This should work even in an incognito browser!
Invoke-WebRequest -Uri "https://github.com/r-wa/adno-agent/releases/download/v1.0.0/adno-agent-windows-x64.exe" -OutFile "test-download.exe"

# Check if file downloaded successfully
if (Test-Path "test-download.exe") {
    Write-Host "✓ Public download works!" -ForegroundColor Green
    Remove-Item "test-download.exe"
} else {
    Write-Host "✗ Download failed" -ForegroundColor Red
}
```

## Step 6: Update Main adno Repository

The main private repository already points to the new location:
```
https://github.com/r-wa/adno-agent/releases/download/v{version}/adno-agent-windows-x64.exe
```

Once the first release is published, the installation from the web UI should work!

## Troubleshooting

### Workflow fails to build

1. Check Actions tab: https://github.com/r-wa/adno-agent/actions
2. Review build logs for errors
3. Common issues:
   - Missing dependencies in `package.json`
   - TypeScript compilation errors
   - Path issues in GitHub Actions

### Binary not in release

1. Check workflow completed successfully
2. Verify `pkg` step ran without errors
3. Check file permissions in workflow

### Download requires authentication

This means the repository is private or the release is a draft:
1. Verify repository is **Public** (Settings → Danger Zone → Change visibility)
2. Verify release is not marked as **Draft**

## Next Steps

After successful setup:

1. **Update version tracking**: If you have an `agent_versions` table in the database, add v1.0.0 with the binary URL
2. **Test installation**: Try the installation from the adno web UI
3. **Update documentation**: Update main adno README to link to adno-agent repository
4. **Remove agent code from private repo**: Once verified working, remove `agent/` directory from private adno repository

## Future Releases

To release a new version:

```powershell
# Update version in package.json first
# Then tag and push:
git tag -a v1.1.0 -m "Release v1.1.0: Description of changes"
git push origin v1.1.0
```

The GitHub Actions workflow will automatically build and publish the release!
