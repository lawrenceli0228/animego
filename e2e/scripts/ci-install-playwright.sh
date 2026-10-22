#!/usr/bin/env bash
# ci-install-playwright.sh — CI only. Installs the e2e deps, Chromium and
# the system packages `playwright install --with-deps` adds, reusing what
# the workflow's actions/cache step restored.
#
# Those packages are mostly fonts (CJK, emoji), and specs measure layout,
# so the same fonts must be there every run. Their download from the
# Ubuntu mirror has taken anywhere from 20 s to 8.5 min (21 MB at 40 kB/s,
# 2026-10-22, which timed the prod e2e job out). So the .debs are kept in
# ~/.cache/playwright-debs and handed back to apt's archive, which then
# installs them without fetching. The browser itself is cached by
# Playwright in ~/.cache/ms-playwright.
#
# Run from e2e/. Exits with the install's status.
set -uo pipefail

debs="$HOME/.cache/playwright-debs"
if ls "$debs"/*.deb >/dev/null 2>&1; then
  sudo cp "$debs"/*.deb /var/cache/apt/archives/
fi

bun install --frozen-lockfile && bun run install:browsers
status=$?

mkdir -p "$debs"
cp /var/cache/apt/archives/*.deb "$debs"/ 2>/dev/null || true
exit "$status"
