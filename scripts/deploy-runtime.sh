#!/usr/bin/env bash
# Deploy waldo-runtime with WALDO_RELEASE stamped to the current git SHA, so every
# Langfuse trace carries the exact code that produced it. Vars in wrangler.jsonc are
# only the fallback for local dev; this wrapper is the deploy path.
# Usage: scripts/deploy-runtime.sh --env staging [wrangler deploy flags]
# Staging is the only target. With no --env, wrangler deploys the top-level (production) Worker, and --env beta would
# create the beta Worker with its Durable Object namespaces, R2 bucket and custom domain: each of those is a separate
# owner-approved step in docs/ops/BETA_ENVIRONMENT_2026-11-04.md, never this wrapper's default.
set -euo pipefail
refuse() {
  echo "refusing: only 'scripts/deploy-runtime.sh --env staging' deploys (docs/ops/BETA_ENVIRONMENT_2026-11-04.md)" >&2
  exit 2
}
[ "${1:-}" = "--env" ] && [ "${2:-}" = "staging" ] || refuse
for arg in "${@:3}"; do
  case "$arg" in -e|-e=*|--env|--env=*) refuse ;; esac
done
cd "$(dirname "$0")/.."
sha=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy a dirty tree - traces must name committed code" >&2
  exit 1
fi
pnpm --filter @waldo/dashboard-app build
pnpm --filter @waldo/dashboard-app verify:assets
cd packages/runtime
exec npx wrangler deploy --var "WALDO_RELEASE:${sha}" "$@"
