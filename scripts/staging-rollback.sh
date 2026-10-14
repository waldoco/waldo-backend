#!/usr/bin/env bash
# Roll the staging Worker back to one named earlier version. Pinned to --env staging so it can
# never resolve to the production Worker. wrangler's own prompt answers "yes" without a TTY or
# under CI, so this script refuses unless the version id is repeated via --confirm or
# ROLLBACK_CONFIRM. Pick the id from scripts/staging-gate.mjs output or
# `npx wrangler deployments list --env staging`. Durable Object state, secrets, edge functions
# and migrations are not rolled back. Run the gate again afterwards.
# Usage: scripts/staging-rollback.sh <version-id> --confirm <version-id> [--message <reason>]
set -euo pipefail
usage() {
  echo "usage: scripts/staging-rollback.sh <version-id> --confirm <version-id> [--message <reason>]" >&2
  exit 2
}
version="${1:-}"
[ $# -gt 0 ] && shift
confirm="${ROLLBACK_CONFIRM:-}"
reason="staging rollback"
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm) confirm="${2:-}" ;;
    --message) reason="${2:-}" ;;
    *) usage ;;
  esac
  [ $# -ge 2 ] || break
  shift 2
done
[[ "$version" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || usage
if [ "$confirm" != "$version" ]; then
  echo "refusing: repeat the version id with --confirm $version (or ROLLBACK_CONFIRM) to roll staging back" >&2
  exit 3
fi
cd "$(dirname "$0")/../packages/runtime"
exec npx --no-install wrangler rollback "$version" --env staging --message "$reason" --yes
