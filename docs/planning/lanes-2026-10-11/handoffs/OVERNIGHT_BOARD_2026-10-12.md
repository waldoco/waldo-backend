# Overnight board, 12 Oct 2026

The orchestrator's standing instructions to the lanes. Cross-session messages are capped, so this file is the main channel from the orchestrator to the lanes.

**Read it** at the start of every new task and after you open or update a PR:

```bash
git -C /Users/shivanshfulper/Developer/Pin4sf/waldo-backend fetch -q origin && git -C /Users/shivanshfulper/Developer/Pin4sf/waldo-backend show origin/docs/overnight-2026-10-12:docs/planning/lanes-2026-10-11/handoffs/OVERNIGHT_BOARD_2026-10-12.md
```

Orchestrator: `local_281f8c04-1fc5-41f4-8fc8-4ac9e6558cf3`. The owner is asleep until about 02:30Z. Decisions here are the orchestrator's delegated decisions, not owner rulings.

## How to hand me a PR (no message needed)

1. Put the PR's claims in its body: what changes, which tests prove it, PASS / FAIL / NOT RUN / UNAVAILABLE at the exact head SHA, and the owner-visible behavior change.
2. Mark it **ready for review** (not draft) only when you want it merged. I check `gh pr list` every heartbeat (about every 20 minutes).
3. Message me only for an urgent blocker or an owner question. One combined message per lane per cycle.

I merge after: CI green on the current head (pgTAP included), an independent review, and GitHub mergeable/clean. **Held for the morning even when green:** migrations or DO migration lineage; auth, sessions, user isolation, secrets, new public endpoints or external integrations; anything that widens where health data goes or changes consent, privacy or deletion. Review findings come back to you on this board.

## Rules for tonight

- Don't put blocking questions to the owner (AskUserQuestion stops your lane). Owner questions go to me.
- Don't approve, skip or defer a real staging approval: it can send mail or create events. The approval round trip on the owner's account is an owner task.
- Don't post on #116 unless your own lane rules already allow it.

## Per lane

### L1 (health plane, staging deploys)
- **Live:** `4bb040f5` (Worker version `65a07f13`). Main chat GET 200 at 21:39:37Z; skip line `input_origin`, 1, 0.
- **Standing go confirmed** (the owner's yes in L1's session, seen in L1's transcript at 21:50Z): overnight deploys of `beta-mvp` tips through your gate script, until the owner is back.
- **Next:** deploy when I say a tip is worth it on this board (look for a line `DEPLOY: <sha>` here), or when you see a merge I logged as deploy-worthy. Then the read and send probes, posted as before. The retention cron check at 03:17Z stays yours.

### L2 (identity, delivery router; critical path)
- **Order:**
  1. The send-path follow-up (load skip + in-memory re-link).
  2. #1066, after a merge from the current base.
  3. The `defer` desk branch (it unblocks "Not now", which #1070's guard answers with 409 today). Confirm it has no DO migration.
  4. The S7 keyless spike.
- **Follow-up review checklist:** a skipped leaf (append lands under the nearest loadable ancestor and shows in the GET); a skipped parent with a loadable child; a witness that differs stays fatal; no storage writes from the loader; `appDeliveryFor` succeeds past a bad row; fixed codes and counts only; one shared skip rule with `readForDisplay`; each test mutation-checked.
- My grep at `4bb040f5` finds two strict `load()` callers of the canonical store: `owner-turn.ts:557` (`restored()`) and `telegram-owner-do.ts:590` (scheduled app delivery). `readForDisplay` is `:670`. `conversationForgetSources` reads raw rows and doesn't validate.

### L3 (approvals, app contracts, Google connect)
- **Your lane rule holds:** every push, PR, merge or GitHub post needs the owner's yes in your session. Nothing of yours is pushed or opened tonight, by you or by me.
- **Morning batch:** `L3_MORNING_BATCH_2026-10-12.md` at your worktree root (uncommitted), as AskUserQuestion-ready options with your recommendation. Cover: open the reminder-push contract PR (with the wall result at its SHA), the ADR-0068 one-liner, and the four approvals decisions. I read it at about 01:45Z.
- **Local work, in order:**
  1. The approvals gap proposal, to L2 and L4.
  2. The Brief `latest` reader, red first, null until L2's day_plan PR.
  3. A read-only readiness check of Google connect on `4bb040f5`: routes, scopes vs the site's "read only" labels, token storage, app error states. Findings go in your batch file.

### L4 (waldo-app)
- **Time-zone write, option (a), is an owner ruling.** Build it: write the device zone via `timezone.set` only while `timezone_confirmed` is false and the stored zone is still `'UTC'`.
- **Then:** the Simulator chat check once L2's follow-up is deployed, and design-system rows on the golden path.
- **The app repo has no CI.** Before I merge an app PR, I run `pnpm run check` and `pnpm test` myself at the exact head, in a fresh detached worktree. Put your own results in the PR body too.
