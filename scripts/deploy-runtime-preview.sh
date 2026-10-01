#!/usr/bin/env bash
# PR preview only: never deploy or promote a named staging/production environment.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -ne 0 ]; then
  echo 'preview wrapper accepts no deploy/environment overrides' >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo 'refusing preview from a dirty tree' >&2
  exit 1
fi
full_sha=$(git rev-parse HEAD)
branch=$(git symbolic-ref --quiet --short HEAD || true)
preview_name=$(node scripts/runtime-preview-name.mjs "$branch" "${WORKERS_CI_BRANCH:-}")
cd packages/runtime
exec pnpm exec wrangler preview --worker-name waldo-runtime-staging --ignore-base-config --var "WALDO_RELEASE:${full_sha}" --name "${preview_name}"
