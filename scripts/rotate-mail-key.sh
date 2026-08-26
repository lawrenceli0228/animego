#!/usr/bin/env bash
# Rotate the transactional-email API key on the production VPS.
#
# Run this in YOUR OWN terminal, not through an assistant: the key is read
# with `read -s`, so it is never echoed, never lands in shell history, and
# never appears in a transcript.
#
#   ./scripts/rotate-mail-key.sh
#
# ORDER MATTERS, AND THE WRONG ORDER FAILS SILENTLY
#
# Create the new key first, let this script verify and install it, and only
# revoke the old one afterwards. Revoking first leaves a window where sending
# is broken — and broken sending is invisible from outside, because
# forgot-password returns 200 whether or not the mail went out (it must, to
# avoid confirming which addresses are registered). Nobody would notice until
# a reader complained.
#
# This script therefore proves the new key can actually send BEFORE writing
# it anywhere.

set -euo pipefail

# No defaults for the host or the port, on purpose. This repo is public, and
# the origin address is not decoration: the box only accepts 80/443 from
# Cloudflare's ranges, and that rule is worth more when the address behind it
# is not trivially greppable. A convenience default here would hand it over in
# exchange for saving one export.
#
# Put them in your shell profile or an ssh_config Host alias instead:
#   export VPS_HOST=… VPS_PORT=…
VPS_HOST="${VPS_HOST:?需要 VPS_HOST(不写死在这里 —— 仓库是公开的)}"
VPS_PORT="${VPS_PORT:?需要 VPS_PORT}"
APP_DIR="${APP_DIR:-/opt/animego}"
MAIL_FROM="${MAIL_FROM:-animegoanime@animegoclub.com}"
ENV_FILE="$APP_DIR/.env.production"

ssh_vps() { ssh -p "$VPS_PORT" -o ConnectTimeout=20 "root@$VPS_HOST" "$@"; }

printf '新的 Resend API key (输入不回显): '
read -rs NEW_KEY
printf '\n'

[ -n "$NEW_KEY" ] || { echo "✗ 没有输入" >&2; exit 1; }
case "$NEW_KEY" in
  re_*) ;;
  *) echo "✗ 不像 Resend 的 key(应以 re_ 开头)。没有写入任何东西。" >&2; exit 1 ;;
esac

# ── 1. Prove it works before touching production ────────────────────────────
#
# A key that cannot send is the failure this whole script exists to avoid, and
# it is indistinguishable from success once installed. Find out here instead.
printf '收测试信的地址: '
read -r TEST_TO
[ -n "$TEST_TO" ] || { echo "✗ 需要一个地址来验证新 key" >&2; exit 1; }

echo "==> 用新 key 试发一封…"
resp=$(curl -s -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $NEW_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"from\":\"AnimeGo <$MAIL_FROM>\",\"to\":[\"$TEST_TO\"],\"subject\":\"AnimeGo key 轮换验证\",\"html\":\"<p>新的 API key 可以发信。收到这封之后再去 revoke 旧 key。</p>\"}")

if ! printf '%s' "$resp" | grep -q '"id"'; then
  echo "✗ 新 key 发不出去,生产环境没有被改动:" >&2
  printf '   %s\n' "$resp" >&2
  exit 1
fi
echo "    ✓ 发出去了 ($(printf '%s' "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'))"

# ── 2. Back up, then swap ───────────────────────────────────────────────────
STAMP=$(date +%Y%m%d-%H%M%S)
echo "==> 备份 $ENV_FILE …"
ssh_vps "cp -a '$ENV_FILE' '$ENV_FILE.bak.$STAMP' && test -f '$ENV_FILE.bak.$STAMP'"
echo "    ✓ $ENV_FILE.bak.$STAMP"

# The key goes over stdin, not in the command line: anything in argv is
# visible in `ps` to every process on the box for as long as it runs.
echo "==> 写入新 key …"
printf '%s' "$NEW_KEY" | ssh_vps "cat > /tmp/.mailkey && \
  chmod 600 /tmp/.mailkey && \
  python3 - '$ENV_FILE' /tmp/.mailkey <<'PY' && rm -f /tmp/.mailkey
import sys, pathlib
env, keyfile = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
key = keyfile.read_text().strip()
lines = env.read_text().splitlines(keepends=True)
hits = [i for i, l in enumerate(lines) if l.startswith('SMTP_PASSWORD=')]
if len(hits) != 1:
    sys.exit(f'expected exactly one SMTP_PASSWORD= line, found {len(hits)}')
lines[hits[0]] = 'SMTP_PASSWORD=' + key + '\n'
env.write_text(''.join(lines))
print('    ✓ 换了 1 行')
PY"

# ── 3. Restart and confirm which path booted ────────────────────────────────
#
# Restart, not redeploy: the image has not changed, only the environment it
# reads. A full deploy would rebuild for nothing and widen the window.
echo "==> 重启 go-api …"
ssh_vps "cd '$APP_DIR' && docker compose --env-file=.env.production up -d --force-recreate --no-deps go-api" >/dev/null
sleep 6

echo "==> 启动日志说它选了哪条通道:"
ssh_vps "cd '$APP_DIR' && docker compose --env-file=.env.production logs go-api --since 2m 2>/dev/null | grep -i 'email:' | tail -2"

cat <<EOF

下一步(顺序不要反):
  1. 确认 $TEST_TO 收到了那封验证信
  2. 上面日志应该是 "SMTP relay configured" —— 如果是 "falling back to Gmail",
     说明新 key 没写进去,先回滚: $ENV_FILE.bak.$STAMP
  3. 两条都对了,再去 Resend 面板 revoke 旧 key
EOF
