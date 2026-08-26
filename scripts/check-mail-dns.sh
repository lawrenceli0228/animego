#!/usr/bin/env bash
# Check that animegoclub.com is set up to SEND authenticated mail without
# breaking the Cloudflare Email Routing that receives it.
#
# Why a script rather than a checklist: every failure this looks for is
# silent. A second SPF record, a DKIM selector that never got published, an
# MX row clobbered while adding sending records — none of them produce an
# error anywhere. The mail simply stops arriving for the receivers that
# check, which here is most of them: 78% of accounts are on qq.com and
# another 10% on 163.com.
#
# Usage:
#   ./scripts/check-mail-dns.sh                       # SPF/DMARC/MX only
#   ./scripts/check-mail-dns.sh resend._domainkey     # also check a DKIM selector
#
# Exits non-zero if anything that would stop authenticated delivery is wrong.

set -uo pipefail

ZONE="${MAIL_DOMAIN:-animegoclub.com}"
DKIM_SELECTOR="${1:-}"
RESOLVER="${DNS_RESOLVER:-1.1.1.1}"
fail=0

q() { dig +short "$2" "$1" "@$RESOLVER" 2>/dev/null; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo "域名: $ZONE   (解析器 $RESOLVER)"

# ── SPF ─────────────────────────────────────────────────────────────────────
#
# RFC 7208 §4.5: more than one SPF record is a permerror, and a permerror is
# treated as "no SPF at all" by most receivers — so adding a second record to
# "add" a sender silently removes authentication for every sender. This is
# the single most common way this setup gets broken, which is why it is
# checked before the contents.
echo
echo "SPF"
# No arrays, no mapfile: this has to run on macOS's bash 3.2 as well as on
# the VPS. The first draft used `mapfile`, which 3.2 does not have — and the
# script printed "no errors" and exited 0 having never checked SPF at all.
# That is the exact failure it exists to catch, so: plain strings, and a
# verdict that refuses to pass when a check could not run.
spf_all=$(q "$ZONE" TXT | tr -d '"' | grep -i '^v=spf1')
if [ -z "$spf_all" ]; then
  spf_n=0
else
  spf_n=$(printf '%s\n' "$spf_all" | wc -l | tr -d ' ')
fi
spf_one=$(printf '%s\n' "$spf_all" | head -1)

case "$spf_n" in
  0) bad "没有 SPF 记录 —— 发出去的信没有任何 IP 授权" ;;
  1) ok "恰好一条: $spf_one" ;;
  *) bad "有 $spf_n 条 SPF 记录 —— 这是 permerror,等于完全没有 SPF"
     printf '      %s\n' "$spf_all"
     bad "修法: 合并成一条,把每个发信方的 include 写进同一行" ;;
esac

if [ "$spf_n" -eq 1 ]; then
  # Cloudflare Email Routing's include must survive: dropping it while adding
  # a sending provider is how inbound forwarding quietly stops passing SPF.
  case "$spf_one" in
    *_spf.mx.cloudflare.net*) ok "保留了 Cloudflare Email Routing 的 include(收信不受影响)" ;;
    *) warn "SPF 里没有 _spf.mx.cloudflare.net —— 如果收信仍走 CF Routing,这条被删掉了" ;;
  esac
  # A bare `include:_spf.mx.cloudflare.net` authorises forwarding only; no
  # outbound provider is listed, so nothing can send as this domain yet.
  if [ "$(printf '%s' "$spf_one" | grep -o 'include:' | wc -l | tr -d ' ')" -le 1 ]; then
    warn "只有一个 include —— 还没有任何发信服务被授权,现在发信 SPF 不会通过"
  fi
  # §4.6.4: >10 DNS-querying mechanisms is also a permerror. Counted loosely
  # (nested includes are not expanded) so this is a floor, not the true total.
  n=$(printf '%s' "$spf_one" | grep -oE '(include|a|mx|ptr|exists|redirect)[:=]?' | wc -l | tr -d ' ')
  [ "$n" -gt 8 ] && warn "顶层机制已有 $n 个,上限是 10(嵌套 include 也算,这里没展开)"
  case "$spf_one" in
    *" -all"*) ok "以 -all 结尾(严格)" ;;
    *" ~all"*) ok "以 ~all 结尾(软失败;先跑一段时间再收紧到 -all)" ;;
    *) warn "结尾既不是 ~all 也不是 -all" ;;
  esac
fi

# ── DKIM ────────────────────────────────────────────────────────────────────
#
# The provider publishes this; it is the half of DMARC that survives
# forwarding, and the half QQ/163 weigh most heavily.
echo
echo "DKIM"
if [ -z "$DKIM_SELECTOR" ]; then
  warn "没传 selector,跳过。装好发信服务后用它给的 selector 再跑一次:"
  warn "  ./scripts/check-mail-dns.sh resend._domainkey"
else
  rec=$(q "${DKIM_SELECTOR}.${ZONE}" TXT; q "${DKIM_SELECTOR}.${ZONE}" CNAME)
  if [ -z "$rec" ]; then
    bad "${DKIM_SELECTOR}.${ZONE} 解析不到 —— 记录没发布,或者还没生效"
  else
    ok "${DKIM_SELECTOR}.${ZONE} 有记录"
    printf '      %s\n' "$rec" | head -3
  fi
fi

# ── DMARC ───────────────────────────────────────────────────────────────────
echo
echo "DMARC"
dmarc=$(q "_dmarc.$ZONE" TXT | tr -d '"' | grep -i '^v=DMARC1' || true)
if [ -z "$dmarc" ]; then
  bad "没有 DMARC 记录"
else
  ok "$dmarc"
  case "$dmarc" in
    *p=none*)
      # Correct while bringing a new sender up: p=none asks receivers to
      # report rather than act, so a misconfiguration costs a report instead
      # of a bounced password reset. It buys no enforcement, though.
      warn "p=none —— 只监控不拦截。新发信方跑通、rua 报告连续几天全对齐之后再考虑 quarantine" ;;
  esac
  case "$dmarc" in
    *rua=*) ok "配了 rua,对齐失败会有报告寄回来" ;;
    *) warn "没有 rua —— 出问题时不会有任何报告,只能靠用户抱怨发现" ;;
  esac
fi

# ── MX ──────────────────────────────────────────────────────────────────────
#
# Receiving and sending are independent. Nothing about adding a sender should
# touch MX, so this is here to catch the accident rather than to verify intent.
echo
echo "MX(收信,应保持不变)"
mx=$(q "$ZONE" MX)
if [ -z "$mx" ]; then
  bad "没有 MX —— 这个域名收不了信"
else
  case "$mx" in
    *mx.cloudflare.net*) ok "仍指向 Cloudflare Email Routing" ;;
    *) warn "MX 不是 Cloudflare Email Routing,确认是有意为之:"; printf '      %s\n' "$mx" ;;
  esac
fi

echo
# `set -u` turns an unset variable into a message on stderr, not an exit —
# which is how the first draft reported success on a section that never ran.
# Anything the script could not evaluate counts as a failure, not a pass.
for v in spf_n dmarc mx; do
  eval "[ -n \"\${$v+set}\" ]" || { bad "内部错误: 检查项 $v 没能运行,结论不可信"; }
done

if [ "$fail" -eq 0 ]; then
  echo "结论: 没有会阻断认证投递的错误。"
  echo "注意这只证明记录对,不证明信能进 QQ/163 的收件箱 —— 那必须真发一封去看。"
else
  echo "结论: 上面标 ✗ 的会让认证投递失败,先修那些。"
fi
exit "$fail"
