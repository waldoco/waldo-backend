#!/usr/bin/env bash
# Usage: merge-when-green.sh <pr>
# Waits until every check on the PR's current head has finished. Merges (merge commit,
# pinned to that head) only when all checks pass and the head did not move meanwhile.
# If the head moves, starts over on the new head. Exits 1 on any failing check.
# gh pr checks exits 8 while checks are pending and 1 when one failed, so its exit code is
# ignored here and only the reported states are read.
set -u
pr=$1
repo=waldoco/waldo-backend
checks() { gh pr checks "$pr" --repo "$repo" 2>/dev/null || true; }
while :; do
  head=$(gh pr view "$pr" --repo "$repo" --json headRefOid -q .headRefOid)
  state=$(gh pr view "$pr" --repo "$repo" --json state -q .state)
  [ "$state" = OPEN ] || { echo "#$pr is $state; nothing to do"; exit 0; }
  sleep 90
  while [ -z "$(checks)" ] || checks | cut -f2 | grep -q -E 'pending|queued'; do sleep 120; done
  now=$(gh pr view "$pr" --repo "$repo" --json headRefOid -q .headRefOid)
  if [ "$now" != "$head" ]; then echo "#$pr head moved ${head:0:8} -> ${now:0:8}; rechecking"; continue; fi
  states=$(checks | cut -f2 | sort -u | tr '\n' ' ')
  if [ "$states" = "pass " ]; then
    gh pr merge "$pr" --repo "$repo" --merge --match-head-commit "$head" || { echo "#$pr merge refused at ${head:0:8}"; exit 1; }
    echo "#$pr merged at ${head:0:8}: $(gh pr view "$pr" --repo "$repo" --json mergeCommit -q .mergeCommit.oid | cut -c1-8)"
    exit 0
  fi
  echo "#$pr NOT merged at ${head:0:8}: states=[$states]"
  checks | awk -F'\t' '$2!="pass"{print $1"\t"$2"\t"$4}'
  exit 1
done
