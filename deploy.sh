#!/usr/bin/env bash
# Auto-deploy: pull latest main, reinstall if needed, migrate, rebuild the
# web export, restart the backend. Run by the webhook listener on a GitHub
# push, or by hand: ~/apps/kl-electricals/deploy.sh
set -euo pipefail

REPO=~/apps/kl-electricals
LOG=~/deploy.log

# This script is tracked INSIDE the repo it hard-resets below, so the copy on
# disk can be replaced while it is still executing. Re-exec from a snapshot
# outside the tree first, so the running copy is immutable for the whole run --
# same reasoning that keeps CONFIG out of the repo, applied to the script.
# A deploy therefore runs the deploy.sh of the commit it started from, which is
# also what you want: the new one takes effect on the next push, after review.
if [ "${DEPLOY_SNAPSHOT:-}" != "1" ]; then
  _snap=$(mktemp /tmp/deploy-kl.XXXXXXXX.sh)
  cp -- "${BASH_SOURCE[0]}" "$_snap"
  chmod +x "$_snap"
  export DEPLOY_SNAPSHOT=1
  exec "$_snap" "$@"
fi
# Running as the snapshot from here on; clean it up however we exit.
trap 'rm -f -- "$0"' EXIT
# Kept outside the repo so `git reset --hard` in this script never touches
# it, and so the public URL can be repointed (tunnel today, the VM's own
# address once port 80 is forwarded) without editing this file.
CONFIG=~/ops/deploy.env

exec >> "$LOG" 2>&1
echo "===== deploy started $(date -u +%FT%TZ) ====="

if [ -f "$CONFIG" ]; then
  source "$CONFIG"
fi
: "${PUBLIC_URL:?PUBLIC_URL not set in $CONFIG}"

cd "$REPO"
git fetch origin main
git reset --hard origin/main

npm install

cd "$REPO/backend"
# Applies whatever migrations shipped in this push. Never rebuild-schema or
# build-init-sql here — those are authoring-time steps for whoever wrote the
# migration; regenerating them on the deploy box would create local changes
# the server has no business making.
npm run migrate

cd "$REPO"
# --clear + wiping the cache directories ourselves: Metro's persistent
# transform cache is keyed on source content, not on the injected
# EXPO_PUBLIC_* env values, so a plain re-export can silently reuse a
# previous build's bundle — same API URL as last time, reported as a
# successful export. Caught this once already; never skip the clear.
rm -rf dist .expo node_modules/.cache
EXPO_PUBLIC_API_URL="$PUBLIC_URL" npx expo export -p web --clear

# Sanity check: refuse to ship a build that doesn't actually point at
# today's PUBLIC_URL — better a failed deploy than a silently stale one.
BUNDLE=$(grep -o '_expo/static/js/web/index-[a-f0-9]*\.js' dist/index.html)
if ! grep -q "$PUBLIC_URL" "dist/$BUNDLE"; then
  echo "REFUSING TO DEPLOY: dist/$BUNDLE does not contain $PUBLIC_URL"
  exit 1
fi

pm2 restart kl-backend
# nginx serves dist/ fresh off disk on every request — no reload needed for
# a rebuilt web export, only for a change to the nginx config file itself.

echo "===== deploy finished $(date -u +%FT%TZ) ====="
