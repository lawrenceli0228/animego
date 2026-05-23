#!/usr/bin/env bash
# scripts/gen-local-cert.sh — generate self-signed cert for local docker stack.
#
# Why: nginx/default.conf serves HTTPS, and docker-compose.yml mounts
# nginx/selfsigned.{crt,key}. Those files are gitignored (each machine
# generates its own), so a fresh clone of the repo cannot run
# `docker compose up` until this script runs once.
#
# Browser will warn about the self-signed cert. Click through. The cert's
# SAN covers animegoclub.com, www.animegoclub.com, localhost, and 127.0.0.1
# so it works for both the local docker stack (https://localhost) and any
# /etc/hosts override pointing animegoclub.com at 127.0.0.1.
#
# Prod (VPS): use the existing Let's Encrypt cert at nginx/selfsigned.{crt,key}
# (path name kept for compose mount compatibility). Do NOT run this script
# on the VPS or you'll overwrite the real cert.

set -euo pipefail
cd "$(dirname "$0")/.."

CRT="nginx/selfsigned.crt"
KEY="nginx/selfsigned.key"

if [ -f "$CRT" ] && [ -f "$KEY" ]; then
    echo "Cert + key already exist at nginx/selfsigned.{crt,key}."
    echo "If you want to regenerate, delete those files first:"
    echo "  rm $CRT $KEY"
    echo ""
    echo "Skipping. Existing files NOT modified."
    exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: openssl not installed. Install via 'brew install openssl' (macOS) or 'apt install openssl' (Debian)." >&2
    exit 1
fi

echo "Generating self-signed cert + key (valid 365d)..."
echo "  CN:  animegoclub.com"
echo "  SAN: animegoclub.com, www.animegoclub.com, localhost, 127.0.0.1"
echo ""

openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$KEY" \
    -out "$CRT" \
    -days 365 \
    -subj "/CN=animegoclub.com" \
    -addext "subjectAltName=DNS:animegoclub.com,DNS:www.animegoclub.com,DNS:localhost,IP:127.0.0.1"

chmod 600 "$KEY"
chmod 644 "$CRT"

echo ""
echo "Done."
echo "  $CRT  $(wc -c < "$CRT") bytes"
echo "  $KEY  $(wc -c < "$KEY") bytes"
echo ""
echo "Next: docker compose up -d  (then open https://localhost)"
