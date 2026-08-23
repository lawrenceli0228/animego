#!/usr/bin/env bash
# Add the /_next/image edge-cache rule to Cloudflare. Dry-run by default.
#
# ── Why this rule is not optional ─────────────────────────────────────────
#
# Next's image optimizer sets `Vary: Accept` on every /_next/image response,
# unconditionally, regardless of the `formats` config. Cloudflare's default
# behaviour for a Vary'd response is to SKIP THE CACHE and report BYPASS, so a
# plain "cache /_next/image*" rule achieves nothing. The older "Vary for
# Images" feature does not help either: it keys on a file extension in the
# path (this URL has none) and requires a Pro plan.
#
# What works is the `vary` setting on Cache Rules, which Cloudflare shipped on
# 2026-07-02. It works on the free plan and needs no extension. There is no
# dashboard control for it -- it is API-only, which is why this script exists.
#
# Without the rule, every size variant of every image is an origin request
# against a 512 MB container. See docs/AnimeGoClub-首页加载性能优化方案.md §12.6.
#
# ── Why a script and not a curl one-liner ─────────────────────────────────
#
# The Rulesets API replaces the whole rule list on PUT. The zone already has a
# cache rule for /anime/* (the edge cache that the ISR detail pages depend on,
# added after the 2026-06-05 crawler incident). A naive PUT would delete it.
# So: read the current rules, append ours, show the result, and only write on
# an explicit --apply.
#
# ── Usage ────────────────────────────────────────────────────────────────
#
#   export CF_API_TOKEN=...          # Zone → Cache Rules → Edit, on this zone
#   ./scripts/cf-image-cache-rule.sh            # dry run: show the diff
#   ./scripts/cf-image-cache-rule.sh --apply    # write it
#   ./scripts/cf-image-cache-rule.sh --verify   # probe the live edge afterwards
#
# Create the token at: Cloudflare dashboard → My Profile → API Tokens →
# Create Token → Custom token. Permissions: Zone / Cache Rules / Edit, plus
# Zone / Zone / Read so the script can resolve the zone id by name. Scope
# "Zone Resources" to this single zone -- the token needs nothing else.

set -euo pipefail

ZONE_NAME="${CF_ZONE_NAME:-animegoclub.com}"
RULE_DESC="Cache /_next/image variants at the edge, keyed on Accept"
API="https://api.cloudflare.com/client/v4"
MODE="${1:-dry-run}"

command -v jq >/dev/null || { echo "需要 jq: brew install jq" >&2; exit 1; }
[ -n "${CF_API_TOKEN:-}" ] || { echo "需要 CF_API_TOKEN 环境变量" >&2; exit 1; }

cf() { curl -sS -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" "$@"; }

die_on_error() {
  local body="$1" what="$2"
  if [ "$(jq -r '.success' <<<"$body")" != "true" ]; then
    echo "✗ $what 失败:" >&2
    jq -r '.errors[]? | "  [\(.code)] \(.message)"' <<<"$body" >&2
    exit 1
  fi
}

# ── zone id ───────────────────────────────────────────────────────────────
ZONES=$(cf "$API/zones?name=$ZONE_NAME")
die_on_error "$ZONES" "查询 zone"
ZONE_ID=$(jq -r '.result[0].id // empty' <<<"$ZONES")
# Braces are not optional where a variable is followed by a non-ASCII byte:
# bash reads the first byte of the multi-byte character as part of the
# identifier, producing a name that was never assigned. Under `set -u` that is
# a hard exit, and the error names a variable that does not appear in the
# source, which is a confusing five minutes.
[ -n "$ZONE_ID" ] || { echo "✗ 找不到 zone ${ZONE_NAME}（token 权限是否包含 Zone:Read？）" >&2; exit 1; }
echo "zone $ZONE_NAME → $ZONE_ID"

# ── verify mode: probe the live edge, nothing else ────────────────────────
if [ "$MODE" = "--verify" ]; then
  URL="https://$ZONE_NAME/_next/image?url=$(python3 -c "
import urllib.parse
print(urllib.parse.quote('https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx182317-zzpOnAECrM2o.png', safe=''))")&w=384&q=85"
  echo
  echo "同一个 URL、两种 Accept、各打两次。要看到的是："
  echo "  · 第二次 cf-cache-status 是 HIT（不是 BYPASS / DYNAMIC）"
  echo "  · 两种 Accept 拿到不同的 content-type（image/avif vs image/webp）"
  echo
  for accept in "image/avif,image/webp,*/*" "image/webp,*/*"; do
    echo "Accept: ${accept%%,*}"
    for i in 1 2; do
      printf "  第%d次  " "$i"
      curl -sSI -H "Accept: $accept" "$URL" \
        | grep -iE '^(cf-cache-status|content-type|vary):' \
        | tr -d '\r' | paste -sd'  ' -
    done
  done
  exit 0
fi

# ── current cache-settings ruleset ────────────────────────────────────────
PHASE="$API/zones/$ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint"
EXISTING=$(cf "$PHASE" || true)

if [ "$(jq -r '.success' <<<"$EXISTING")" = "true" ]; then
  RULESET_ID=$(jq -r '.result.id' <<<"$EXISTING")
  CURRENT_RULES=$(jq '.result.rules // []' <<<"$EXISTING")
  echo "已有 ruleset ${RULESET_ID}，$(jq 'length' <<<"$CURRENT_RULES") 条规则："
  jq -r '.[] | "  · \(.description // .expression)"' <<<"$CURRENT_RULES"
else
  RULESET_ID=""
  CURRENT_RULES='[]'
  echo "该 zone 还没有 cache-settings ruleset，将新建。"
fi

# Idempotent: drop any previous copy of our own rule before appending.
KEPT=$(jq --arg d "$RULE_DESC" '[.[] | select(.description != $d)]' <<<"$CURRENT_RULES")
if [ "$(jq 'length' <<<"$KEPT")" != "$(jq 'length' <<<"$CURRENT_RULES")" ]; then
  echo "（检测到本规则的旧版本，将替换而不是重复添加）"
fi

NEW_RULE=$(jq -n --arg d "$RULE_DESC" '{
  description: $d,
  expression: "(starts_with(http.request.uri.path, \"/_next/image\"))",
  action: "set_cache_settings",
  action_parameters: {
    cache: true,
    # Next already sends Cache-Control: public, max-age=2678400, must-revalidate
    # from `minimumCacheTTL`. Let that be the single source of truth rather than
    # setting a second number here that can drift from the config.
    edge_ttl:    { mode: "respect_origin" },
    browser_ttl: { mode: "respect_origin" },
    vary: {
      # An unexpected Vary header from the origin should fail closed -- not
      # cached -- rather than serve one visitor the format another negotiated.
      default: { action: "bypass" },
      headers: {
        accept: { action: "normalize", media_types: ["image/avif", "image/webp"] }
      }
    }
  }
}')

# Ours goes last: cache rules are evaluated in order and the /anime/* rule must
# keep matching first for the ISR HTML it was added to protect.
FINAL_RULES=$(jq -s '.[0] + [.[1]]' <(echo "$KEPT") <(echo "$NEW_RULE"))

echo
echo "将要写入的完整规则列表（$(jq 'length' <<<"$FINAL_RULES") 条）："
jq . <<<"$FINAL_RULES"

if [ "$MODE" != "--apply" ]; then
  echo
  echo "── dry run，没有改动任何东西 ──"
  echo "确认无误后跑：  $0 --apply"
  exit 0
fi

echo
echo "写入中…"
BODY=$(jq -n --argjson rules "$FINAL_RULES" '{rules: $rules}')
if [ -n "$RULESET_ID" ]; then
  RESP=$(cf -X PUT "$API/zones/$ZONE_ID/rulesets/$RULESET_ID" --data "$BODY")
else
  RESP=$(cf -X POST "$API/zones/$ZONE_ID/rulesets" --data "$(jq -n --argjson rules "$FINAL_RULES" '{
    name: "default", kind: "zone", phase: "http_request_cache_settings", rules: $rules }')")
fi
die_on_error "$RESP" "写入 ruleset"

echo "✓ 已写入。现在的规则："
jq -r '.result.rules[] | "  · \(.description // .expression)"' <<<"$RESP"
echo
echo "边缘缓存要几分钟生效。之后跑：  $0 --verify"
