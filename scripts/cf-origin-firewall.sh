#!/usr/bin/env bash
# Lock the origin's 80/443 to Cloudflare IP ranges only.
#
# WHY: the site sits behind Cloudflare (orange-cloud), but the origin IP is
# discoverable (it's in this repo's git history, and CF origin-hiding leaks
# anyway). With 80/443 open to the world, anyone with the IP can hit the
# origin directly, bypassing CF's WAF / DDoS / rate-limiting. This restricts
# the origin web ports to Cloudflare's published ranges, so the IP becomes
# useless for direct attacks — all traffic must come through CF.
#
# WHY DOCKER-USER (not plain UFW): the nginx container publishes 80/443, so
# Docker inserts its own iptables DNAT/ACCEPT rules that BYPASS UFW entirely.
# The only reliable filter point for Docker-published ports is the DOCKER-USER
# chain, which Docker evaluates before its own ACCEPT. We use a dedicated
# CF-ORIGIN child chain so the script is idempotent (flush + repopulate).
#
# Installed on the prod VPS at /usr/local/sbin/cf-origin-firewall.sh and run
# on boot by the cf-origin-firewall.service systemd unit (After=docker.service).
set -euo pipefail

# Default-route interface (the WAN nic), with a sane fallback.
WAN=$(ip route get 1.1.1.1 2>/dev/null | grep -oE 'dev [^ ]+' | awk '{print $2}')
WAN=${WAN:-ens17}

V4=$(curl -s --max-time 15 https://www.cloudflare.com/ips-v4)
N4=$(echo "$V4" | grep -cE '^[0-9.]+/[0-9]+$' || true)
# Refuse to apply a half-empty list — that would either lock CF out (site 521)
# or be a no-op. CF publishes ~15 v4 ranges.
[ "$N4" -ge 10 ] || { echo "CF v4 ranges look wrong ($N4); aborting" >&2; exit 1; }

iptables -N CF-ORIGIN 2>/dev/null || iptables -F CF-ORIGIN
iptables -C DOCKER-USER -j CF-ORIGIN 2>/dev/null || iptables -I DOCKER-USER -j CF-ORIGIN
for ip in $V4; do
  iptables -A CF-ORIGIN -i "$WAN" -p tcp -m multiport --dports 80,443 -s "$ip" -j RETURN
done
iptables -A CF-ORIGIN -i "$WAN" -p tcp -m multiport --dports 80,443 -j DROP

# IPv6 only if Docker actually DNATs 80/443 over v6 (otherwise there's no
# v6 path to the container and no rule is needed).
if ip6tables -t nat -L DOCKER -n 2>/dev/null | grep -qE 'dpt:(80|443)'; then
  V6=$(curl -s --max-time 15 https://www.cloudflare.com/ips-v6)
  ip6tables -N CF-ORIGIN 2>/dev/null || ip6tables -F CF-ORIGIN
  ip6tables -C DOCKER-USER -j CF-ORIGIN 2>/dev/null || ip6tables -I DOCKER-USER -j CF-ORIGIN
  for ip in $V6; do
    ip6tables -A CF-ORIGIN -i "$WAN" -p tcp -m multiport --dports 80,443 -s "$ip" -j RETURN
  done
  ip6tables -A CF-ORIGIN -i "$WAN" -p tcp -m multiport --dports 80,443 -j DROP
fi

echo "cf-origin-firewall: locked 80,443 on $WAN to $N4 Cloudflare v4 ranges"
