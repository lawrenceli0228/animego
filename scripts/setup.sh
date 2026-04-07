#!/bin/bash
set -euo pipefail

echo "=== AnimeGo VPS Setup (Debian 12) ==="

# Update system
apt-get update && apt-get upgrade -y

# Install Docker
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Install Git
apt-get install -y git

# Enable Docker
systemctl enable docker
systemctl start docker

# Firewall: only allow SSH + HTTP
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 17776/tcp  # SSH port
ufw allow 80/tcp     # HTTP (Cloudflare connects here)
ufw --force enable

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Clone your repo:  git clone <your-repo-url> /opt/animego"
echo "  2. cd /opt/animego"
echo "  3. cp .env.production.example .env.production"
echo "  4. Edit .env.production (set JWT secrets)"
echo "  5. docker compose up -d --build"
