#!/usr/bin/env bash
# Full verify wall, segment by segment, serialized across worktrees.
# Usage: bash /home/user/wt/wall.sh <worktree-dir>
# Writes <worktree-dir>/.wall/<sha>.txt with one PASS/FAIL line per segment.
set -uo pipefail

WT="$(cd "${1:?worktree dir}" && pwd)"
LOCK=/home/user/wt/wall.lock
PNPM="npx -y pnpm@10.34.4"

# Two wall slots: a wall takes 8-10 minutes, and two fit on 4 cores and 15 GB.
# Slot 1 is the original lock file, so walls started under the one-slot runner
# keep competing for it.
echo "waiting for a wall slot..."
while :; do
  exec 9>"$LOCK"; flock -n 9 && break
  exec 9>"$LOCK.2"; flock -n 9 && break
  exec 9>&-; sleep 10
done
cd "$WT"
SHA="$(git rev-parse HEAD)"
OUT="$WT/.wall/$SHA.txt"
mkdir -p "$WT/.wall" "$WT/.wall/logs"
grep -qxF '.wall/' "$(git rev-parse --git-common-dir)/info/exclude" 2>/dev/null \
  || echo '.wall/' >> "$(git rev-parse --git-common-dir)/info/exclude"
: > "$OUT"
echo "wall at $SHA, started $(date -u +%FT%TZ)" | tee -a "$OUT"

seg() {
  local name="$1"; shift
  local log="$WT/.wall/logs/${SHA:0:8}-${name//[^a-zA-Z0-9]/_}.log"
  local start=$(date +%s)
  if "$@" >"$log" 2>&1; then r=PASS; else r="FAIL(exit $?)"; fi
  printf '%-40s %s  %ss  %s\n' "$name" "$r" "$(( $(date +%s) - start ))" "$log" | tee -a "$OUT"
}

seg install          $PNPM install --frozen-lockfile
seg dashboard-build  $PNPM --filter @waldo/dashboard-app build
seg bundle-skills    node packages/runtime/scripts/bundle-skills.mjs --check
seg guard-pkg-mgr    node scripts/guards/guard-package-manager.mjs
seg typecheck        $PNPM -r typecheck
seg verify:node      $PNPM verify:node
# The local Supabase stack needs container images this environment cannot pull
# (public.ecr.aws answers "Data limit exceeded", Docker Hub answers 429), so
# verify:supabase (and its pgTAP tests) is UNAVAILABLE here unless the stack is up.
if npx -y supabase@2.109.1 status >/dev/null 2>&1; then
  seg verify:supabase  $PNPM verify:supabase
else
  printf '%-40s %s\n' "verify:supabase" "UNAVAILABLE (Supabase images cannot be pulled in this container; PR CI covers it)" | tee -a "$OUT"
fi
# verify:workers (the ~543-file workerd suite) ran over an hour on this shared 4-core
# container, which serializes every lane behind one lock. PR CI runs it in four
# shards on the pushed head; that is the arbiter unless WALL_WORKERS=1 is set.
if [ "${WALL_WORKERS:-0}" = 1 ]; then
  seg verify:workers   $PNPM verify:workers
else
  printf '%-40s %s\n' "verify:workers" "NOT RUN locally (PR CI shards 1-4 on the pushed head are the arbiter)" | tee -a "$OUT"
fi
# verify:guards = a node --test batch, then run-all.mjs, which stops at the first
# failing guard. guard-pgtap needs Postgres .debs under /root/debs that this
# container lacks, so run each guard on its own and mark only that one UNAVAILABLE.
GUARD_TESTS="$(node -e 'const s=require("./package.json").scripts["verify:guards"];process.stdout.write(s.split(" && node scripts/guards/run-all.mjs")[0])')"
seg guards:node-test bash -c "$GUARD_TESTS"
for g in $(ls scripts/guards/*.mjs | grep -v run-all.mjs | sort); do
  name="guard:$(basename "$g" .mjs)"
  if [ "$(basename "$g")" = guard-pgtap.mjs ] && ! ls /root/debs/postgresql-15_*.deb >/dev/null 2>&1; then
    printf '%-40s %s\n' "$name" "UNAVAILABLE (needs Postgres .debs in /root/debs; PR CI pgTAP job covers it)" | tee -a "$OUT"
  else
    seg "$name" node "$g"
  fi
done
seg test:scenarios   $PNPM --filter @waldo/runtime test:scenarios
seg test:owner-ingress $PNPM --filter @waldo/runtime test:owner-ingress
seg diff-check       git diff --check "$(git merge-base origin/beta-mvp HEAD)" HEAD
echo "wall at $SHA, finished $(date -u +%FT%TZ)" | tee -a "$OUT"
