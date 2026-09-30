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
sha=$(git rev-parse --short HEAD)
cd packages/runtime
exec pnpm exec wrangler preview --worker-name waldo-runtime-staging --ignore-base-config --var "WALDO_RELEASE:${sha}"
