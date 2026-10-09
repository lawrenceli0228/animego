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
# GIT_SHA becomes NEXT_PUBLIC_BUILD_ID inside the next-app image, which is how
# a browser tab opened before this deploy discovers it is running code the
# server no longer serves (StaleTabNotice). Exported rather than passed inline
# so compose picks it up as the build arg declared in docker-compose.yml.
#
# It falls back to a timestamp inside next.config.ts when unset, so a build
# outside this script still gets a distinct id -- the only thing the SHA buys
# is that redeploying the same commit does not read as a new version and ask
# every reader to refresh for nothing.
GIT_SHA="$(git rev-parse --short=12 HEAD 2>/dev/null || true)"
export GIT_SHA
echo "    build id: ${GIT_SHA:-<timestamp fallback>}"
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

# The AniList originals cache may grow to 30 GB on this disk, next to the
# database and docker's build cache, which grows back on its own. The warm job
# stops storing and reports to Sentry below 10 GB free; this line shows the
# margin at every deploy.
echo "==> Disk:"
df -h /

echo "==> Smoke (via nginx, -k for self-signed cert)..."
curl -sk -o /dev/null -w "HTTP %{http_code} from /api/health\n" https://localhost/api/health
curl -sk -o /dev/null -w "HTTP %{http_code} from /\n" https://localhost/
curl -sk -o /dev/null -w "HTTP %{http_code} from /anime/154587\n" https://localhost/anime/154587
# /_next/image is served by the next-image container, not next-app.
curl -sk -o /dev/null -w "HTTP %{http_code} from /_next/image (next-image)\n" "https://localhost/_next/image?url=%2Fcommunity-guide.jpg&w=640&q=85"
# The AniList mirror; each line should say 200 image/* (or OK). First, nginx
# serving an original: from its store once the warm job has run, from
# AniList until then. Second, a /_next/image request shaped like a page's,
# whose source is the mirror.
MIRROR_PATH="media/anime/cover/medium/bx154587-qQTzQnEJJ3oB.jpg"
curl -sk -o /dev/null -w "HTTP %{http_code} %{content_type} from /img/anilist/ (mirror original)\n" "https://localhost/img/anilist/$MIRROR_PATH"
curl -sk -o /dev/null -w "HTTP %{http_code} %{content_type} from /_next/image (mirror source)\n" "https://localhost/_next/image?url=https%3A%2F%2Fanimegoclub.com%2Fimg%2Fanilist%2F${MIRROR_PATH//\//%2F}&w=640&q=85"
# The /_next/image line above is answered from nginx's variant cache once it
# has passed, so it stops proving the optimizer can still reach the mirror.
# This one cannot be cached in front: from inside next-image, the request Next
# makes for an image it has not encoded yet (same runtime, DNS and route
# through the CDN). Anything but 200 image/* means new images cannot load.
$COMPOSE exec -T next-image node -e '
  const url = process.argv[1];
  fetch(url, { signal: AbortSignal.timeout(7000), redirect: "manual" })
    .then(async (r) => {
      console.log(`HTTP ${r.status} ${r.headers.get("content-type")} from next-image -> ${url}`);
      await r.body?.cancel();
    })
    .catch((e) => console.log(`FAILED from next-image -> ${url}: ${e.name}: ${e.message}`));
' "https://animegoclub.com/img/anilist/$MIRROR_PATH" || true
# The warm job's own way in: from the go-api container, through the
# IMAGE_WARM_BASE_URL it reads. OK means it can store originals; a 403 is a
# wrong path or allowlists that disagree; no answer is a wrong host or port.
$COMPOSE exec -T go-api sh -c '
  if [ -z "$IMAGE_WARM_BASE_URL" ]; then
    echo "warm job off (IMAGE_WARM_BASE_URL is empty)"
  elif out=$(wget -nv -O /dev/null "${IMAGE_WARM_BASE_URL%/}/$1" 2>&1); then
    echo "OK from the warm endpoint (go-api -> $IMAGE_WARM_BASE_URL)"
  else
    echo "FAILED from the warm endpoint (go-api -> $IMAGE_WARM_BASE_URL): $out"
  fi' sh "$MIRROR_PATH" || true

echo ""
echo "==> Done. If a smoke line shows 5xx, check 'docker compose logs --tail=50 <service>'."
