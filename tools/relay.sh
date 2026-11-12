#!/bin/bash
# Digiturk relay — run from a home connection (Digiturk blocks datacenter IPs).
# Fetches the next week of Digiturk listings and force-pushes them as a single commit
# to the `relay` branch (no history growth). The GitHub build falls back to this file.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$REPO"
git pull -q --ff-only || true # latest fetcher code
node build.mjs --relay
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp relay/digiturk.json "$TMP/"
cd "$TMP"
git init -q -b relay
git add digiturk.json
git -c user.name="tvguide relay" -c user.email="relay@users.noreply.github.com" commit -q -m "Digiturk relay $(date -u +%FT%TZ)"
git push -q --force "$(git -C "$REPO" remote get-url origin)" relay:relay
echo "relay pushed $(date)"
