#!/usr/bin/env bash
# scripts/measure-tthw.sh — measure Time-To-Hello-World for dev.sh.
#
# Eng review C2 correction: time(1) on dev.sh measures user Ctrl+C time
# (dev.sh ends with `wait`), not the magical moment.  Instead, dev.sh
# writes /tmp/animego-dev-up.txt the instant :8080/health responds.
# This script polls for that marker and reports wall-clock seconds.
#
# Target: < 300s (5 min) on M1/M2 Mac with warm caches.
# First-clone (cold Docker pull + bun install) may exceed — see §8 TODO #5.

set -euo pipefail
cd "$(dirname "$0")/.."

MARKER=/tmp/animego-dev-up.txt
TARGET_SEC=300
TIMEOUT_SEC=600

rm -f "$MARKER"

echo "[measure-tthw] starting dev.sh in background..."
START=$(date +%s)
bash scripts/dev.sh &
DEV_PID=$!

trap 'kill $DEV_PID 2>/dev/null || true' EXIT

for i in $(seq 1 "$TIMEOUT_SEC"); do
    if [ -f "$MARKER" ]; then
        END=$(date +%s)
        TTHW=$(( END - START ))
        echo ""
        echo "═══════════════════════════════════════════════"
        printf "  TTHW = %ds (%dm %ds)\n" "$TTHW" "$((TTHW/60))" "$((TTHW%60))"
        echo "  Target: < ${TARGET_SEC}s (M1/M2 warm-cache)"
        if [ "$TTHW" -lt "$TARGET_SEC" ]; then
            echo "  Result: PASS"
        else
            echo "  Result: MISS — see §8 TODO Eng review #5 (warm vs cold)"
        fi
        echo "═══════════════════════════════════════════════"
        echo ""
        echo "dev.sh still running with PID $DEV_PID.  Ctrl+C this script"
        echo "to stop it, or 'kill $DEV_PID' from another terminal."
        # Hand control back; dev.sh runs until user stops.
        trap - EXIT
        wait $DEV_PID
        exit 0
    fi
    sleep 1
done

echo "" >&2
echo "TIMEOUT: dev.sh did not write $MARKER within ${TIMEOUT_SEC}s." >&2
echo "Check [dev] / [go-api] output above for build errors." >&2
exit 1
