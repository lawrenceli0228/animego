#!/bin/bash
# Deploy the current branch on the VPS. Default branch is feat/go-backend
# because that's the canonical branch through P0-P10 (main is 119 commits
# behind as of 2026-05-26 and will be merged after P10 lands).
#
# Usage:
#   ./scripts/deploy.sh                   # pulls feat/go-backend
#   ./scripts/deploy.sh main              # pulls main (post-merge)
#   ./scripts/deploy.sh some/other-branch # pulls some/other-branch
#
# Pre-flight (one-time on a fresh VPS):
#   - /opt/animego cloned from git@github.com:lawrenceli0228/animego.git
#   - .env.production + nginx/selfsigned.* present (gitignored, copied
#     manually from local + chmod 600)
#   - docker + docker compose installed
set -e

APP_DIR="/opt/animego"
BRANCH="${1:-feat/go-backend}"

cd "$APP_DIR"

echo "==> Pulling latest code from origin/$BRANCH..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

# --env-file=.env.production:
#   - feeds `${VAR}` substitutions in docker-compose.yml (e.g.
#     NEXT_PUBLIC_SENTRY_DSN passed as a build arg into Dockerfile so
#     Next.js can inline it into the client bundle at build time).
#   - also overrides the default `.env` lookup so service `env_file:`
#     references stay consistent across build + runtime.
COMPOSE="docker compose --env-file=.env.production"

echo "==> Building Docker images..."
$COMPOSE build

echo "==> Bringing services up..."
$COMPOSE up -d

# nginx config is a bind-mount (./nginx/default.conf →
# /etc/nginx/conf.d/default.conf). After `git pull`/reset the inode
# changes, and `nginx -s reload` reads the stale fd. `restart` re-opens
# the file. See memory feedback_deploy_nginx_bind_mount_restart.
echo "==> Restarting nginx to pick up bind-mounted conf changes..."
$COMPOSE restart nginx

echo "==> Status:"
$COMPOSE ps

echo "==> Smoke (via nginx, -k for self-signed cert)..."
curl -sk -o /dev/null -w "HTTP %{http_code} from /api/health\n" https://localhost/api/health
curl -sk -o /dev/null -w "HTTP %{http_code} from /\n" https://localhost/
curl -sk -o /dev/null -w "HTTP %{http_code} from /anime/154587\n" https://localhost/anime/154587

echo ""
echo "==> Done. If a smoke line shows 5xx, check 'docker compose logs --tail=50 <service>'."
