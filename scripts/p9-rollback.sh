#!/usr/bin/env bash
# P9 rollback — runbook §5 decision-tree execution.
#
# Three minutes from "we're rolling back" to "DNS points at old VPS,
# new VPS is in maintenance mode, old stack is healthy".
#
# Usage:
#   ./scripts/p9-rollback.sh --reason="login broken 5%/min"
#
#   Optional (defaults shown):
#     --cf-token=$CF_API_TOKEN
#     --cf-zone-id=$CF_ZONE_ID
#     --cf-record-id=$CF_RECORD_ID
#     --old-vps-ip=45.152.65.208
#     --old-vps-ssh-port=57777
#     --new-vps-ip=45.145.228.171
#     --new-vps-ssh-port=57777
#
# Env:
#   CI_AUTO=1   skip y/N confirmation (use carefully)
#
# Exit codes:
#   0  — DNS flipped + old VPS healthy + new VPS in maintenance
#   1  — any step failed; partial state described in log
#   2  — bad args / preflight

set -euo pipefail

# --- log files --------------------------------------------------------
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="/tmp/p9-rollback-${TS}.log"
# Audit log — runbook §5 calls this out explicitly so each rollback
# leaves a permanent breadcrumb beyond the per-run /tmp logs.
AUDIT_LOG="/tmp/p9-rollback.log"

# --- colors -----------------------------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    C_GREEN="$(tput setaf 2)"
    C_RED="$(tput setaf 1)"
    C_YELLOW="$(tput setaf 3)"
    C_BG_RED="$(tput setab 1)"
    C_WHITE="$(tput setaf 7)"
    C_BOLD="$(tput bold)"
    C_RESET="$(tput sgr0)"
else
    C_GREEN=""; C_RED=""; C_YELLOW=""; C_BG_RED=""; C_WHITE=""; C_BOLD=""; C_RESET=""
fi

ok()   { printf "%s[OK]%s   %s\n"   "$C_GREEN"  "$C_RESET" "$1"; }
warn() { printf "%s[WARN]%s %s\n"   "$C_YELLOW" "$C_RESET" "$1"; }
fail() { printf "%s[FAIL]%s %s\n"   "$C_RED"    "$C_RESET" "$1"; }
info() { printf "%s[..]%s   %s\n"   "$C_BOLD"   "$C_RESET" "$1"; }

exec > >(tee -a "$LOG_FILE") 2>&1
info "logging to $LOG_FILE"
info "audit log: $AUDIT_LOG"

# --- args --------------------------------------------------------------
REASON=""
CF_TOKEN="${CF_API_TOKEN:-}"
CF_ZONE="${CF_ZONE_ID:-}"
CF_RECORD="${CF_RECORD_ID:-}"
OLD_IP="45.152.65.208"
OLD_PORT="57777"
NEW_IP="45.145.228.171"
NEW_PORT="57777"

for arg in "$@"; do
    case "$arg" in
        --reason=*)           REASON="${arg#--reason=}" ;;
        --cf-token=*)         CF_TOKEN="${arg#--cf-token=}" ;;
        --cf-zone-id=*)       CF_ZONE="${arg#--cf-zone-id=}" ;;
        --cf-record-id=*)     CF_RECORD="${arg#--cf-record-id=}" ;;
        --old-vps-ip=*)       OLD_IP="${arg#--old-vps-ip=}" ;;
        --old-vps-ssh-port=*) OLD_PORT="${arg#--old-vps-ssh-port=}" ;;
        --new-vps-ip=*)       NEW_IP="${arg#--new-vps-ip=}" ;;
        --new-vps-ssh-port=*) NEW_PORT="${arg#--new-vps-ssh-port=}" ;;
        --help|-h)
            printf "usage: %s --reason=\"<text>\" [--cf-token=... --cf-zone-id=... --cf-record-id=...] [--old-vps-ip=...] [--new-vps-ip=...]\n" "$0"
            exit 0
            ;;
        *) fail "unknown arg: $arg"; exit 2 ;;
    esac
done

if [ -z "$REASON" ]; then
    fail "--reason=\"<short text>\" is required (logged for post-mortem)"
    exit 2
fi
if [ -z "$CF_TOKEN" ] || [ -z "$CF_ZONE" ] || [ -z "$CF_RECORD" ]; then
    fail "Cloudflare creds missing — need --cf-token + --cf-zone-id + --cf-record-id (or CF_API_TOKEN/CF_ZONE_ID/CF_RECORD_ID env)"
    exit 2
fi

# ======================================================================
# BANNER
# ======================================================================
printf "\n"
printf "%s%s%s                                                                 %s\n" "$C_BG_RED" "$C_WHITE" "$C_BOLD" "$C_RESET"
printf "%s%s%s   P9 ROLLBACK INITIATED                                          %s\n" "$C_BG_RED" "$C_WHITE" "$C_BOLD" "$C_RESET"
printf "%s%s%s   reason: %-55s%s\n" "$C_BG_RED" "$C_WHITE" "$C_BOLD" "$REASON" "$C_RESET"
printf "%s%s%s   timestamp: %s                          %s\n" "$C_BG_RED" "$C_WHITE" "$C_BOLD" "$TS" "$C_RESET"
printf "%s%s%s                                                                 %s\n" "$C_BG_RED" "$C_WHITE" "$C_BOLD" "$C_RESET"
printf "\n"

# --- audit log entry (permanent) --------------------------------------
printf "%s\trollback initiated\treason=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REASON" >> "$AUDIT_LOG"

# ======================================================================
# CONFIRMATION
# ======================================================================
confirm() {
    local action="$1"
    printf "%s[ABOUT TO]%s %s\n" "$C_YELLOW" "$C_RESET" "$action"
    if [ "${CI_AUTO:-0}" = "1" ]; then
        info "CI_AUTO=1 — auto-continuing"
        return 0
    fi
    sleep 3
    local reply
    read -p "Continue? (y/N) " -r reply
    if [[ ! "$reply" =~ ^[Yy]$ ]]; then
        fail "user aborted rollback at: $action"
        printf "%s\trollback aborted at: %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$action" >> "$AUDIT_LOG"
        exit 1
    fi
}

confirm "execute full rollback — flip DNS, restart nginx on both VPSes"

ANY_FAIL=0

# ======================================================================
# STEP 1 — Cloudflare API: PATCH A record back to old VPS
# ======================================================================
info "STEP 1/4 — Cloudflare PATCH A record -> $OLD_IP"

CF_URL="https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records/${CF_RECORD}"
CF_PAYLOAD="$(printf '{"content":"%s","ttl":60}' "$OLD_IP")"

# Print the command we're about to run (with token masked so the operator
# can copy-paste if the script aborts).
printf "%s[CMD]%s curl -X PATCH '%s' -H 'Authorization: Bearer ***' -H 'Content-Type: application/json' --data '%s'\n" \
    "$C_BOLD" "$C_RESET" "$CF_URL" "$CF_PAYLOAD"

CF_RESP_FILE="/tmp/p9-rollback-cf-${TS}.json"
CF_CODE="$(curl -s \
    -o "$CF_RESP_FILE" \
    -w "%{http_code}" \
    -X PATCH "$CF_URL" \
    -H "Authorization: Bearer ${CF_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$CF_PAYLOAD" || echo "000")"

info "CF API response (HTTP $CF_CODE):"
cat "$CF_RESP_FILE" || true
printf "\n"

if [ "$CF_CODE" = "200" ]; then
    # Verify CF says success=true
    if grep -q '"success":true' "$CF_RESP_FILE" 2>/dev/null; then
        ok "DNS A record flipped to $OLD_IP (TTL 60s)"
    else
        fail "CF returned 200 but success!=true — check the JSON above"
        ANY_FAIL=1
    fi
else
    fail "CF API returned HTTP $CF_CODE"
    warn "MANUAL FALLBACK: run the curl above with the real token, or use the Cloudflare dashboard"
    ANY_FAIL=1
fi

printf "%s\tCF PATCH\tHTTP=%s\tip=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CF_CODE" "$OLD_IP" >> "$AUDIT_LOG"

# ======================================================================
# STEP 2 — verify old VPS stack is healthy
# ======================================================================
info "STEP 2/4 — verify old VPS ($OLD_IP) stack is healthy"

OLD_SSH=(ssh -p "$OLD_PORT" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "root@${OLD_IP}")
printf "%s[CMD]%s %s 'cd /opt/animego && docker compose ps'\n" "$C_BOLD" "$C_RESET" "${OLD_SSH[*]}"

OLD_PS="/tmp/p9-rollback-old-ps-${TS}.txt"
if "${OLD_SSH[@]}" 'cd /opt/animego && docker compose ps' > "$OLD_PS" 2>&1; then
    cat "$OLD_PS"
    # Look for at least app + mongodb in "Up"/"running" state.
    APP_UP="$(grep -E '^(app|next-app)' "$OLD_PS" | grep -cE '(Up|running|healthy)' || true)"
    MONGO_UP="$(grep -E '^mongodb' "$OLD_PS" | grep -cE '(Up|running|healthy)' || true)"
    if [ "${APP_UP:-0}" -ge 1 ] && [ "${MONGO_UP:-0}" -ge 1 ]; then
        ok "old VPS: app + mongodb running"
    else
        fail "old VPS: app or mongodb NOT in Up state — DNS now points at a broken stack"
        warn "MANUAL: SSH in and start the old stack:"
        warn "  ${OLD_SSH[*]} 'cd /opt/animego && docker compose up -d'"
        ANY_FAIL=1
    fi
else
    fail "ssh to old VPS failed — could not verify health"
    warn "MANUAL: ${OLD_SSH[*]} 'cd /opt/animego && docker compose ps'"
    ANY_FAIL=1
fi

# Per runbook §5 step 2 (and decision matrix), if the old VPS is still
# in maintenance mode from the cutover dry-run, swap it back to legacy.
# We don't know the current state remotely, so we attempt the swap and
# tolerate the "already legacy" case (it's a plain cp + restart).
info "ensuring old VPS nginx is on default.legacy.conf"
printf "%s[CMD]%s %s 'cd /opt/animego && cp nginx/default.legacy.conf nginx/default.conf && docker compose restart nginx'\n" \
    "$C_BOLD" "$C_RESET" "${OLD_SSH[*]}"
if "${OLD_SSH[@]}" 'cd /opt/animego && cp nginx/default.legacy.conf nginx/default.conf && docker compose restart nginx'; then
    ok "old VPS nginx restored to legacy config"
else
    fail "old VPS nginx restart failed — check legacy.conf exists or whether nginx is even running"
    ANY_FAIL=1
fi

printf "%s\told VPS verify\tapp_up=%s\tmongo_up=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${APP_UP:-?}" "${MONGO_UP:-?}" >> "$AUDIT_LOG"

# ======================================================================
# STEP 3 — new VPS: put nginx in maintenance mode
# ======================================================================
info "STEP 3/4 — new VPS ($NEW_IP) into maintenance mode"

NEW_SSH=(ssh -p "$NEW_PORT" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "root@${NEW_IP}")
NEW_CMD='cd /opt/animego && cp nginx/default.maintenance.conf nginx/default.conf && docker compose restart nginx'

printf "%s[CMD]%s %s '%s'\n" "$C_BOLD" "$C_RESET" "${NEW_SSH[*]}" "$NEW_CMD"
confirm "swap new VPS nginx to maintenance.conf and restart nginx"

if "${NEW_SSH[@]}" "$NEW_CMD"; then
    ok "new VPS nginx now serving maintenance.html (503 for ISP-cached clients)"
else
    fail "new VPS maintenance swap failed"
    warn "MANUAL: ${NEW_SSH[*]} '$NEW_CMD'"
    ANY_FAIL=1
fi

printf "%s\tnew VPS maintenance\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$AUDIT_LOG"

# ======================================================================
# STEP 4 — data loss warning + post-rollback checklist
# ======================================================================
printf "\n"
printf "%s%s========== DATA LOSS WARNING ==========%s\n" "$C_RED" "$C_BOLD" "$C_RESET"
printf "%sAll writes to the NEW stack between T+0 DNS flip and now are LOST.%s\n" "$C_YELLOW" "$C_RESET"
printf "%sReason: new PG data cannot flow back into the old Mongo schema.%s\n" "$C_YELLOW" "$C_RESET"
printf "%sRunbook §5 estimate: <100 writes lost if rollback within 30 min of cutover.%s\n" "$C_YELLOW" "$C_RESET"
printf "\n"

printf "%s========== POST-ROLLBACK CHECKLIST ==========%s\n" "$C_BOLD" "$C_RESET"
cat <<EOF
[ ] Post site banner: "维护期间提交的数据未保存,请重试"
    (next-app/src/app/layout.tsx, commit + push + deploy on OLD VPS)

[ ] Audit Postgres writes that won't be retained — for forensics, not recovery:
    $ ${NEW_SSH[*]} 'cd /opt/animego && docker compose exec -T postgres psql -U animego -d animego \\
        -c "SELECT table_schema, table_name, n_tup_ins FROM pg_stat_user_tables ORDER BY n_tup_ins DESC LIMIT 20;"'

[ ] Verify public DNS has propagated (5-10 min for ISP caches):
    $ dig +short animegoclub.com   # should return ${OLD_IP}
    $ curl -sk -o /dev/null -w "%{http_code}\\n" https://animegoclub.com/api/health

[ ] Tail old VPS access log for 5xx to confirm traffic is healthy:
    $ ${OLD_SSH[*]} 'cd /opt/animego && docker compose logs -f --tail=100 nginx | grep -E " (5\\d{2}) "'

[ ] Notify any users who reported data loss (handle case by case)

[ ] Open RCA issue with reason="${REASON}" + link to $LOG_FILE

[ ] DO NOT immediately re-attempt cutover. Diagnose root cause first.

[ ] Once root cause is known, re-schedule a new T-3d dry-run gate.
EOF
printf "\n"

# ======================================================================
# DONE
# ======================================================================
if [ "$ANY_FAIL" -eq 0 ]; then
    ok "P9 ROLLBACK: COMPLETE — DNS flipped, old VPS legacy, new VPS in maintenance"
    info "log: $LOG_FILE"
    info "audit: $AUDIT_LOG"
    printf "%s\trollback complete\tstatus=ok\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$AUDIT_LOG"
    exit 0
else
    fail "P9 ROLLBACK: PARTIAL — at least one step needs manual follow-up (see warnings above)"
    info "log: $LOG_FILE"
    info "audit: $AUDIT_LOG"
    printf "%s\trollback complete\tstatus=partial\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$AUDIT_LOG"
    exit 1
fi
