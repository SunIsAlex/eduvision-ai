#!/bin/sh
set -eu

repo=/opt/eduvision-ai
config_dir=/var/lib/eduvision-ai
config_file=$config_dir/config.env
branch=${EDUVISION_BRANCH:-main}
export HOME=/var/cache/eduvision-deploy
export npm_config_cache=/var/cache/eduvision-deploy/npm

cd "$repo"
git fetch --prune origin
git checkout -B "$branch" "origin/$branch"
npm ci --no-audit --no-fund
npm run build
install -d -o eduvision -g eduvision -m 700 "$config_dir"
if [ ! -f "$config_file" ]; then
  install -o eduvision -g eduvision -m 600 /etc/eduvision-ai.env "$config_file"
fi
install -o root -g root -m 644 ops/eduvision-vps/eduvision-ai.service /etc/systemd/system/eduvision-ai.service
systemctl daemon-reload
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
