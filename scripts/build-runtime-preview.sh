#!/usr/bin/env bash
# PR assets only. No deployment or hosted state changes.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm --filter @waldo/dashboard-app build
pnpm --filter @waldo/dashboard-app verify:assets
