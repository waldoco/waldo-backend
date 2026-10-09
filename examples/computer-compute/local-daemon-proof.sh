#!/bin/bash
set -euo pipefail
trial_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$trial_root"
trial_id=''
cleanup() {
  trial_status=$?
  trap - EXIT
  if [ -n "$trial_id" ]; then
    docker logs "$trial_id" 2>&1 | tail -n 80 || true
    docker rm --force "$trial_id" >/dev/null 2>&1 || true
    trial_remaining=$(docker ps -aq --filter "id=$trial_id")
    if [ -n "$trial_remaining" ]; then
      echo 'CLEANUP_FAILED: trial container still exists'
      exit 1
    fi
    echo 'CLEANUP_VERIFIED: trial container absent'
  fi
  exit "$trial_status"
}
trap cleanup EXIT
docker build --platform linux/amd64 -t waldo-computer-trial:local examples/computer-compute
trial_id=$(docker run --detach --rm --platform linux/amd64 --memory 512m --cpus 1 --pids-limit 128 -p 127.0.0.1:8080:8080 waldo-computer-trial:local)
for trial_attempt in $(seq 1 20); do
  if curl --silent --fail --max-time 1 http://127.0.0.1:8080/health >/dev/null; then break; fi
  sleep 0.2
done
curl --silent --fail --max-time 2 http://127.0.0.1:8080/health >/dev/null
cd packages/runtime
COMPUTERD_HARNESS_URL=http://127.0.0.1:8080 pnpm exec vitest run --config vitest.computer-daemon.config.ts
