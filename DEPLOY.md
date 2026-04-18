# Deploying Gluecron to Production

## Prerequisites

1. A server (Hetzner, DigitalOcean, etc.) with Ubuntu 22.04+
2. A Neon PostgreSQL database (free tier: https://neon.tech)
3. Domain pointed to the server (gluecron.com → server IP)

## Quick Deploy (one command)

```bash
# 1. SSH into your server
ssh root@your-server-ip

# 2. Set your database URL
export DATABASE_URL="postgresql://user:pass@host/gluecron?sslmode=require"

# 3. Run the deploy script
curl -fsSL https://raw.githubusercontent.com/ccantynz-alt/Gluecron.com/claude/ship-fixes-and-tests-Jvz1c/scripts/deploy.sh | bash
```

## Manual Deploy

### Step 1: Database

1. Go to https://neon.tech and create a project called "gluecron"
2. Copy the connection string
3. Run the migration:
```bash
psql "your-connection-string" -f drizzle/0000_init.sql
```

### Step 2: Server Setup

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install git
apt-get update && apt-get install -y git

# Clone the repo
git clone --branch claude/ship-fixes-and-tests-Jvz1c \
  https://github.com/ccantynz-alt/Gluecron.com.git /opt/gluecron
cd /opt/gluecron

# Create .env
cat > .env << EOF
DATABASE_URL=postgresql://user:pass@host/gluecron?sslmode=require
GIT_REPOS_PATH=/data/repos
PORT=3000
NODE_ENV=production
GATETEST_URL=https://gatetest.ai/api/scan/run
CRONTECH_DEPLOY_URL=https://crontech.ai/api/trpc/tenant.deploy
EOF

# Install dependencies
bun install --production

# Create repos directory
mkdir -p /data/repos

# Start the server
bun run src/index.ts
```

### Step 3: HTTPS with Nginx

```bash
bash scripts/setup-nginx.sh gluecron.com
```

### Step 4: Systemd (keep it running)

```bash
# The deploy script creates this, but manually:
cat > /etc/systemd/system/gluecron.service << EOF
[Unit]
Description=Gluecron
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gluecron
EnvironmentFile=/opt/gluecron/.env
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable gluecron
systemctl start gluecron
```

## Docker Deploy

```bash
# Create .env file with DATABASE_URL
echo "DATABASE_URL=postgresql://..." > .env

# Build and run
docker compose up -d

# Run migration
docker compose exec gluecron bun run -e "..."
# Or connect directly to Neon and run drizzle/0000_init.sql
```

## Operations

```bash
# View logs
journalctl -u gluecron -f

# Restart
systemctl restart gluecron

# Update to latest
cd /opt/gluecron
git pull origin claude/ship-fixes-and-tests-Jvz1c
bun install
systemctl restart gluecron
```

## Verification Checklist

After deploy, verify:

- [ ] `curl http://localhost:3000` returns the landing page
- [ ] Register an account at /register
- [ ] Create a repo at /new
- [ ] `git clone http://gluecron.com/youruser/yourrepo.git` works
- [ ] Push code and see it in the web UI
- [ ] Health dashboard shows at /youruser/yourrepo/health
- [ ] HTTPS works (if nginx + certbot set up)
