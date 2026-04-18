#!/bin/bash
set -euo pipefail

# ============================================
# Nginx + HTTPS setup for gluecron
# ============================================

DOMAIN="${1:-gluecron.com}"

echo "Setting up nginx for $DOMAIN..."

# Install nginx + certbot
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Create nginx config
sudo tee /etc/nginx/sites-available/gluecron > /dev/null << NGINX
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    # Allow large git pushes
    client_max_body_size 500m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Required for git smart HTTP protocol
        proxy_buffering off;
        proxy_request_buffering off;

        # Timeouts for large repos
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
        proxy_read_timeout 300;
    }
}
NGINX

# Enable site
sudo ln -sf /etc/nginx/sites-available/gluecron /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# Get SSL cert
echo "Getting SSL certificate..."
sudo certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" || {
  echo ""
  echo "Certbot failed — DNS may not be pointed yet."
  echo "Once DNS is live, run:"
  echo "  sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
}

echo ""
echo "Nginx configured for $DOMAIN"
echo "  HTTP  -> HTTPS redirect: automatic (after cert)"
echo "  Proxy -> localhost:3000"
echo "  Max upload: 500MB (for large repos)"
