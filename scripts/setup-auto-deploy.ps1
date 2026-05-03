# =============================================================================
# Gluecron auto-deploy setup — Windows / PowerShell
# Run once. Wires up GitHub Actions to auto-deploy gluecron.com on every push.
# =============================================================================
#
# Usage (from PowerShell, anywhere):
#   irm https://raw.githubusercontent.com/ccantynz-alt/Gluecron.com/main/scripts/setup-auto-deploy.ps1 | iex
#
# Or download + run locally:
#   .\scripts\setup-auto-deploy.ps1
#
# What it does:
#   1. Verifies gh CLI is installed + authed
#   2. Generates a dedicated SSH deploy key (~/.ssh/gluecron_deploy_key)
#   3. Uploads the public key to root@45.76.171.37 via your existing SSH access
#   4. Sets the three GitHub secrets the workflow needs
#   5. Triggers a test deploy + watches the run
# =============================================================================

$ErrorActionPreference = "Stop"

$REPO   = "ccantynz-alt/Gluecron.com"
$HOST_  = "45.76.171.37"
$USER_  = "root"
$KEYDIR = Join-Path $HOME ".ssh"
$KEY    = Join-Path $KEYDIR "gluecron_deploy_key"

Write-Host "==> Gluecron auto-deploy setup" -ForegroundColor Cyan
Write-Host ""

# ─── 1. gh CLI check ────────────────────────────────────────────────────────
Write-Host "[1/5] Checking gh CLI..."
try {
  gh --version | Out-Null
} catch {
  Write-Host "  gh CLI not installed. Install with:" -ForegroundColor Red
  Write-Host "    winget install --id GitHub.cli"
  exit 1
}
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "  gh not authenticated. Run:" -ForegroundColor Red
  Write-Host "    gh auth login"
  exit 1
}
Write-Host "  ✓ gh is installed + authed" -ForegroundColor Green

# ─── 2. SSH key ─────────────────────────────────────────────────────────────
Write-Host "[2/5] SSH deploy key..."
if (-not (Test-Path $KEYDIR)) { New-Item -ItemType Directory -Path $KEYDIR | Out-Null }
if (Test-Path $KEY) {
  Write-Host "  ✓ existing key at $KEY (reusing)" -ForegroundColor Green
} else {
  ssh-keygen -t ed25519 -f $KEY -N '""' -C "gluecron-github-actions" 2>&1 | Out-Null
  Write-Host "  ✓ generated new key at $KEY" -ForegroundColor Green
}

# ─── 3. Authorize key on the Vultr box ──────────────────────────────────────
Write-Host "[3/5] Authorizing key on $HOST_..."
$pubKey = Get-Content "$KEY.pub" -Raw
$pubKey = $pubKey.Trim()
$cmd = "mkdir -p ~/.ssh && grep -qF '$pubKey' ~/.ssh/authorized_keys 2>/dev/null || echo '$pubKey' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
Write-Host "  Will SSH as $USER_@$HOST_ — you may be prompted for password / existing key" -ForegroundColor Yellow
ssh "$USER_@$HOST_" $cmd
if ($LASTEXITCODE -ne 0) {
  Write-Host "  ✗ Failed to authorize key. Manual step:" -ForegroundColor Red
  Write-Host "    Get-Content $KEY.pub | ssh $USER_@$HOST_ 'cat >> ~/.ssh/authorized_keys'"
  exit 1
}
Write-Host "  ✓ deploy key authorized on $HOST_" -ForegroundColor Green

# ─── 4. Set GitHub secrets ──────────────────────────────────────────────────
Write-Host "[4/5] Setting GitHub Actions secrets on $REPO..."
$HOST_ | gh secret set VULTR_HOST --repo $REPO
$USER_ | gh secret set VULTR_USER --repo $REPO
Get-Content $KEY -Raw | gh secret set VULTR_SSH_KEY --repo $REPO
Write-Host "  ✓ VULTR_HOST, VULTR_USER, VULTR_SSH_KEY set" -ForegroundColor Green

# ─── 5. Trigger first deploy + watch ────────────────────────────────────────
Write-Host "[5/5] Triggering test deploy..."
gh workflow run vultr-deploy.yml --repo $REPO --ref main
Start-Sleep -Seconds 3
$run = (gh run list --repo $REPO --workflow=vultr-deploy.yml --limit 1 --json databaseId | ConvertFrom-Json)[0]
Write-Host "  ✓ Run #$($run.databaseId) started. Watching..." -ForegroundColor Green
Write-Host ""
gh run watch $run.databaseId --repo $REPO --exit-status

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "==> 🎉 Auto-deploy is live." -ForegroundColor Green
  Write-Host "   From now on every push to main auto-deploys to gluecron.com."
  Write-Host "   Smoke-tested + auto-rollback on failure."
  Write-Host ""
  Write-Host "   Optional next step: set ANTHROPIC_API_KEY for AI failure diagnosis:"
  Write-Host "     gh secret set ANTHROPIC_API_KEY --repo $REPO"
} else {
  Write-Host ""
  Write-Host "==> Run failed — check the Actions tab:" -ForegroundColor Red
  Write-Host "   https://github.com/$REPO/actions/workflows/vultr-deploy.yml"
}
