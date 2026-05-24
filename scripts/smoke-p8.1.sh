#!/usr/bin/env bash
# P8.1 nginx routing smoke test.
#
# Verifies the 14 routing rules in nginx/default.conf land on the
# expected upstream and return expected status codes. Run on the VPS
# (or locally against `docker compose up -d`) right after every deploy
# that touches nginx, next-app, or Express routes.
#
# Usage:
#   ./scripts/smoke-p8.1.sh                       # defaults to https://localhost
#   ./scripts/smoke-p8.1.sh https://animegoclub.com
#
# Exit codes:
#   0  — all 14 checks passed
#   N  — N checks failed (prints diff for each)

set -u

HOST="${1:-https://localhost}"
FAIL=0

# Each line: METHOD PATH EXPECTED_STATUS EXPECTED_UPSTREAM_HINT
# UPSTREAM_HINT is grep'd against the response body/headers as a sanity
# check that the route landed where we expect. Set "-" to skip the
# content check.
CHECKS=$(cat <<'EOF'
GET /                                  200 next-app
GET /seasonal                          308 -
GET /seasonal/spring/2026              200 next-app
GET /anime/1                           200 next-app
GET /search                            200 next-app
GET /welcome                           200 next-app
GET /sitemap.xml                       200 -
GET /robots.txt                        200 -
GET /about                             301 -
GET /api/anime/1                       200 -
GET /api/healthz                       404 -
GET /library                           200 -
GET /login                             200 -
GET /admin                             307 -
GET /admin/enrichment                  307 -
GET /admin/users                       307 -
EOF
)

printf "Target: %s\n\n" "$HOST"
printf "%-3s %-32s %-8s %-8s %s\n" "" "PATH" "WANT" "GOT" "NOTE"
printf "%-3s %-32s %-8s %-8s %s\n" "" "----" "----" "---" "----"

while IFS= read -r line; do
  [ -z "$line" ] && continue
  # shellcheck disable=SC2086
  set -- $line
  METHOD=$1; PATHQ=$2; WANT=$3; HINT=$4

  RESP=$(curl -sk -o /tmp/smoke-body.$$ -D /tmp/smoke-head.$$ -w "%{http_code}" -X "$METHOD" "${HOST}${PATHQ}")
  NOTE=""
  if [ "$RESP" = "$WANT" ]; then
    MARK="OK"
    # If hint=next-app, confirm next-app served it (Next adds
    # `X-Powered-By: Next.js` and uses `Vary: rsc, next-router-...`).
    if [ "$HINT" = "next-app" ] && ! grep -qi "x-powered-by: next" /tmp/smoke-head.$$ 2>/dev/null; then
      MARK="WARN"
      NOTE="want next-app, X-Powered-By header missing"
      FAIL=$((FAIL + 1))
    fi
  else
    MARK="FAIL"
    FAIL=$((FAIL + 1))
  fi
  printf "%-3s %-32s %-8s %-8s %s\n" "$MARK" "$PATHQ" "$WANT" "$RESP" "$NOTE"
  rm -f /tmp/smoke-body.$$ /tmp/smoke-head.$$
done <<< "$CHECKS"

printf "\n"
if [ "$FAIL" -eq 0 ]; then
  printf "ALL 14 CHECKS PASSED\n"
  exit 0
else
  printf "%d CHECK(S) FAILED — investigate before declaring deploy healthy\n" "$FAIL"
  exit "$FAIL"
fi
