#!/usr/bin/env bash
# Behaviour harness for nginx/default.p9.conf, the live nginx config.
#
# Starts the nginx image docker-compose.yml runs, with the repo's config,
# beside stand-ins for next-image, next-app and AniList's image CDN on a
# private docker network, then checks what each kind of request does:
# routing; the image variant cache, its key and its query-string check; the
# limit in front of the image optimizer; the private include hooks; and the
# AniList original-image mirror -- which paths it will fetch, what it sends
# AniList, what it stores, and what it serves while AniList fails.
#
#   bash scripts/nginx-test/run.sh
#
# Needs docker, curl and openssl.  Prints PASS or FAIL for each check and
# exits 1 if any failed.  Takes about a minute, most of it spent waiting on
# purpose for slow upstreams and for stored images to expire.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
CONF=$ROOT/nginx/default.p9.conf
NGINX_IMAGE=nginx:alpine   # what docker-compose.yml runs
PY_IMAGE=python:3.12-alpine
RUN=nginxtest-$$           # names this run's containers and network
NET=$RUN-net
NGX=$RUN-nginx
EXP=$RUN-nginx-expiry
IMG=$RUN-image
APP=$RUN-app
ANI=$RUN-anilist
T=$(mktemp -d "${TMPDIR:-/tmp}/nginx-test.XXXXXX")
passed=0
failed=0

cleanup() {
  docker rm -f "$NGX" "$EXP" "$IMG" "$APP" "$ANI" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$T"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ok() {
  if [ "$1" = "$2" ]; then
    echo "PASS  $3"; passed=$((passed + 1))
  else
    echo "FAIL  $3 (got '$1', want '$2')"; failed=$((failed + 1))
  fi
}

# ─── certificates ──────────────────────────────────────────────────────
# A test root CA, two intermediates under it and certificates for the AniList
# stand-in: the good one (s4.anilist.co, issued by the second intermediate),
# one for another name from the same chain, and a self-signed one.  All are
# backdated, so a container clock a little behind this machine's cannot make
# them "not yet valid".  Only `openssl req` and `openssl ca` are used, which
# behave the same in OpenSSL and LibreSSL.
make_pki() {
  local d=$T/pki
  mkdir -p "$d/newcerts" && : > "$d/index.txt" && echo 1000 > "$d/serial"
  cat > "$d/pki.cnf" <<'EOF'
[ca]
default_ca = test_ca
[test_ca]
dir = .
database = ./index.txt
new_certs_dir = ./newcerts
serial = ./serial
default_md = sha256
policy = any_name
unique_subject = no
email_in_dn = no
[any_name]
commonName = supplied
[req]
distinguished_name = req_dn
[req_dn]
commonName = Common Name
[v3_root]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[v3_int1]
basicConstraints = critical,CA:TRUE,pathlen:1
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[v3_int2]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[v3_leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:s4.anilist.co
[v3_wrong_name]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:not-anilist.example
EOF
  (
    cd "$d" || exit 1
    csr() { openssl req -new -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=$2" -config pki.cnf 2>/dev/null; }
    sign() { # name, issuer ("self" for self-signed), extension section
      local by="-cert $2.crt -keyfile $2.key"
      [ "$2" = self ] && by="-selfsign -keyfile $1.key"
      # shellcheck disable=SC2086
      openssl ca -batch -notext -config pki.cnf $by -in "$1.csr" -out "$1.crt" -extensions "$3" \
        -startdate 200101000000Z -enddate 491231235959Z 2>ca.log || { cat ca.log; exit 1; }
    }
    csr root "nginx-test root CA" && sign root self v3_root &&
    csr int1 "nginx-test intermediate 1" && sign int1 root v3_int1 &&
    csr int2 "nginx-test intermediate 2" && sign int2 int1 v3_int2 &&
    csr good "s4.anilist.co" && sign good int2 v3_leaf &&
    csr wrong_name "not-anilist.example" && sign wrong_name int2 v3_wrong_name &&
    csr untrusted "s4.anilist.co" && sign untrusted self v3_leaf &&
    cat good.crt int2.crt int1.crt > good-chain.pem &&
    cat wrong_name.crt int2.crt int1.crt > wrong_name-chain.pem &&
    cp untrusted.crt untrusted-chain.pem &&
    chmod 644 ./*.key &&
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/server.key" -out "$T/server.crt" \
      -days 2 -subj /CN=localhost -config pki.cnf 2>/dev/null
  )
}

# ─── containers ────────────────────────────────────────────────────────
pull_once() { docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null; }

start_nginx() { # container name, config file
  docker run -d --name "$1" --network "$NET" -p 127.0.0.1::443 -p 127.0.0.1::8090 \
    -v "$2:/etc/nginx/conf.d/default.conf:ro" \
    -v "$T/server.crt:/etc/nginx/ssl/selfsigned.crt:ro" \
    -v "$T/server.key:/etc/nginx/ssl/selfsigned.key:ro" \
    -v "$ROOT/nginx/maintenance.html:/usr/share/nginx/html/maintenance.html:ro" \
    -v "$T/private:/etc/nginx/private:ro" \
    -v "$T/pki/root.crt:/etc/ssl/certs/ca-certificates.crt:ro" \
    "$NGINX_IMAGE" >/dev/null
}

port_of() { docker port "$1" "$2/tcp" | head -1 | sed 's/.*://'; }

wait_for() { # url: wait up to 20s for any HTTP answer
  local i
  for i in $(seq 1 100); do
    curl -s -o /dev/null --max-time 1 "$1" && return 0
    sleep 0.2
  done
  return 1
}

give_up() {
  echo "FAIL  $1"
  docker logs "$NGX" 2>&1 | tail -30
  exit 1
}

make_pki || give_up "could not create the test certificates"
mkdir -p "$T/private" "$T/flood"
# A stand-in for the rules nginx/private holds on the server: refuse image
# urls starting with /blocked.
printf '%s\n' 'map $arg_url $test_blocked { default 0; "~^%2Fblocked" 1; }' > "$T/private/http-test.conf"
printf '%s\n' 'if ($test_blocked) { return 403; }' > "$T/private/next-image-test.conf"

pull_once "$NGINX_IMAGE"
pull_once "$PY_IMAGE"
docker network create "$NET" >/dev/null || give_up "could not create the docker network"
docker run -d --name "$IMG" --network "$NET" --network-alias next-image -e STUB_NAME=next-image \
  -p 127.0.0.1::9000 -v "$HERE/next_stub.py:/stub.py:ro" "$PY_IMAGE" python -u /stub.py >/dev/null
docker run -d --name "$APP" --network "$NET" --network-alias next-app --network-alias go-api \
  --network-alias ws-server -e STUB_NAME=next-app \
  -v "$HERE/next_stub.py:/stub.py:ro" "$PY_IMAGE" python -u /stub.py >/dev/null
docker run -d --name "$ANI" --network "$NET" --network-alias s4.anilist.co \
  -p 127.0.0.1::9000 -v "$HERE/anilist_stub.py:/stub.py:ro" -v "$T/pki:/certs:ro" \
  "$PY_IMAGE" python -u /stub.py >/dev/null
PIMG=$(port_of "$IMG" 9000)
PANI=$(port_of "$ANI" 9000)
wait_for "http://127.0.0.1:$PIMG/" || give_up "the next-image stand-in did not start"
wait_for "http://127.0.0.1:$PANI/hits" || { docker logs "$ANI" 2>&1 | tail -20; give_up "the AniList stand-in did not start"; }

start_nginx "$NGX" "$CONF"
P443=$(port_of "$NGX" 443)
P8090=$(port_of "$NGX" 8090)
[ -n "$P443" ] && wait_for "http://127.0.0.1:$P8090/" || give_up "nginx did not start with $CONF"

# ─── request helpers ───────────────────────────────────────────────────
B=https://localhost:$P443   # the main server answers to `localhost` too
W=http://127.0.0.1:$P8090   # the warm server
CURL_RESOLVE=(--resolve "localhost:$P443:127.0.0.1")
A='accept: image/avif,image/webp,*/*'
WEBP='accept: image/webp,*/*'

c() { curl -sk --max-time 90 "${CURL_RESOLVE[@]}" "$@"; }
code() { c -o /dev/null -w '%{http_code}' -H "$A" "$B$1"; }
hdr() { c -D - -o /dev/null -H "$1" "$B$2" | tr -d '\r' | awk -F': ' -v k="$3" 'tolower($1)==k {print $2}'; }
hits() { curl -s "http://127.0.0.1:$PIMG/"; }          # next-image: "<requests> <most at once>"
next_hits() { hits | cut -d' ' -f1; }
flood() { # how many distinct cold images at once, name tag, url prefix (slow = 1s upstream, slower = 5s)
  rm -f "$T/flood.txt" "$T"/flood/*
  for i in $(seq 1 "$1"); do
    ( c -D "$T/flood/h$i" -o /dev/null -w "%{http_code} %{time_total} %{time_appconnect} %{time_starttransfer}\n" \
        -H "$A" "$B/_next/image?url=%2F${3:-slow}-$2$i.png&w=640&q=85" >> "$T/flood.txt" ) &
  done
}

ani() { curl -s "http://127.0.0.1:$PANI/$1"; }          # the AniList stand-in's control port
ani_hits() { if [ $# -gt 0 ]; then ani "hits?path=$1"; else ani hits; fi; }
# GET <path> from /img/anilist/ or from the warm server; the body and headers
# are kept for body and head_of.  --path-as-is sends dot segments unchanged.
img() { c --path-as-is -o "$T/body" -D "$T/head" -w '%{http_code}' "$B/img/anilist/$1"; }
warm() { curl -s --path-as-is --max-time 90 -o "$T/body" -D "$T/head" -w '%{http_code}' "$W/warm/$1"; }
body() { cat "$T/body"; }
head_of() { tr -d '\r' < "$T/head" | awk -v k="$1" 'index(tolower($0), k ": ") == 1 { print substr($0, length(k) + 3) }'; }

# ═══ the image optimizer: routing, cache, query shape, limits ══════════
ok "$(docker exec "$NGX" nginx -t 2>&1 | grep -c 'test is successful')" 1 "nginx -t accepts the config"
echo "== routing"
ok "$(hdr "$A" '/_next/image?url=%2Fa.png&w=640&q=85' x-stub)" next-image "image request is served by next-image"
ok "$(hdr "$A" /anime/1 x-stub)" next-app "page request is served by next-app"
echo "== caching"
ok "$(next_hits)" 1 "first request reached upstream once"
code '/_next/image?url=%2Fa.png&w=640&q=85' >/dev/null
ok "$(next_hits)" 1 "repeat request is a cache hit"
c -o /dev/null -H "$WEBP" "$B/_next/image?url=%2Fa.png&w=640&q=85"
ok "$(next_hits)" 2 "a different format is a separate entry"
echo "== only the shape the pages produce is accepted"
ok "$(code '/_next/image?URL=%2Fvictim.png&url=%2Fattacker.png&w=640&q=85')" 400 "poisoning attempt (URL= then url=) is refused"
ok "$(hdr "$A" '/_next/image?url=%2Fvictim.png&w=640&q=85' x-url)" /victim.png "victim's image is the victim's image"
ok "$(code '/_next/image?URL=%2Fa.png&w=640&q=85')" 400 "upper-case parameter name is refused"
ok "$(code '/_next/image?w=640&url=%2Fa.png&q=85')" 400 "parameters out of order are refused"
ok "$(code '/_next/image?url=%2Fa.png&w=640&q=85&junk=1')" 400 "padded query string is refused"
ok "$(code '/_next/image?url=%2Fa.png&url=%2Fb.png&w=640&q=85')" 400 "duplicate url is refused"
ok "$(code '/_next/image?url=%2Fa.png&w=640')" 400 "missing q is refused"
ok "$(code '/_next/image?url=&w=640&q=85')" 400 "empty url is refused"
ok "$(code '/_next/image?url=%2Fa.png&w=640&q=85')" 200 "the canonical shape still works"
ok "$(next_hits)" 3 "none of the refused requests reached the optimizer"
echo "== a whole page of cold images (48 at once) is served, not refused"
flood 48 page; sleep 0.3; during=$(c -o /dev/null -w "%{http_code} %{time_total}" -H "$A" "$B/_next/image?url=%2Fa.png&w=640&q=85"); wait
ok "$(grep -c '^200' "$T/flood.txt")" 48 "all 48 cold images return 200"
ok "$(echo "$during" | cut -d' ' -f1)" 200 "cached image during the burst still 200"
ok "$(echo "$during" | awk '{print ($2<0.5)}')" 1 "cached image during the burst returns in under 0.5s ($(echo "$during" | cut -d' ' -f2)s)"
echo "== a flood (300 at once) is capped at 256 in flight"
flood 300 flood slower; wait
ok "$(grep -c '^200' "$T/flood.txt")" 256 "256 served"
ok "$(grep -c '^503' "$T/flood.txt")" 44 "44 over the limit get 503"
echo "      503 times: $(awk '$1==503 {print $2}' "$T/flood.txt" | sort -n | awk '{a[NR]=$1} END {printf "min %.2fs median %.2fs max %.2fs", a[1], a[int((NR+1)/2)], a[NR]}')  | 200 times: $(awk '$1==200 {print $2}' "$T/flood.txt" | sort -n | awk '{a[NR]=$1} END {printf "min %.2fs max %.2fs", a[1], a[NR]}')"
ok "$(awk '$1==503 && NF==4' "$T/flood.txt" | wc -l | tr -d ' ')" 44 "all 44 503s carry connect and first-byte times"
ok "$(awk '$1==503 && ($4-$3)>0.5' "$T/flood.txt" | wc -l | tr -d ' ')" 0 "every 503 is answered within 0.5s of the TLS session being up"
ok "$(hits | awk '{print ($2 <= 256)}')" 1 "upstream never sees more than 256 at once (peak $(hits | cut -d' ' -f2))"
busy=$(grep -l '^HTTP/[0-9.]* 503' "$T"/flood/h* | head -1)
ok "$(tr -d '\r' < "$busy" | awk -F': ' 'tolower($1)=="cache-control" {print $2}')" no-store "503 carries Cache-Control: no-store"
echo "== private rules (nginx/private) are applied"
ok "$(code '/_next/image?url=%2Fblocked-x.png&w=640&q=85')" 403 "a private rule refuses what it matches"
ok "$(code '/_next/image?url=%2Fallowed-x.png&w=640&q=85')" 200 "and nothing else"

# The 60s read timeout check takes 40s; it runs in the background from here
# and is read at the end.  Wait until the optimizer has counted it, so the
# hit counts below are not off by one.
before=$(next_hits)
( code '/_next/image?url=%2Fveryslow-x.png&w=640&q=85' > "$T/veryslow.txt" ) &
veryslow=$!
for i in $(seq 1 50); do [ "$(next_hits)" -gt "$before" ] && break; sleep 0.1; done

# ═══ /_next/image: the mirror address shares the AniList address's entry ═
S4=https%3A%2F%2Fs4.anilist.co%2Ffile%2Fanilistcdn%2F
MIRROR=https%3A%2F%2Fanimegoclub.com%2Fimg%2Fanilist%2F
P1=media%2Fanime%2Fcover%2Flarge%2Fbx9001-share.png
P1_S4=https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9001-share.png
echo "== /_next/image: an AniList image's mirror address shares its AniList address's entry"
n=$(next_hits)
ok "$(code "/_next/image?url=$S4$P1&w=640&q=85")|$(( $(next_hits) - n ))" "200|1" "the AniList address is encoded once"
code "/_next/image?url=$S4$P1&w=640&q=85" >/dev/null
ok "$(( $(next_hits) - n ))" 1 "and a repeat of it is a cache hit, as before"
ok "$(hdr "$A" "/_next/image?url=$MIRROR$P1&w=640&q=85" x-url)" "$P1_S4" "the mirror address is answered from the AniList address's entry"
ok "$(( $(next_hits) - n ))" 1 "so the two addresses reach the optimizer once in total"
keys=$(docker exec "$NGX" find /var/cache/nginx/next_image -type f -exec cat {} + | grep -a '^KEY: ')
ok "$(printf '%s\n' "$keys" | grep -c -x -F "KEY: url=$S4$P1&w=640&q=85|avif")" 1 "the entry's key is the pre-change format, url=<AniList address>&w=640&q=85|avif"
ok "$(printf '%s\n' "$keys" | grep -c -F 'animegoclub.com')" 0 "no entry is keyed by a mirror address"
P2=media%2Fanime%2Fbanner%2F9002-share.jpg
n=$(next_hits)
code "/_next/image?url=$MIRROR$P2&w=640&q=85" >/dev/null
code "/_next/image?url=$S4$P2&w=640&q=85" >/dev/null
ok "$(( $(next_hits) - n ))" 1 "mirror address first, then the AniList address: once in total"
n=$(next_hits)
code "/_next/image?url=${MIRROR}character%2Flarge%2Fb9003-share.png&w=640&q=85" >/dev/null
code "/_next/image?url=${MIRROR}character%2Flarge%2Fb9004-share.png&w=640&q=85" >/dev/null
ok "$(( $(next_hits) - n ))" 2 "two different paths reach it twice"
n=$(next_hits)
code "/_next/image?url=$MIRROR$P1&w=384&q=85" >/dev/null
ok "$(( $(next_hits) - n ))" 1 "another width of the same image is another entry"
LOWER=https%3a%2f%2fanimegoclub.com%2fimg%2fanilist%2fmedia%2fanime%2fcover%2flarge%2fbx9001-share.png
n=$(next_hits)
ok "$(hdr "$A" "/_next/image?url=$LOWER&w=640&q=85" x-url)" \
  "https://animegoclub.com/img/anilist/media/anime/cover/large/bx9001-share.png" \
  "a mirror address in lower-case %-escapes is answered for its own url"
ok "$(( $(next_hits) - n ))" 1 "from an entry of its own"
ok "$(hdr "$A" "/_next/image?url=$MIRROR$P1&w=640&q=85" x-url)|$(( $(next_hits) - n ))" "$P1_S4|1" "and the shared entry is untouched"
n=$(next_hits)
code "/_next/image?url=https%3A%2F%2Fanimegoclub.com.example%2Fimg%2Fanilist%2F$P1&w=640&q=85" >/dev/null
code "/_next/image?url=https%3A%2F%2FanimegoclubXcom%2Fimg%2Fanilist%2F$P1&w=640&q=85" >/dev/null
ok "$(( $(next_hits) - n ))" 2 "look-alike hosts are not taken for the mirror"

# ═══ /img/anilist/ and :8090 /warm/: the allowlist ═════════════════════
echo "== /img/anilist/ serves each kind of image the site shows"
while IFS='|' read -r p label; do
  ok "$(img "$p")|$(body)" "200|original $p v1" "$label"
done <<'EOF'
media/anime/cover/large/bx9101-kind.png|an anime cover, byte for byte
media/manga/cover/medium/bx9102-kind.jpg|a manga cover
media/anime/banner/9103-kind.jpg|a banner
character/large/b9104-kind.png|a character portrait
staff/medium/n9105-kind.jpg|a staff portrait
EOF
served=0
for p in media/anime/cover/extraLarge/bx9106.webp media/anime/cover/small/bx9107.gif \
         media/manga/cover/large/bx9108.jpeg media/manga/banner/9109.png character/medium/b9110.jpg \
         staff/large/n9111.png media/anime/cover/medium/bx9112-a_b.c-D.png; do
  [ "$(img "$p")" = 200 ] && served=$((served + 1))
done
ok "$served" 7 "and every other size, kind and file type in the allowlist"

# Paths outside the allowlist; %ID% becomes a number unique to each request.
REFUSED='user/avatar/large/b%ID%-x.png|an AniList user avatar
user/banner/b%ID%-x.jpg|an AniList user banner
media/anime/cover/huge/bx%ID%.png|a cover size that does not exist
media/anime/cover/large/bx%ID%.svg|a file type outside the list
media/anime/cover/large/bx%ID%.PNG|an upper-case extension
media/anime/cover/large/bx%ID%.png.html|a second extension after the image one
media/anime/cover/large/|a directory
media/anime/cover/large/x/bx%ID%.png|an extra directory level
media/anime/cover/large/bx%ID%%20x.png|a space in the file name
media/anime/cover/large/..%2F..%2F..%2F..%2Fuser%2Favatar%2Fb%ID%.png|encoded ../ climbing to a user upload
media/anime/cover/large/%2E%2E/%2E%2E/%2E%2E/%2E%2E/user/avatar/b%ID%.png|encoded .. segments
media/anime/cover/large/../../../../user/avatar/b%ID%.png|plain .. segments
media/anime/cover/large/%252E%252E%252Fb%ID%.png|double-encoded ../
media/anime/cover/large/b%ID%%5C..%5C..%5Cx.png|backslashes'
refused() { # get function, id base
  local id=$2 p label
  while IFS='|' read -r p label; do
    id=$((id + 1))
    ok "$($1 "$(printf '%s' "$p" | sed "s/%ID%/$id/")")" 404 "$label"
  done <<EOF
$REFUSED
EOF
}
echo "== /img/anilist/ answers 404 for anything else, without asking AniList"
h=$(ani_hits)
refused img 9200
ok "$(c -o /dev/null -w '%{http_code}' -X POST --data x "$B/img/anilist/media/anime/cover/large/bx9299.png")" 403 "a POST to an allowed path is refused"
ok "$(( $(ani_hits) - h ))" 0 "none of them reached AniList"

echo "== :8090 /warm/ fetches and stores the same kinds, and nothing else"
while IFS='|' read -r p label; do
  ok "$(warm "$p")|$(body)" "200|original $p v1" "$label"
done <<'EOF'
media/anime/cover/large/bx9301-kind.png|an anime cover, byte for byte
media/manga/cover/medium/bx9302-kind.jpg|a manga cover
media/anime/banner/9303-kind.jpg|a banner
character/large/b9304-kind.png|a character portrait
staff/medium/n9305-kind.jpg|a staff portrait
EOF
h=$(ani_hits)
refused warm 9310
ok "$(curl -s -o /dev/null -w '%{http_code}' -X POST --data x "$W/warm/media/anime/cover/large/bx9399.png")" 403 "a POST to an allowed path is refused"
ALLOWED=media/anime/cover/large/bx9301-kind.png
for p in / /warm/ /warm "/img/anilist/$ALLOWED" "/file/anilistcdn/$ALLOWED" "/WARM/$ALLOWED" "/warmx/$ALLOWED" \
         "/_next/image?url=%2Fa.png&w=640&q=85"; do
  ok "$(curl -s -o /dev/null -w '%{http_code}' "$W$p")" 404 ":8090 has nothing at $p"
done
ok "$(( $(ani_hits) - h ))" 0 "none of them reached AniList"
ok "$(hdr "$A" "/warm/$ALLOWED" x-stub)|$(( $(ani_hits) - h ))" "next-app|0" "the public server has no /warm/: that path is a page request for next-app"

# ═══ what is stored ═════════════════════════════════════════════════════
echo "== /img/anilist/ reads the store but never adds to it"
U=media/anime/cover/large/bx9401-unstored.png
img "$U" >/dev/null; img "$U" >/dev/null
ok "$(ani_hits "$U")" 2 "two GETs of an image no one stored reach AniList twice: the first was not kept"
S=media/anime/cover/large/bx9402-stored.png
ok "$(warm "$S")" 200 "the warm server fetches and stores an image"
ok "$(img "$S")|$(body)" "200|original $S v1" "/img/anilist/ then serves it"
img "$S" >/dev/null
ok "$(ani_hits "$S")" 1 "a warm GET then two public GETs reach AniList once: the public ones were served from the store"
ok "$(img "$S?v=2&cache=bust")|$(ani_hits "$S")" "200|1" "a query string does not get past the store"
L=media/anime/cover/large/bx9403-lock.png
ani "set?path=$L&delay=1" >/dev/null
curl -s -o /dev/null "$W/warm/$L" & p1=$!
curl -s -o /dev/null "$W/warm/$L" & p2=$!
wait $p1 $p2
ok "$(ani_hits "$L")" 1 "two warm GETs at once for the same new image fetch it once"
Q=media/anime/cover/large/bx9404-concurrent.png
ani "set?path=$Q&delay=1" >/dev/null
rm -f "$T/concurrent.txt"; pids=""
for i in 1 2 3 4; do
  ( c -o /dev/null -w '%{time_total}\n' "$B/img/anilist/$Q" >> "$T/concurrent.txt" ) & pids="$pids $!"
done
# shellcheck disable=SC2086
wait $pids
slowest=$(sort -n "$T/concurrent.txt" | tail -1)
ok "$(awk -v t="$slowest" 'BEGIN { print (t != "" && t + 0 < 1.8) }')|$(ani_hits "$Q")" "1|4" \
  "four public GETs at once for an unstored image each go to AniList without queueing behind each other (slowest ${slowest}s)"

echo "== while AniList fails"
ani "all?status=503" >/dev/null
ok "$(img "$S")|$(body)" "200|original $S v1" "AniList answering 503: a stored original is still served"
ok "$(img "$U")" 503 "an image no one stored gets AniList's own 503"
ani "all?status=0" >/dev/null
ani "listen?on=0" >/dev/null
ok "$(img "$S")|$(body)" "200|original $S v1" "AniList unreachable: a stored original is still served"
ok "$(img media/anime/cover/large/bx9501-cold.png)" 502 "AniList unreachable: an image no one stored is a 502"
ok "$(head_of cache-control)" no-store "that carries Cache-Control: no-store"
ok "$(grep -c -i maintenance "$T/body")" 0 "and is not the maintenance page"
ok "$(warm media/anime/cover/large/bx9502-cold.png)" 502 "the warm server answers 502"
ani "listen?on=1" >/dev/null

echo "== :8090 passes AniList's own answers on to the warm job, and stores none of them"
X=media/anime/cover/large/bx9601-gone.png
ani "set?path=$X&status=404" >/dev/null
ok "$(warm "$X")" 404 "404 is passed on"
warm "$X" >/dev/null
ok "$(ani_hits "$X")" 2 "and not stored, though AniList said to cache it"
ok "$(img "$X")" 404 "/img/anilist/ passes the 404 on too"
ok "$(head_of cache-control)|$(head_of x-accel-expires)" "|" "without AniList's invitation to cache it"
X=media/anime/cover/large/bx9602-throttled.png
ani "set?path=$X&status=429&retry_after=120" >/dev/null
ok "$(warm "$X")|$(head_of retry-after)" "429|120" "429 is passed on with its Retry-After"
warm "$X" >/dev/null
ok "$(ani_hits "$X")" 2 "and not stored"
ok "$(img "$X")|$(head_of retry-after)|$(head_of cache-control)" "429|120|" \
  "/img/anilist/ passes the 429 on with its Retry-After, and nothing that lets the CDN keep it"
X=media/anime/cover/large/bx9603-broken.png
ani "set?path=$X&status=503" >/dev/null
ok "$(warm "$X")" 503 "503 is passed on"
warm "$X" >/dev/null
ok "$(ani_hits "$X")" 2 "and not stored"

# ═══ what AniList is sent, and what comes back ═════════════════════════
echo "== what AniList is sent"
H=media/anime/cover/large/bx9701-headers.png
c -o /dev/null -H 'Cookie: session=reader-secret' -H 'Authorization: Bearer reader-token' \
  -H 'Accept-Encoding: gzip, br' -H 'Referer: https://example.org/' "$B/img/anilist/$H?utm=1&w=2"
ok "$(ani 'last?field=target')" "/file/anilistcdn/$H" "the AniList path alone, without the query string"
ok "$(ani 'last?field=host')" s4.anilist.co "Host: s4.anilist.co"
ok "$(ani 'last?field=sni')" s4.anilist.co "TLS server name s4.anilist.co"
# Whether nginx adds a Connection header of its own depends on its version.
names=$(ani 'last?field=header_names')
ok "${names/connection /}" "host user-agent" "no header of the visitor's: not their cookies, credentials, address or Accept-Encoding"
CLEAN='^/file/anilistcdn/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$'
ok "$(ani targets | grep -v '^$' | grep -c -v -E "$CLEAN")" 0 "in this whole run AniList was only asked for plain /file/anilistcdn/ paths"
echo "== what comes back from AniList"
img "$S" >/dev/null
ok "$(head_of cache-control)" "max-age=2592000" "a stored original may be kept 30 days, whatever AniList's Cache-Control said"
ok "$(head_of expires | grep -c 1970)" 0 "and AniList's Expires is not passed on"
ok "$(head_of set-cookie)" "" "AniList's Set-Cookie never reaches the visitor"
ok "$(head_of strict-transport-security)" "max-age=31536000; includeSubDomains; preload" "only the site's own HSTS policy, not AniList's"
ok "$(head_of report-to)$(head_of nel)" "" "nor AniList's error-report endpoints"
ok "$(head_of x-frame-options)|$(head_of x-content-type-options)" "DENY|nosniff" "the site's security headers are still added"

echo "== AniList's certificate is checked"
TLS=media/anime/cover/large/bx9801-tls.png
ani "cert?mode=untrusted" >/dev/null
ok "$(img "$TLS")" 502 "a certificate from an issuer nginx does not trust is refused"
ok "$(warm "$TLS")" 502 "by the warm server too"
ani "cert?mode=wrong_name" >/dev/null
ok "$(img "$TLS")" 502 "a trusted certificate for another name is refused"
ok "$(ani_hits "$TLS")" 0 "and no request went over those connections"
ani "cert?mode=good" >/dev/null
ok "$(img "$TLS")" 200 "the right name through two intermediate CAs is accepted"

# ═══ expiry: a copy of the config with validity cut to 2s ══════════════
echo "== once a stored original has expired (in a copy of the config with validity cut to 2s)"
sed 's/proxy_cache_valid 200 30d;/proxy_cache_valid 200 2s;/' "$CONF" > "$T/expiry.conf"
ok "$(grep -c 'proxy_cache_valid 200 2s;' "$T/expiry.conf")" 3 "the copy cuts it in the variant cache and both mirror locations"
start_nginx "$EXP" "$T/expiry.conf"
PE443=$(port_of "$EXP" 443)
PE8090=$(port_of "$EXP" 8090)
wait_for "http://127.0.0.1:$PE8090/" || give_up "the expiry copy of the config did not start"
CURL_RESOLVE+=(--resolve "localhost:$PE443:127.0.0.1")
B=https://localhost:$PE443
W=http://127.0.0.1:$PE8090
E=media/anime/cover/large/bx9901-expiry.png
ok "$(warm "$E")" 200 "stored by the warm server"
sleep 3
for status in 503 429 403; do
  ani "all?status=$status" >/dev/null
  ok "$(img "$E")|$(body)" "200|original $E v1" "AniList answering $status: /img/anilist/ serves the stored original"
done
ani "all?status=503" >/dev/null
ok "$(warm "$E")" 503 "while the warm job is told 503, not handed the stored copy"
ani "all?status=429" >/dev/null
ok "$(warm "$E")" 429 "and 429 likewise"
ani "all?status=0" >/dev/null
ani "listen?on=0" >/dev/null
ok "$(img "$E")|$(body)" "200|original $E v1" "AniList unreachable: /img/anilist/ serves the stored original"
ok "$(warm "$E")" 502 "while the warm job is told 502"
ani "listen?on=1" >/dev/null
h=$(ani_hits "$E")
ok "$(warm "$E")|$(body)" "200|original $E v1" "the warm job's request revalidates it"
ok "$(ani 'last?field=if-modified-since')|$(ani 'last?field=status')" "Fri, 02 Jan 2026 00:00:00 GMT|304" \
  "with a conditional request, which AniList answers 304"
ok "$(img "$E")|$(( $(ani_hits "$E") - h ))" "200|1" "and that makes it fresh again: the next public GET does not reach AniList"
sleep 3
ani "set?path=$E&version=2" >/dev/null
ok "$(img "$E")|$(body)" "200|original $E v2" "AniList has new bytes: a public GET gets them"
ani "all?status=503" >/dev/null
ok "$(img "$E")|$(body)" "200|original $E v1" "but does not store them: the stored original is still the old one"
ani "all?status=0" >/dev/null
ok "$(warm "$E")|$(body)" "200|original $E v2" "the warm job's request stores the new bytes"
ok "$(img "$E")|$(body)" "200|original $E v2" "and /img/anilist/ serves those from then on"

echo "== a slow encode is allowed 60s"
wait "$veryslow"
ok "$(cat "$T/veryslow.txt")" 200 "a 40s upstream response is still a 200"

echo
echo "$passed passed, $failed failed"
if [ "$failed" -gt 0 ]; then
  echo "--- nginx error log (last 40 lines)"
  docker logs "$NGX" 2>&1 | grep -v -E '^/docker-entrypoint|^[0-9/: ]+ \[notice\]' | tail -40
  exit 1
fi
