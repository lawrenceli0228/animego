#!/usr/bin/env bash
# P9 preflight — runbook §7 (T-3d + T-1d operator checklists) automated.
#
# Catches operator mistakes BEFORE the cutover window opens. Every check
# either passes (OK), warns (recoverable, still proceeds), or fails (must
# fix before the next gate). Exit code reflects the FAIL count.
#
# Usage:
#   ./scripts/p9-preflight.sh                    # run everything (default)
#   ./scripts/p9-preflight.sh --t-3d             # only T-3d checks (1-13)
#   ./scripts/p9-preflight.sh --t-1d             # only T-1d checks (14-23)
#   ./scripts/p9-preflight.sh --all              # explicit all
#
# Env (T-1d checks require these; T-3d ignores them):
#   CF_API_TOKEN     Cloudflare API token (or --cf-token=...)
#   CF_ZONE_ID       Cloudflare zone ID  (or --cf-zone-id=...)
#   CF_RECORD_ID     A-record ID to flip (or --cf-record-id=...)
#   CI_AUTO=1        skip interactive prompts (auto-yes on confirmations)
#
# Exit codes:
#   0  — all selected checks PASS (warnings allowed)
#   1  — at least one FAIL — fix before next gate
#   2  — bad arguments / unable to start

set -euo pipefail

# --- repo root --------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- log file ---------------------------------------------------------
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="/tmp/p9-preflight-${TS}.log"

# --- color helpers (TTY-aware) ---------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    C_GREEN="$(tput setaf 2)"
    C_RED="$(tput setaf 1)"
    C_YELLOW="$(tput setaf 3)"
    C_BOLD="$(tput bold)"
    C_RESET="$(tput sgr0)"
else
    C_GREEN=""; C_RED=""; C_YELLOW=""; C_BOLD=""; C_RESET=""
fi

ok()   { printf "%s[OK]%s   %s\n"   "$C_GREEN"  "$C_RESET" "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
warn() { printf "%s[WARN]%s %s\n"   "$C_YELLOW" "$C_RESET" "$1"; WARN_COUNT=$((WARN_COUNT + 1)); }
fail() { printf "%s[FAIL]%s %s\n"   "$C_RED"    "$C_RESET" "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
info() { printf "%s[..]%s   %s\n"   "$C_BOLD"   "$C_RESET" "$1"; }

# Print a command before running it (mirrors p9-dry-run.sh style).
# Writes to stderr so callers can still capture command stdout via $(...).
show_cmd() { printf "%s[CMD]%s %s\n" "$C_BOLD" "$C_RESET" "$*" >&2; }

# Section header
section() {
    printf "\n%s========== %s ==========%s\n" "$C_BOLD" "$1" "$C_RESET"
}

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

# Tee both stdout AND stderr through the log AFTER the colors are set.
# show_cmd writes to stderr (so $(...) captures stay clean), so we have
# to tee both streams independently to land everything in the log.
exec > >(tee -a "$LOG_FILE")
exec 2> >(tee -a "$LOG_FILE" >&2)
info "logging to $LOG_FILE"

# --- args -------------------------------------------------------------
MODE="all"
CF_TOKEN="${CF_API_TOKEN:-}"
CF_ZONE="${CF_ZONE_ID:-}"
CF_RECORD="${CF_RECORD_ID:-}"
OLD_IP="45.152.65.208"
NEW_IP="45.145.228.171"
# SSH via ~/.ssh/config aliases. Old and new differ in BOTH port and key
# (old = 17776/id_rsa, new = 57777/id_ed25519_animego), so the previous
# single --ssh-port=57777 default silently broke every old-VPS check.
# Verified + fixed 2026-05-29.
OLD_HOST="animego-old"
NEW_HOST="animego-new"

for arg in "$@"; do
    case "$arg" in
        --t-3d)           MODE="t-3d" ;;
        --t-1d)           MODE="t-1d" ;;
        --all)            MODE="all" ;;
        --cf-token=*)     CF_TOKEN="${arg#--cf-token=}" ;;
        --cf-zone-id=*)   CF_ZONE="${arg#--cf-zone-id=}" ;;
        --cf-record-id=*) CF_RECORD="${arg#--cf-record-id=}" ;;
        --old-vps-ip=*)   OLD_IP="${arg#--old-vps-ip=}" ;;
        --new-vps-ip=*)   NEW_IP="${arg#--new-vps-ip=}" ;;
        --old-vps-host=*) OLD_HOST="${arg#--old-vps-host=}" ;;
        --new-vps-host=*) NEW_HOST="${arg#--new-vps-host=}" ;;
        --help|-h)
            cat <<EOF
usage: $0 [--t-3d | --t-1d | --all] [options]

modes:
  --t-3d         only run T-3d preflight checks (1-13) — before scheduling dry-run
  --t-1d         only run T-1d preflight checks (14-23) — day before cutover
  --all          run everything (default)

options:
  --cf-token=<token>        Cloudflare API token (env: CF_API_TOKEN)
  --cf-zone-id=<id>         Cloudflare zone ID    (env: CF_ZONE_ID)
  --cf-record-id=<id>       A-record ID to flip   (env: CF_RECORD_ID)
  --old-vps-ip=<ip>         default: 45.152.65.208 (CF A-record compare only)
  --new-vps-ip=<ip>         default: 45.145.228.171
  --old-vps-host=<alias>    default: animego-old (~/.ssh/config: 17776/id_rsa)
  --new-vps-host=<alias>    default: animego-new (~/.ssh/config: 57777/id_ed25519_animego)

env:
  CI_AUTO=1   skip interactive confirmations (auto-yes)

exit codes:
  0  all selected checks PASS (warnings allowed)
  1  at least one FAIL — fix before next gate
  2  bad arguments / unable to start
EOF
            exit 0
            ;;
        *) fail "unknown arg: $arg"; exit 2 ;;
    esac
done

info "mode: $MODE"

# --- SSH helper (centralised flags to keep checks short) -------------
ssh_old() {
    show_cmd "ssh $OLD_HOST '$*'"
    ssh -o ConnectTimeout=10 "$OLD_HOST" "$@"
}
ssh_new() {
    show_cmd "ssh $NEW_HOST '$*'"
    ssh -o ConnectTimeout=10 "$NEW_HOST" "$@"
}

# --- confirm helper (CI_AUTO=1 → auto-yes) ---------------------------
confirm() {
    local prompt="$1"
    if [ "${CI_AUTO:-0}" = "1" ]; then
        info "CI_AUTO=1 — auto-yes for: $prompt"
        return 0
    fi
    local reply
    read -p "$prompt (y/N) " -r reply
    [[ "$reply" =~ ^[Yy]$ ]]
}

# ======================================================================
# T-3d preflight (checks 1-13)
# ======================================================================
run_t_3d() {
    section "T-3d preflight (checks 1-13)"

    # ---- 1. Local docker daemon up ----
    info "CHECK 1/13 — local docker daemon"
    show_cmd "docker info >/dev/null"
    if docker info >/dev/null 2>&1; then
        ok "docker daemon reachable"
    else
        fail "docker daemon not reachable — start Docker Desktop / colima"
    fi

    # ---- 2. .env.production exists + POSTGRES_PASSWORD set ----
    info "CHECK 2/13 — .env.production + POSTGRES_PASSWORD"
    local env_file="$REPO_ROOT/.env.production"
    if [ ! -f "$env_file" ]; then
        fail ".env.production not found at $env_file"
    else
        local pg_pass
        pg_pass="$(grep -E '^POSTGRES_PASSWORD=' "$env_file" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
        if [ -z "$pg_pass" ]; then
            fail "POSTGRES_PASSWORD missing or empty in .env.production"
        else
            ok ".env.production present + POSTGRES_PASSWORD set (length=${#pg_pass})"
        fi
    fi

    # ---- 3. SSH to old VPS ----
    info "CHECK 3/13 — SSH to old VPS ($OLD_IP)"
    local who
    if who="$(ssh_old 'whoami' 2>/dev/null)" && [ "$who" = "root" ]; then
        ok "old VPS SSH OK (whoami=root)"
    else
        fail "old VPS SSH failed (got: '$who')"
    fi

    # ---- 4. SSH to new VPS ----
    info "CHECK 4/13 — SSH to new VPS ($NEW_IP)"
    if who="$(ssh_new 'whoami' 2>/dev/null)" && [ "$who" = "root" ]; then
        ok "new VPS SSH OK (whoami=root)"
    else
        fail "new VPS SSH failed (got: '$who')"
    fi

    # ---- 5. Old VPS has /opt/animego + docker-compose.yml + mongodb running ----
    info "CHECK 5/13 — old VPS /opt/animego stack present + mongodb running"
    local old_ps
    if old_ps="$(ssh_old 'cd /opt/animego && ls docker-compose.yml >/dev/null 2>&1 && docker compose ps mongodb' 2>&1)"; then
        if echo "$old_ps" | grep -qE '(Up|running|healthy)'; then
            ok "old VPS mongodb container is Up"
        else
            fail "old VPS mongodb container NOT Up — output: $(echo "$old_ps" | tail -1)"
        fi
    else
        fail "old VPS /opt/animego missing or compose failed"
    fi

    # ---- 6. Mongo container responds to ping ----
    info "CHECK 6/13 — old VPS mongo ping"
    local ping_resp
    ping_resp="$(ssh_old 'cd /opt/animego && docker compose exec -T mongodb mongosh --quiet --eval "db.runCommand({ping:1})"' 2>&1 || true)"
    if echo "$ping_resp" | grep -qE '"?ok"?\s*:\s*1'; then
        ok "mongo ping returned ok:1"
    else
        fail "mongo ping did not return ok:1 — got: $(echo "$ping_resp" | tail -3 | tr '\n' ' ')"
    fi

    # ---- 7. Mongo dataSize estimate (timing helper, never fails) ----
    info "CHECK 7/13 — estimate mongo dataSize (timing helper)"
    local stats
    stats="$(ssh_old 'cd /opt/animego && docker compose exec -T mongodb mongosh --quiet --eval "JSON.stringify(db.stats())"' 2>&1 || true)"
    # mongosh prefixes/suffixes occasionally; extract the JSON line.
    local json
    json="$(printf '%s\n' "$stats" | grep -oE '\{.*"dataSize".*\}' | head -1 || true)"
    if [ -n "$json" ]; then
        # python is the most portable JSON parser on macOS/Linux without jq.
        local mb
        mb="$(printf '%s' "$json" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(round(d.get("dataSize",0)/1024/1024,1))' 2>/dev/null || echo "?")"
        ok "mongo dataSize ≈ ${mb} MB (allow ~1 min dump per 100 MB)"
    else
        warn "could not parse db.stats() — manual check: ssh + mongosh db.stats()"
    fi

    # ---- 8. New VPS disk free > 5GB ----
    info "CHECK 8/13 — new VPS disk free"
    local new_avail
    new_avail="$(ssh_new 'df -BG --output=avail / | tail -1' 2>/dev/null | tr -d ' G' || echo "0")"
    if [ -n "$new_avail" ] && [ "$new_avail" -gt 5 ] 2>/dev/null; then
        ok "new VPS / has ${new_avail}G free"
    else
        fail "new VPS / has only ${new_avail}G free (need > 5G)"
    fi

    # ---- 9. Old VPS disk free > 5GB ----
    info "CHECK 9/13 — old VPS disk free"
    local old_avail
    old_avail="$(ssh_old 'df -BG --output=avail / | tail -1' 2>/dev/null | tr -d ' G' || echo "0")"
    if [ -n "$old_avail" ] && [ "$old_avail" -gt 5 ] 2>/dev/null; then
        ok "old VPS / has ${old_avail}G free"
    else
        fail "old VPS / has only ${old_avail}G free (need > 5G for dump)"
    fi

    # ---- 10. default.maintenance.conf exists + matches HEAD ----
    info "CHECK 10/13 — nginx/default.maintenance.conf vs HEAD"
    local mc="$REPO_ROOT/nginx/default.maintenance.conf"
    if [ ! -f "$mc" ]; then
        fail "$mc missing"
    else
        local disk_sha head_sha
        disk_sha="$(shasum -a 256 "$mc" | awk '{print $1}')"
        head_sha="$(cd "$REPO_ROOT" && git show HEAD:nginx/default.maintenance.conf 2>/dev/null | shasum -a 256 | awk '{print $1}' || echo "")"
        if [ -z "$head_sha" ] || [ "$head_sha" = "$(printf '' | shasum -a 256 | awk '{print $1}')" ]; then
            fail "nginx/default.maintenance.conf not committed to HEAD"
        elif [ "$disk_sha" = "$head_sha" ]; then
            ok "default.maintenance.conf matches HEAD"
        else
            fail "default.maintenance.conf differs from HEAD — commit or revert (disk=${disk_sha:0:8} head=${head_sha:0:8})"
        fi
    fi

    # ---- 11. default.legacy.conf on disk + committed ----
    info "CHECK 11/13 — nginx/default.legacy.conf present + committed"
    local lc="$REPO_ROOT/nginx/default.legacy.conf"
    if [ ! -f "$lc" ]; then
        fail "$lc missing on disk"
    elif ! (cd "$REPO_ROOT" && git cat-file -e "HEAD:nginx/default.legacy.conf" 2>/dev/null); then
        fail "nginx/default.legacy.conf not committed to HEAD"
    else
        ok "default.legacy.conf present + committed"
    fi

    # ---- 12. smoke-p8.1.sh exists + executable ----
    info "CHECK 12/13 — scripts/smoke-p8.1.sh exists + executable"
    local smoke="$REPO_ROOT/scripts/smoke-p8.1.sh"
    if [ ! -f "$smoke" ]; then
        fail "$smoke missing"
    elif [ ! -x "$smoke" ]; then
        fail "$smoke not executable (chmod +x)"
    else
        ok "smoke-p8.1.sh present + executable"
    fi

    # ---- 13. p9-{dry-run,smoke,rollback}.sh exist + executable ----
    info "CHECK 13/13 — p9-dry-run.sh / p9-smoke.sh / p9-rollback.sh exist + executable"
    local missing=0
    for s in p9-dry-run.sh p9-smoke.sh p9-rollback.sh; do
        local p="$REPO_ROOT/scripts/$s"
        if [ ! -f "$p" ]; then
            warn "$s missing"
            missing=1
        elif [ ! -x "$p" ]; then
            warn "$s not executable"
            missing=1
        fi
    done
    if [ "$missing" -eq 0 ]; then
        ok "all three p9 scripts present + executable"
    else
        fail "one or more p9 scripts missing/not-executable (see warns above)"
    fi
}

# ======================================================================
# T-1d preflight (checks 14-23)
# ======================================================================
run_t_1d() {
    section "T-1d preflight (checks 14-23)"

    # ---- 14. Dry-run gate passed (log file < 7d, or operator confirms) ----
    info "CHECK 14/23 — dry-run gate passed"
    local recent_log
    # Find any p9-dry-run-*.log modified in the last 7 days that contains "GATE: PASS".
    recent_log="$(find /tmp -maxdepth 1 -name 'p9-dry-run-*.log' -mtime -7 -print 2>/dev/null \
                 | xargs grep -l 'DRY-RUN GATE: PASS' 2>/dev/null | head -1 || true)"
    if [ -n "$recent_log" ]; then
        ok "found PASS log: $recent_log"
    else
        warn "no PASS log in /tmp from the last 7 days"
        if confirm "did the T-3d dry-run pass and you have the log?"; then
            ok "operator confirms dry-run gate passed"
        else
            fail "dry-run gate NOT confirmed — run scripts/p9-dry-run.sh first"
        fi
    fi

    # ---- 15. CF API token works ----
    info "CHECK 15/23 — Cloudflare token verify"
    if [ -z "$CF_TOKEN" ]; then
        fail "CF_API_TOKEN missing (set env or --cf-token=)"
    else
        local tok_body tok_code
        tok_body="/tmp/p9-preflight-cf-tok-${TS}.json"
        show_cmd "curl -sH 'Authorization: Bearer ***' https://api.cloudflare.com/client/v4/user/tokens/verify"
        tok_code="$(curl -s -o "$tok_body" -w "%{http_code}" \
            -H "Authorization: Bearer ${CF_TOKEN}" \
            https://api.cloudflare.com/client/v4/user/tokens/verify || echo "000")"
        if [ "$tok_code" = "200" ] && grep -q '"status":"active"' "$tok_body"; then
            ok "CF token active"
        else
            fail "CF token verify failed (HTTP $tok_code): $(head -c 200 "$tok_body")"
        fi
    fi

    # ---- 16. CF zone ID resolves ----
    info "CHECK 16/23 — Cloudflare zone resolves"
    if [ -z "$CF_TOKEN" ] || [ -z "$CF_ZONE" ]; then
        fail "CF_API_TOKEN + CF_ZONE_ID required"
    else
        local z_body z_code
        z_body="/tmp/p9-preflight-cf-zone-${TS}.json"
        show_cmd "curl -sH 'Authorization: Bearer ***' https://api.cloudflare.com/client/v4/zones/${CF_ZONE}"
        z_code="$(curl -s -o "$z_body" -w "%{http_code}" \
            -H "Authorization: Bearer ${CF_TOKEN}" \
            "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}" || echo "000")"
        if [ "$z_code" = "200" ] && grep -q '"success":true' "$z_body"; then
            ok "CF zone reachable"
        else
            fail "CF zone GET failed (HTTP $z_code): $(head -c 200 "$z_body")"
        fi
    fi

    # ---- 17. CF DNS record exists + currently points at old VPS ----
    info "CHECK 17/23 — Cloudflare A-record points at old VPS"
    if [ -z "$CF_TOKEN" ] || [ -z "$CF_ZONE" ] || [ -z "$CF_RECORD" ]; then
        fail "CF_API_TOKEN + CF_ZONE_ID + CF_RECORD_ID all required"
    else
        local r_body r_code
        r_body="/tmp/p9-preflight-cf-rec-${TS}.json"
        show_cmd "curl -sH 'Authorization: Bearer ***' https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records/${CF_RECORD}"
        r_code="$(curl -s -o "$r_body" -w "%{http_code}" \
            -H "Authorization: Bearer ${CF_TOKEN}" \
            "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records/${CF_RECORD}" || echo "000")"
        if [ "$r_code" = "200" ] && grep -q '"success":true' "$r_body"; then
            local content
            content="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["content"])' < "$r_body" 2>/dev/null || echo "")"
            if [ "$content" = "$OLD_IP" ]; then
                ok "A-record currently points at old VPS ($content)"
            else
                fail "A-record points at '$content', expected '$OLD_IP'"
            fi
        else
            fail "CF DNS record GET failed (HTTP $r_code)"
        fi
    fi

    # ---- 18. New VPS git on origin/feat/go-backend HEAD ----
    info "CHECK 18/23 — new VPS git on origin/feat/go-backend HEAD"
    local local_sha remote_sha
    local_sha="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")"
    remote_sha="$(ssh_new 'cd /opt/animego && git fetch origin feat/go-backend --quiet 2>/dev/null; git rev-parse HEAD' 2>/dev/null || echo "")"
    if [ -z "$local_sha" ] || [ -z "$remote_sha" ]; then
        fail "could not read git HEAD (local=$local_sha remote=$remote_sha)"
    elif [ "$local_sha" = "$remote_sha" ]; then
        ok "new VPS HEAD matches local ($local_sha)"
    else
        fail "new VPS HEAD ($remote_sha) differs from local ($local_sha) — push + pull on VPS"
    fi

    # ---- 19. New VPS docker images recent (warn-only) ----
    info "CHECK 19/23 — new VPS animego-go-api image age"
    local image_age
    image_age="$(ssh_new "docker images animego-go-api --format '{{.CreatedSince}}' | head -1" 2>/dev/null || echo "")"
    if [ -z "$image_age" ]; then
        fail "no animego-go-api image on new VPS — run docker compose build"
    elif echo "$image_age" | grep -qE 'years?|months?|weeks? ago' && ! echo "$image_age" | grep -qE '^1 weeks? ago$'; then
        warn "animego-go-api image is OLD: $image_age (rebuild recommended)"
    else
        ok "animego-go-api image age: $image_age"
    fi

    # ---- 20. New VPS postgres healthy ----
    info "CHECK 20/23 — new VPS postgres healthy"
    local pg_ps
    pg_ps="$(ssh_new 'cd /opt/animego && docker compose ps postgres' 2>&1 || true)"
    if echo "$pg_ps" | grep -qi 'healthy'; then
        ok "new VPS postgres is healthy"
    elif echo "$pg_ps" | grep -qE '(Up|running)'; then
        warn "new VPS postgres is Up but no healthy marker — may have no healthcheck"
    else
        fail "new VPS postgres NOT Up — last line: $(echo "$pg_ps" | tail -1)"
    fi

    # ---- 21. New VPS PG schema migrations applied (>= 15 tables) ----
    info "CHECK 21/23 — new VPS PG migrations applied"
    # Expected app tables (14 from go-api/migrations/0001+; system River tables add 3 more).
    # We assert >= 15 to keep a margin while making sure the schema is real, not empty.
    local expected_tables="users subscriptions follows danmakus episode_comments episode_windows anime_cache anime_genres anime_studios anime_characters anime_staff anime_relations anime_recommendations anime_episode_titles"
    local tbl_out tbl_count
    tbl_out="$(ssh_new 'cd /opt/animego && docker compose exec -T postgres psql -U animego -d animego -c "\\dt" -At' 2>&1 || true)"
    tbl_count="$(printf '%s\n' "$tbl_out" | grep -cE '^\s*public\|' || true)"
    if [ "${tbl_count:-0}" -ge 15 ] 2>/dev/null; then
        ok "PG has ${tbl_count} tables (>= 15)"
        # Spot-check a few must-have app tables; warn (not fail) on any miss.
        local missing_tbls=""
        for t in $expected_tables; do
            if ! printf '%s\n' "$tbl_out" | grep -qE "^\s*public\|${t}\b"; then
                missing_tbls="${missing_tbls} $t"
            fi
        done
        if [ -n "$missing_tbls" ]; then
            warn "expected app table(s) NOT found:${missing_tbls}"
        fi
    else
        fail "PG has only ${tbl_count} tables (need >= 15) — run migrations"
    fi

    # ---- 22. REGISTER_DISABLED present in old VPS .env.production ----
    info "CHECK 22/23 — REGISTER_DISABLED on old VPS"
    if ssh_old 'grep -E "^REGISTER_DISABLED=" /opt/animego/.env.production' >/dev/null 2>&1; then
        ok "REGISTER_DISABLED set on old VPS .env.production"
    else
        fail "REGISTER_DISABLED missing — append and restart app (runbook §3 T-1d step 2)"
    fi

    # ---- 23. Maintenance banner deployed (curl + operator confirm) ----
    info "CHECK 23/23 — site banner '维护' visible"
    local banner_body banner_code
    banner_body="/tmp/p9-preflight-banner-${TS}.html"
    show_cmd "curl -ks -o $banner_body -w '%{http_code}' https://animegoclub.com/"
    banner_code="$(curl -ks -o "$banner_body" -w '%{http_code}' --max-time 15 https://animegoclub.com/ || echo "000")"
    if [ "$banner_code" = "200" ] && grep -q '维护' "$banner_body" 2>/dev/null; then
        ok "banner '维护' found in homepage HTML"
    else
        warn "banner '维护' not found in homepage HTML (HTTP $banner_code) — string may be wrapped in JS chunk"
        if confirm "have you visually confirmed the maintenance banner is live?"; then
            ok "operator confirms banner deployed"
        else
            fail "banner not confirmed — deploy banner before cutover"
        fi
    fi
}

# ======================================================================
# main
# ======================================================================
case "$MODE" in
    t-3d) run_t_3d ;;
    t-1d) run_t_1d ;;
    all)  run_t_3d; run_t_1d ;;
    *)    fail "unknown mode: $MODE"; exit 2 ;;
esac

# ======================================================================
# SUMMARY
# ======================================================================
section "SUMMARY (mode=$MODE)"
printf "passed:   %d\n" "$PASS_COUNT"
printf "warnings: %d\n" "$WARN_COUNT"
printf "failed:   %d\n" "$FAIL_COUNT"
info "log: $LOG_FILE"

if [ "$FAIL_COUNT" -eq 0 ]; then
    ok "P9 PREFLIGHT ($MODE): PASS"
    exit 0
else
    fail "P9 PREFLIGHT ($MODE): FAIL — $FAIL_COUNT check(s) failed, do NOT proceed to next gate"
    exit 1
fi
