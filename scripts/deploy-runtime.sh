#!/usr/bin/env bash
# Deploy waldo-runtime with WALDO_RELEASE stamped to the current git SHA, so every
# Langfuse trace carries the exact code that produced it. Vars in wrangler.jsonc are
# only the fallback for local dev; this wrapper is the deploy path.
# Usage: scripts/deploy-runtime.sh            (production)
#        scripts/deploy-runtime.sh --env staging
set -euo pipefail
cd "$(dirname "$0")/.."
sha=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy a dirty tree - traces must name committed code" >&2
  exit 1
fi
cd packages/runtime
exec npx wrangler deploy --var "WALDO_RELEASE:${sha}" "$@"
