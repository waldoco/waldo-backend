# Progress watchdog: handoff to Ansh (4 Nov 2026)

Status: the lane stood down while it was still orienting. No code was written. Branch `claude/progress-watchdog` comes from `beta-mvp` 8455b0b9 and holds only this file.

## What I found [verified, from reading source at 8455b0b9]
- The job book `packages/runtime/src/tasks/jobs.ts` is the only writer. Every transition is fenced on (id, attempt, lease_token, status). The useful existing moves are `park(id, reason)`, `cancel(id, 'owner'|'forgotten')`, `running()`, `open()` and `nextDue()`.
- `tasks/lane.ts` `runJobsLane` already lapses expired leases, counts crashes (park at 3), defers when no provider answers, and parks at the deadline. A parked task reaches the owner through `parkedApplyText`, which uses `PARK_WORDS` from `prompt/fixed-lines.ts`. A parked machine job settles silently (`tasks/machine.ts` `applyMachineJob`).
- `WALDO_TASK_NOTES` is **not on beta-mvp**. It lives in open PR #1854 (`claude/task-ask-resume`, CONFLICTING), which makes parked machine jobs tell the owner. #1854 also rebuilds `task_jobs`: it adds `awaiting_owner` and `park_retries`.
- `park_reason` has a SQL CHECK in `do-schema.ts` `TASK_JOBS_TABLE_SCHEMA`. A new park reason therefore needs the same table-rebuild trigger as at the top of `jobBook()`. It will conflict with #1854's rebuild, but the conflict is mechanical (OR the conditions together).
- The lane runs from `OwnerDO.drainJobs` (`channels/owner-do.ts` about line 3274). It runs only while `TASK_JOBS_DUE_KEY` is due, and only for an admitted owner. `machineRoom(alarmEnd)` gates model time.
- A worker re-claims at every 10-minute slice (`worker-do.ts` `TASK_ALARM_SLICE_MS`). Each claim rebuilds the brief text (`worker-loop.ts` `taskBriefText`), so the claim can carry a nudge.
- The cross-owner admin reads (`dashboard-health.ts`, `admin-spend.ts`) go through signed Supabase RPCs. The watchdog's findings would live in each owner's DO, so a cross-owner view needs a sync plus an RPC (migration).
- Test harness to copy: `test/task-lane.test.ts`. It runs the real job book on DO SQLite with a fake clock, fake turns and a fake outbox.

## Proposed design [proposed, not reviewed by the gate]
1. **New `tasks/watchdog.ts`.** Call it at the end of `drainJobs` when `WALDO_WATCHDOG === '1'` and its KV due time has passed. Fold its next check (10 minutes while any job is open) into `TASK_JOBS_DUE_KEY`. That keeps a lost or late jobs wake alive, which repairs a stuck alarm. A DO alarm that is fully dead shows up as a stale `last_check_at` in the operator read.
2. **Liveness = facts, recorded and re-checked until clear.** Codes: `alarm_late` (a due job long overdue), `crash_repeat`, `provider_errors` (deferrals rising), `stalled` (lease renewed but no checkpoint for more than 2 slices). The lane still owns lapse, defer and park; the watchdog duplicates none of them.
3. **Progress = the model's judgment.** Applies to running `task` and machine rows only, and only after at least 4 new checkpoint rounds and at least 10 minutes per job, with at most N=6 judgments per owner per hour. The cheap judge (owner's auxiliary route, the way `taskModel` builds it) gets the brief, the checkpoint turns trimmed to tool, args and a short output, and the timings. It returns `{verdict: progressing|looping|drifting|stalled, action: none|nudge|park, note?}` as JSON. At most 2 nudges per job. No regex prefilter, per CLAUDE.md.
4. **Acts only through the book.**
   - A nudge is stored, then delivered on the next `claim` as an optional `TaskClaim.nudge`, appended by `taskBriefText`. Its text is dropped if `numericHealthIn` finds a health value in it.
   - A park is `book.park(id, 'no_progress')`, a new `ParkReason`, with the PARK_WORDS line "it stopped getting closer to what you asked". The owner hears it through the existing parked-apply path, and through #1854's notes for machine jobs once that merges.
   - Cancel: I propose no watchdog cancel. Cancel is the owner's word and drops the report without telling them; a park tells them honestly. The owner's brief asked for cancel, so Ansh or the owner decides.
5. **Storage:** a `watchdog_findings` table (job_id, job_kind, bounded code, action, checkpoint seq, at, cleared_at, pending nudge text cleared on delivery). Keep the newest 200.
6. **Operator view:** `GET /console/dashboard/api/v1/watchdog`, rate-limited with `consoleRateLimited('read')`. It returns `last_check_at`, checks in the last hour, counts by code over 24 hours, and the last 50 findings (job id, kind, code, action, times). Codes and counts only. Logs carry a `watchdog_check` hop with code, action and job_id, and no text. A cross-owner admin view via Supabase is a follow-up that needs a migration.
7. **Switch:** `WALDO_WATCHDOG` is "1" in staging and "0" in production. It also goes in `wrangler.jsonc`, the `telegram-webhook.ts` env type, `evals/nightly/staging-profile.ts`, and a config test like `approve-in-chat.test.ts`.

## Tests to write first (time-mocked, on the task-lane harness)
- **Stuck lease or late alarm:** a finding is recorded, re-checked, and cleared.
- **Looping worker:** a nudge is delivered at the claim; a second looping verdict parks the job with `no_progress` and the owner hears PARK_WORDS.
- **Drifting worker:** the job is nudged.
- **Healthy worker:** it is left alone and not judged again until new rounds arrive.
- **Budget:** no more than N judgments per hour.

The design note was never posted on #1449. Post it there and get the gate's review before writing code.
