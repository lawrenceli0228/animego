#!/bin/bash
set -e

APP_DIR="/var/www/animego"
cd "$APP_DIR"

echo "==> Pulling latest code..."
git pull origin main

echo "==> Building Docker image..."
docker compose build

echo "==> Starting container..."
docker compose up -d

echo "==> Reloading Nginx..."
sudo nginx -t && sudo systemctl reload nginx

echo "==> Done! Checking status..."
docker compose ps
curl -s http://127.0.0.1:5001/api/health
echo ""
