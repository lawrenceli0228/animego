#!/usr/bin/env bash
# P9 smoke — runbook §4 (16 nginx routes + 4 manual checks 17-20).
#
# Runs the existing P8.1 nginx route smoke, then layers in the four
# manual checks the runbook says must pass at T+0+48min:
#   17. login (POST /api/auth/login → 200 + Set-Cookie session)
#   18. RSC fetch (/anime/154587 → episodeTitles in HTML)
#   19. subscription (POST /api/subscriptions → 200, with session)
#   20. danmaku degraded (GET /api/danmaku/<id>/<ep> → 200)
#
# Usage:
#   ./scripts/p9-smoke.sh                                # https://localhost
#   ./scripts/p9-smoke.sh --target=https://animegoclub.com
#
# Env (required for check 17/19):
#   TEST_EMAIL=...      prod-safe known account
#   TEST_PASSWORD=...   for that account
#
# Exit codes:
#   0  — all 20 checks passed
#   1  — at least one failed (count printed at end)

set -euo pipefail

# --- log file ----------------------------------------------------------
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="/tmp/p9-smoke-${TS}.log"

# --- color helpers ----------------------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    C_GREEN="$(tput setaf 2)"
    C_RED="$(tput setaf 1)"
    C_YELLOW="$(tput setaf 3)"
    C_BOLD="$(tput bold)"
    C_RESET="$(tput sgr0)"
else
    C_GREEN=""; C_RED=""; C_YELLOW=""; C_BOLD=""; C_RESET=""
fi

ok()   { printf "%s[OK]%s   %s\n"   "$C_GREEN"  "$C_RESET" "$1"; }
warn() { printf "%s[WARN]%s %s\n"   "$C_YELLOW" "$C_RESET" "$1"; }
fail() { printf "%s[FAIL]%s %s\n"   "$C_RED"    "$C_RESET" "$1"; }
info() { printf "%s[..]%s   %s\n"   "$C_BOLD"   "$C_RESET" "$1"; }

exec > >(tee -a "$LOG_FILE") 2>&1
info "logging to $LOG_FILE"

# --- args --------------------------------------------------------------
TARGET="https://localhost"
for arg in "$@"; do
    case "$arg" in
        --target=*) TARGET="${arg#--target=}" ;;
        --help|-h)
            printf "usage: %s [--target=<url>]\n" "$0"
            exit 0
            ;;
        *) fail "unknown arg: $arg"; exit 2 ;;
    esac
done

info "target: $TARGET"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS_COUNT=0
FAIL_COUNT=0
record_pass() { PASS_COUNT=$((PASS_COUNT + 1)); }
record_fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ======================================================================
# CHECK 1-16 — nginx routes via existing smoke
# ======================================================================
info "CHECKS 1-16/20 — nginx routes (smoke-p8.1.sh)"
SMOKE="$REPO_ROOT/scripts/smoke-p8.1.sh"
if [ ! -f "$SMOKE" ]; then
    fail "missing $SMOKE"
    exit 2
fi
info "\$ bash $SMOKE $TARGET"
SMOKE_RC=0
bash "$SMOKE" "$TARGET" || SMOKE_RC=$?
if [ "$SMOKE_RC" -eq 0 ]; then
    ok "smoke-p8.1 PASS (16/16)"
    PASS_COUNT=$((PASS_COUNT + 16))
else
    fail "smoke-p8.1 had $SMOKE_RC failures (of 16)"
    FAIL_COUNT=$((FAIL_COUNT + SMOKE_RC))
    PASS_COUNT=$((PASS_COUNT + 16 - SMOKE_RC))
fi

# ======================================================================
# CHECK 17 — login: POST /api/auth/login, expect 200 + Set-Cookie
# ======================================================================
info "CHECK 17/20 — POST /api/auth/login"
if [ -z "${TEST_EMAIL:-}" ] || [ -z "${TEST_PASSWORD:-}" ]; then
    fail "TEST_EMAIL / TEST_PASSWORD env vars are required for check 17"
    record_fail
    SESSION_COOKIE_JAR=""
else
    SESSION_COOKIE_JAR="/tmp/p9-smoke-cookies-${TS}.txt"
    rm -f "$SESSION_COOKIE_JAR"
    # Login payload: Express controller (server/controllers/auth.controller.js:87)
    # reads {email, password} from req.body. Go-api parity preserved.
    LOGIN_PAYLOAD="$(printf '{"email":"%s","password":"%s"}' "$TEST_EMAIL" "$TEST_PASSWORD")"

    info "\$ curl -sk -c $SESSION_COOKIE_JAR -X POST $TARGET/api/auth/login ..."
    LOGIN_BODY="/tmp/p9-smoke-login-${TS}.json"
    LOGIN_HEAD="/tmp/p9-smoke-login-${TS}.head"
    LOGIN_CODE="$(curl -sk \
        -c "$SESSION_COOKIE_JAR" \
        -o "$LOGIN_BODY" \
        -D "$LOGIN_HEAD" \
        -w "%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        --data "$LOGIN_PAYLOAD" \
        "${TARGET}/api/auth/login" || echo "000")"

    if [ "$LOGIN_CODE" = "200" ] && grep -qi "^set-cookie:" "$LOGIN_HEAD"; then
        ok "login 200 + Set-Cookie present"
        record_pass
    else
        fail "login failed (HTTP $LOGIN_CODE, Set-Cookie=$(grep -ic '^set-cookie:' "$LOGIN_HEAD" || echo 0))"
        warn "response body (first 400 chars):"
        head -c 400 "$LOGIN_BODY" || true
        printf "\n"
        record_fail
    fi
fi

# ======================================================================
# CHECK 18 — RSC fetch: GET /anime/154587, look for episode titles
# ======================================================================
info "CHECK 18/20 — GET /anime/154587 (RSC, expect episodeTitles)"
RSC_BODY="/tmp/p9-smoke-rsc-${TS}.html"
RSC_CODE="$(curl -sk -o "$RSC_BODY" -w "%{http_code}" "${TARGET}/anime/154587" || echo "000")"
if [ "$RSC_CODE" != "200" ]; then
    fail "RSC fetch returned HTTP $RSC_CODE"
    record_fail
else
    # episodeTitles ships in the RSC payload — confirmed at
    # next-app/src/app/anime/[id]/page.tsx:1112. Backup signal:
    # rendered episode markup. If both miss, RSC fetch is broken.
    if grep -q "episodeTitles" "$RSC_BODY"; then
        ok "RSC contains episodeTitles"
        record_pass
    elif grep -qE '"episode"|第.*[话集]' "$RSC_BODY"; then
        ok "RSC contains rendered episode markup (no episodeTitles literal)"
        record_pass
    else
        fail "RSC missing episodeTitles + episode markup"
        warn "first 400 chars of body:"
        head -c 400 "$RSC_BODY" || true
        printf "\n"
        record_fail
    fi
fi

# ======================================================================
# CHECK 19 — subscription: POST /api/subscriptions, expect 200
# ======================================================================
info "CHECK 19/20 — POST /api/subscriptions (with session)"
if [ -z "${SESSION_COOKIE_JAR}" ] || [ ! -s "$SESSION_COOKIE_JAR" ]; then
    fail "no session cookie from check 17; skipping subscription check"
    record_fail
else
    # Subscription payload: go-api/internal/subscriptions/types.go:28
    # createSubscriptionReq = {anilistId int32 >=1, status oneof
    # watching|completed|plan_to_watch|dropped}. Express validator
    # rules match.
    SUB_PAYLOAD='{"anilistId":154587,"status":"watching"}'
    SUB_BODY="/tmp/p9-smoke-sub-${TS}.json"
    info "\$ curl -sk -b $SESSION_COOKIE_JAR -X POST $TARGET/api/subscriptions -d '$SUB_PAYLOAD'"
    SUB_CODE="$(curl -sk \
        -b "$SESSION_COOKIE_JAR" \
        -o "$SUB_BODY" \
        -w "%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        --data "$SUB_PAYLOAD" \
        "${TARGET}/api/subscriptions" || echo "000")"

    if [ "$SUB_CODE" = "200" ] || [ "$SUB_CODE" = "201" ]; then
        ok "subscription returned $SUB_CODE"
        record_pass
    else
        fail "subscription returned HTTP $SUB_CODE"
        warn "response body (first 400 chars):"
        head -c 400 "$SUB_BODY" || true
        printf "\n"
        record_fail
    fi
fi

# ======================================================================
# CHECK 20 — danmaku degraded: GET /api/danmaku/<id>/<ep>, expect 200
# ======================================================================
info "CHECK 20/20 — GET /api/danmaku/154587/1 (degraded http only)"
# go-api/internal/danmaku/handlers.go:7 — GET /api/danmaku/:anilistId/:episode
# (public, no auth). Real-time send/receive is socket.io and only
# verifiable in a browser; this is the HTTP read-side smoke only.
DM_BODY="/tmp/p9-smoke-dm-${TS}.json"
DM_CODE="$(curl -sk -o "$DM_BODY" -w "%{http_code}" \
    "${TARGET}/api/danmaku/154587/1" || echo "000")"
if [ "$DM_CODE" = "200" ]; then
    ok "danmaku endpoint returned 200"
    record_pass
else
    fail "danmaku endpoint returned HTTP $DM_CODE"
    warn "response body (first 200 chars):"
    head -c 200 "$DM_BODY" || true
    printf "\n"
    record_fail
fi

# ======================================================================
# SUMMARY
# ======================================================================
printf "\n%s========== SUMMARY ==========%s\n" "$C_BOLD" "$C_RESET"
printf "passed: %d\n" "$PASS_COUNT"
printf "failed: %d\n" "$FAIL_COUNT"

# cleanup transient bodies (keep cookie jar so operator can replay)
rm -f /tmp/p9-smoke-login-"${TS}".json /tmp/p9-smoke-login-"${TS}".head \
      /tmp/p9-smoke-rsc-"${TS}".html /tmp/p9-smoke-sub-"${TS}".json \
      /tmp/p9-smoke-dm-"${TS}".json

if [ "$FAIL_COUNT" -eq 0 ]; then
    ok "P9 SMOKE: PASS (20/20)"
    info "log: $LOG_FILE"
    exit 0
else
    fail "P9 SMOKE: FAIL — $FAIL_COUNT of 20 checks failed"
    info "log: $LOG_FILE"
    exit 1
fi
