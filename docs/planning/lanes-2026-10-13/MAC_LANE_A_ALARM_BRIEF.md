# Mac lane A: finish #1180 (alarm fallback, the F2′ fix) and #1186 (wake keys, the tip carry)

Written by the Mac orchestrator on 14 Oct 2026, about 01:55Z, under the owner's takeover ruling (digest item 36).
- The builder has posted nothing since 22:30Z, and neither PR's head has moved since the Mac's reviews.
- The review session lists both PRs as the Mac's (#1103 6158960540).
- The owner's bar applies (digest item 35): no rash decisions, and mature practice cited for every ambiguous point.

## Read first
- `CLAUDE.md`, `.claude/rules/INDEX.md` with its five rule files, and `AGENTS.md`.
- The Mac's review of #1180, revision 2.1: PR comment 6156425016. It has the four throw shapes (a) to (d), the F2′ code, the M1 tests, and design calls M2 to M4.
- The Mac's review of #1186: PR comment 6156425528, including its carry note.
- The board summary: #1103 6156431069.

## #1180 at `5175c977`, branch `claude/alarm-fallback-rearm`: implement F2′
- **Keep the PR's core:** arm a wake on every throw.
- **Replace the fixed 30-minute delay with handler-owned backoff (F2′):**
  - A failure streak is stored in one integer KV key in the owner object's storage. The name is your choice; `owner_alarm_failures_v1` is what the probe used. Delete the key on a successful pass.
  - On a throw, arm `now + min(2 s × 2^(streak−1), 30 min)`, log a content-free `{hop:'alarm', ok:false, code:'retry_scheduled', streak}`, and **return**. Never rethrow.
  - Remove the dead code: `info`, `PLATFORM_ALARM_RETRIES`, the `last` branch, and test 3.
- **Jitter:** add a stable per-owner fraction of the floor, derived from the object id, as AWS advises. If you do, test it. Otherwise list it as a follow-up.
- **Tests (M1).** Replace the tests that invent `AlarmInvocationInfo` with real-scheduler tests:
  - arm `Date.now() + 100` on a real `OWNER_DO` stub and spy on `OwnerDO.prototype.alarm`;
  - **(a)** a throw before `drainApp`'s re-arm, **(b)** a throw after the in-handler delete, **(d)** a future wake armed and then a throw: each gets a second invocation within about 3 s;
  - **(c)** a past-due key and then a throw: at most 3 invocations in 9 s;
  - **reset on success:** the streak key is gone, and the next wake is the arbiter's;
  - **a unit test of the floor and the 30-minute cap.**

  Write them red first against `5175c977`, and record the failures.
- **M4 (the seam with #1186):** #1186's arbiter drops any wake that has no key, which includes F2′'s retry wake. Give the retry wake a key in #1186's one list, for example a `*_due_vN` key holding the retry time. Then a re-arm outside the handler can't drop it, and the guard can see it.
  - If keying it needs a design decision you can't settle from the code and the docs, document the drop instead, and flag it for the lead.
- **Not yours to decide; flag for the lead:** whether the arbiter's 250 ms floor should back off (M2), and whether `rearmSharedAlarm` should stop deleting the alarm inside the handler (M3).

## #1186 at `2633aae0`, branch `claude/wake-due-keys`, stacked on #1180
1. Once #1180 is pushed, merge #1180's branch into #1186, then `origin/beta-mvp` (the tip), with merge commits.
2. **The carry:** the one conflict is `rearmSharedAlarm` in `scheduler/alarm-slot.ts`. Take #1186's loop, and add `'mac_results_due_v1'` to `WAKE_DUE_KEYS`. Without that key, the new guard fails on `devices/mac-delivery.ts`.
   - That key is only registered, not changed. `use_mac`'s code stays untouched, and the PR body says so as an FYI for Ashish.
3. Add the test gap from the review: maintenance's "move to the live lease deadline" branch.

## Rules
- **Compare-and-swap:** read the PR head right before every push. If it isn't `5175c977` or `2633aae0` (or your own last push), stop and report: the builder may be back.
- **Commits:** normal and merge commits only. Never force-push, never rebase a published branch, never use `--no-verify`. Each commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **PR bodies:** update each one, with a "Prior art and decisions" section that cites Cloudflare's Durable Object alarms docs, workerd's `alarm-scheduler.c++`, and the AWS Builders' Library on backoff and jitter.
- **Comments:** post one comment per PR after your push. Never post on #1103.
- **Verify** at each final head, stage by stage:
  - `git diff --check`;
  - `verify:guards` (pgTAP is UNAVAILABLE);
  - `pnpm -r typecheck`;
  - the PR tests;
  - the full runtime suite and the non-Supabase configs.

  Run `pgrep -fl '[v]itest[.]mjs'` before any suite. Never run `supabase`.
- **Limits:** no subagents, no secrets, no health values. About 250 tool calls.

## Report back, in at most 25 lines
- both heads, and whether the compare-and-swap passed;
- red-first evidence;
- the M4 decision;
- each verify stage;
- CI;
- flags for the lead.
