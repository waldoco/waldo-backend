#!/bin/bash
# Full gate run for the MVP worktree. Log: ~/.waldo-mvp/gates.log
# The exit code is the gate: any failed step fails the run (bug log 2026-09-24).
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd ~/Developer/Pin4sf/waldo-backend-mvp
FAIL=0
{
  echo "HEAD $(git rev-parse --short HEAD)"
  npx -y pnpm@10.34.4 install --frozen-lockfile >/dev/null 2>&1 && echo "INSTALL ok" || { echo "INSTALL fail"; FAIL=1; }
  npx -y pnpm@10.34.4 -r typecheck >/tmp/tc.log 2>&1 && echo "TYPECHECK ok" || { echo "TYPECHECK fail"; grep "error TS" /tmp/tc.log | head; FAIL=1; }
  node scripts/guards/run-all.mjs >/tmp/guards.log 2>&1 && echo "GUARDS ok" || { echo "GUARDS fail"; grep -iv ": ok" /tmp/guards.log | head; FAIL=1; }
  (cd packages/contracts && set -o pipefail && npx vitest run 2>&1 | grep -aE "Test Files|Tests ") || FAIL=1
  (cd packages/runtime && set -o pipefail && npx vitest run 2>&1 | grep -aE "Test Files|Tests | FAIL ") || FAIL=1
  echo "EXIT"
} > ~/.waldo-mvp/gates.log 2>&1
exit $FAIL
