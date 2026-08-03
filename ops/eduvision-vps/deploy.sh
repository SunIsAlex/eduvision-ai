#!/bin/sh
set -eu

repo=/opt/eduvision-ai
branch=${EDUVISION_BRANCH:-tencent-edge-functions}
export HOME=/var/cache/eduvision-deploy
export npm_config_cache=/var/cache/eduvision-deploy/npm

cd "$repo"
git fetch --prune origin
git checkout -B "$branch" "origin/$branch"
npm ci --no-audit --no-fund
npm run build
systemctl restart eduvision-ai.service

for attempt in 1 2 3 4 5; do
  if curl --silent --fail http://127.0.0.1:8791/health >/dev/null; then
    git rev-parse HEAD
    exit 0
  fi
  sleep 2
done

systemctl status eduvision-ai.service --no-pager >&2 || true
exit 1
