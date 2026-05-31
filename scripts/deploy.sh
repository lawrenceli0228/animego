#!/bin/bash
# Deploy a branch on the VPS. Default is `main` — the stable/production
# branch (only tested, reviewed code lands there; production deploys from
# it). Active development happens on feat/go-backend; pass a branch name
# explicitly to deploy a dev build.
#
# Usage:
#   ./scripts/deploy.sh                   # pulls main (production)
#   ./scripts/deploy.sh feat/go-backend   # pulls the dev branch
#   ./scripts/deploy.sh some/other-branch # pulls some/other-branch
#
# Pre-flight (one-time on a fresh VPS):
#   - /opt/animego cloned from git@github.com:lawrenceli0228/animego.git
#   - .env.production + nginx/selfsigned.* present (gitignored, copied
#     manually from local + chmod 600)
#   - docker + docker compose installed
set -e

APP_DIR="/opt/animego"
BRANCH="${1:-main}"

cd "$APP_DIR"

echo "==> Pulling latest code from origin/$BRANCH..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

# FOOTGUN GUARD: this shell still holds the PRE-pull deploy.sh in memory, so
# any steps the pull ADDED below (migrate, nginx cp) would be silently skipped
# — exactly how the first P11 deploy left /api on legacy Express + the DB
# un-migrated. Re-exec the freshly-pulled script once so the new steps run.
# DEPLOY_REEXEC guards against an infinite loop.
if [ -z "${DEPLOY_REEXEC:-}" ]; then
  echo "==> Re-exec'ing freshly pulled deploy.sh..."
  exec env DEPLOY_REEXEC=1 bash "$APP_DIR/scripts/deploy.sh" "$@"
fi

# --env-file=.env.production:
#   - feeds `${VAR}` substitutions in docker-compose.yml (e.g.
#     NEXT_PUBLIC_SENTRY_DSN passed as a build arg into Dockerfile so
#     Next.js can inline it into the client bundle at build time).
#   - also overrides the default `.env` lookup so service `env_file:`
#     references stay consistent across build + runtime.
COMPOSE="docker compose --env-file=.env.production"

# git reset --hard above reverts nginx/default.conf to the committed (legacy)
# version. Restore the P9 routing config (/api -> go-api, /socket.io ->
# ws-server) BEFORE the `restart nginx` below, or /api silently drops back
# onto the legacy Express `app` service (mismatched ObjectId vs uuid logs
# users out). See memory feedback_deploy_nginx_bind_mount_restart +
# project_dns_rollback.
echo "==> Restoring P9 nginx routing (default.p9.conf -> default.conf)..."
cp nginx/default.p9.conf nginx/default.conf

# Apply DB migrations BEFORE recreating go-api. The new Go binary + River
# queue reference columns/tables added by go-api/migrations/* (e.g. P11's
# bgm_match_source / bgm_id_map); bringing go-api up against an un-migrated
# DB 500s (GetAdminStats) or crash-loops the queue. Postgres is already up;
# the migrate profile applies the chain idempotently (no-op when current).
echo "==> Applying DB migrations..."
$COMPOSE --profile migrate run --rm migrate

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
