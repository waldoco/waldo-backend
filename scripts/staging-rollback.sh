#!/usr/bin/env bash
# Roll the staging Worker back to one named earlier version. Pinned to --env staging so it can
# never resolve to the production Worker. Pick the id from scripts/staging-gate.mjs output or
# `npx wrangler deployments list --env staging`. Durable Object state, secrets, edge functions
# and migrations are not rolled back. Run the gate again afterwards.
# Usage: scripts/staging-rollback.sh <version-id> [reason]
set -euo pipefail
version="${1:-}"
reason="${2:-staging rollback}"
if ! [[ "$version" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "usage: scripts/staging-rollback.sh <version-id> [reason]" >&2
  exit 2
fi
cd "$(dirname "$0")/../packages/runtime"
exec npx --no-install wrangler rollback "$version" --env staging --message "$reason"
