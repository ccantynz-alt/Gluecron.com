# =============================================================================
# Migrate gluecron to itself — Phase B
# Runs from Windows / PowerShell. Mirrors the GitHub repo onto gluecron.com,
# wires git remote, prints the Claude Code MCP config snippet.
# =============================================================================
#
# Prerequisites:
#   - gluecron.com responds 200 on /healthz
#   - ccantynz-alt account registered on gluecron.com (becomes site admin
#     automatically via SITE_ADMIN_USERNAME env var)
#   - You have a Personal Access Token at /settings/tokens on gluecron.com
#
# Run: .\scripts\migrate-to-gluecron.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

$GLUECRON = "https://gluecron.com"
$GH_OWNER = "ccantynz-alt"
$GH_REPO  = "Gluecron.com"
$GLUECRON_OWNER = "ccantynz-alt"

Write-Host "==> Phase B: Migrate gluecron to itself" -ForegroundColor Cyan
Write-Host ""

# ─── 1. Verify gluecron.com is live ─────────────────────────────────────────
Write-Host "[1/5] Verifying gluecron.com is live..."
try {
  $health = Invoke-RestMethod -Uri "$GLUECRON/healthz" -TimeoutSec 10
  Write-Host "  ✓ gluecron.com /healthz responded" -ForegroundColor Green
} catch {
  Write-Host "  ✗ gluecron.com is not responding. Fix Phase A first." -ForegroundColor Red
  exit 1
}

# ─── 2. PAT prompt ──────────────────────────────────────────────────────────
Write-Host "[2/5] Personal Access Token..."
Write-Host "  Open in browser: $GLUECRON/settings/tokens" -ForegroundColor Yellow
Write-Host "  Generate a token with full scope, copy it, paste below." -ForegroundColor Yellow
$secureToken = Read-Host "  PAT" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$PAT = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) | Out-Null
if (-not $PAT -or $PAT.Length -lt 10) {
  Write-Host "  ✗ Empty / suspicious PAT, aborting." -ForegroundColor Red
  exit 1
}

# Verify PAT works
try {
  $me = Invoke-RestMethod -Uri "$GLUECRON/api/v2/me" -Headers @{ Authorization = "Bearer $PAT" } -TimeoutSec 10
  Write-Host "  ✓ Authenticated as: $($me.username)" -ForegroundColor Green
} catch {
  Write-Host "  ✗ PAT failed auth. Verify the token at $GLUECRON/settings/tokens." -ForegroundColor Red
  exit 1
}

# ─── 3. Trigger import from GitHub ──────────────────────────────────────────
Write-Host "[3/5] Importing $GH_OWNER/$GH_REPO from GitHub..."
$importBody = @{
  source = "github"
  owner  = $GH_OWNER
  repo   = $GH_REPO
} | ConvertTo-Json
try {
  $imported = Invoke-RestMethod -Method POST -Uri "$GLUECRON/import/github/repo" `
    -Headers @{ Authorization = "Bearer $PAT" } `
    -ContentType "application/json" `
    -Body $importBody -TimeoutSec 120
  Write-Host "  ✓ Repo mirrored to $GLUECRON/$GLUECRON_OWNER/$GH_REPO" -ForegroundColor Green
} catch {
  $resp = $_.Exception.Response
  if ($resp -and $resp.StatusCode -eq 409) {
    Write-Host "  ✓ Already imported (409 conflict is fine)" -ForegroundColor Yellow
  } else {
    Write-Host "  ✗ Import failed: $_" -ForegroundColor Red
    Write-Host "  You can also import manually at $GLUECRON/import"
    exit 1
  }
}

# ─── 4. Output git remote command ───────────────────────────────────────────
Write-Host "[4/5] Git remote setup..."
$remoteUrl = "$GLUECRON/$GLUECRON_OWNER/$GH_REPO.git"
Write-Host "  In a clone of the repo, run:" -ForegroundColor Yellow
Write-Host "    git remote add gluecron $remoteUrl"
Write-Host "    git push -u gluecron main"
Write-Host ""

# ─── 5. Output MCP config ───────────────────────────────────────────────────
Write-Host "[5/5] Claude Code / Cursor MCP config..."
Write-Host "  Add this to your Claude Desktop config (claude_desktop_config.json):" -ForegroundColor Yellow
Write-Host ""
$mcpConfig = @"
{
  "mcpServers": {
    "gluecron": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "$GLUECRON/mcp"],
      "env": {
        "GLUECRON_TOKEN": "$PAT"
      }
    }
  }
}
"@
Write-Host $mcpConfig -ForegroundColor White

Write-Host ""
Write-Host "==> Phase B foundation complete." -ForegroundColor Green
Write-Host "    Repo mirrored. From now on you can git push to either remote."
Write-Host "    Phase C (cut the GitHub cord) is unlocked when:"
Write-Host "      - You've pushed to gluecron with no errors for ~1 week"
Write-Host "      - You've moved active issues/PRs over"
Write-Host "      - The .gluecron/workflows/deploy.yml runs cleanly on push"
