# Heartbeat monitor + owner-defined cron schedules - plan (2026-09-26)

Owner ask (WhatsApp, 2026-09-26 ~01:51 IST): add (1) a general heartbeat monitor - periodic
agent check-ins / due-work scans, quiet when nothing needs attention, bounded work per tick,
actionable receipts - and (2) owner-defined arbitrary cron schedules - timezone-aware next run,
durable while the laptop is off, pause/resume/edit/cancel, missed-run and retry policy,
dedupe/concurrency limits, truthful run history. Research + plan for review; no merge, no deploy.
Approval gates for external effects are preserved throughout: creating a schedule never implies
permission to send, spend, or delete.

Pins: beta-mvp = a796554ef80409c2bbd5d07ce2f1f8e702c5c41f.

STATUS OF THIS DOCUMENT: this is a PLAN. Nothing in section 4 (H1, C1-C4) is implemented. Only
section 1 rows marked WIRED exist in code at the pinned SHA; every PARTIAL/missing row and every
numbered slice is proposed work awaiting owner review.

## 1. What is already wired (source-pinned)

| Piece | State | Evidence |
|---|---|---|
| Durable schedule table | WIRED | `schedule` rows: id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts, last_fired_at, quarantined_until (scheduler/multiplexer.ts:20-33). DO SQLite = durable with the laptop off. |
| Single alarm-slot ownership | WIRED | scheduler/alarm-slot.ts is the only `setAlarm` in the repo (ADR-0065, accepted: do-alarm-multiplexer); a guard blocks the call everywhere else. |
| Bounded work per tick | WIRED | MAX_DUE_PER_ALARM = 8, DUE_LOOKAHEAD_MS = 1s (multiplexer.ts:13-14): one alarm drains at most 8 due entries. |
| Retry + quarantine policy | WIRED | 30s product retry, 15min durability retry cap, quarantine after 3 attempts for 24h (multiplexer.ts:15-18). |
| Recurrence model | PARTIAL | interval (every_ms + phase) and daily_local (HH:MM, owner timezone) (contracts/src/runtime/schedule.ts). No weekly/cron-expression form. |
| Timezone-aware next run | WIRED for daily_local | nextWakeBound + daily_local recurrence compute against the owner timezone. |
| Kinds registry | WIRED | journal, handoff, pre_activity_spot, brief, pre_brief_sweep, patrol, dreaming, reminder (schedule.ts). Owner-visible today: reminder, brief, patrol-ish day cards. |
| Reminders | WIRED | channels/reminders.ts reminderBook: set/list/cancel tools, daily repeat via nextAfter. One-shot + daily only. |
| Day cards / brief sweep / nightly | WIRED | armed via armDayCards/armBriefSweep/armNightly (telegram-owner-do.ts:650). Fixed product cadences, not owner-defined. |
| Latest-run state per entry | WIRED (data) | status, attempts, last_fired_at on the schedule row (multiplexer.ts:20-33). This is the CURRENT state of one entry, overwritten each fire - not a per-run history. |
| Quiet hours | WIRED | loops.ts proactivity (quiet_start/quiet_end) gates briefs and day cards. |

## 2. What is missing

For the heartbeat monitor:
- H-a. No general "check-in tick" kind: existing kinds are product-specific (brief, nightly,
  patrol). Nothing runs a periodic due-work scan that can stay silent.
- H-b. No quiet-by-default receipt discipline: today every card/sweep either sends or holds
  silently; there is no "checked, nothing needed" receipt convention (or an explicit decision to
  send nothing at all).
- H-c. No owner-visible tick history ("what did the heartbeat do at 9am").

For owner-defined cron:
- C-a. No cron-expression recurrence (only interval + daily_local).
- C-b. No owner-facing create/pause/resume/edit/cancel surface for arbitrary schedules (reminders
  cover one-shot + daily only; console has no schedule manager).
- C-c. No per-schedule dedupe/concurrency policy (the multiplexer bounds per-tick work but has no
  "one run of schedule X at a time" rule).
- C-d. No missed-run policy beyond retry/quarantine (e.g. "if the DO was asleep through 3
  occurrences, fire once and note the skip").
- C-e. No per-run history at all: the schedule row keeps only latest-run state (status, attempts, last_fired_at), overwritten on every fire. Truthful history needs an append-only run-log table; nothing stores or renders per-run outcomes today. The earlier draft of this plan called the latest-run state "run history" - corrected here.

## 3. Mature implementations compared (sources from the repo's own vetted research)

- **Cloudflare Durable Object alarms** (https://developers.cloudflare.com/durable-objects/api/alarms/):
  the platform primitive Waldo already builds on - one alarm slot per DO, durable across restarts.
  ADR-0065's multiplexer is the right shape; nothing here needs replacing.
- **OpenClaw automation** (https://docs.openclaw.ai/automation, cron schedules:
  https://docs.openclaw.ai/automation/cron-jobs/schedules, heartbeat/ln: https://docs.openclaw.ai/ln):
  distinguishes explicit jobs/standing orders from ln-style assessment; ln is opt-in and designed
  to stay silent when nothing matters. The PR31 source audit
  (docs/research/WALDO_BRAIN_PR31_SOURCE_AUDIT_2026-09-18.md) already adjudicated this: ADOPT
  desired-state-vs-persisted-occurrence reconciliation, quiet no-op assessments, flood controls;
  do NOT make a HEARTBEAT.md file the scheduler.
- **Hermes cron** (https://hermes-agent.nousresearch.com/docs/user-guide/features/cron):
  one-shot + recurring jobs, fresh sessions per run, optional continuity that suppresses
  unchanged reports, and SEPARATE run / scheduler-handoff / delivery error fields - the truthful
  run-history model to copy.
- **Waldo Brain's own patrol history** (docs/planning/WALDO_BRAIN_RECONCILIATION.md): the old
  HEARTBEAT_PATROL mechanics are deprecated; keep the product idea (quiet background watch, caps,
  quiet hours), and the launch contract rules out engagement-seeking patrol. The heartbeat must
  never message the owner without a reason.

## 4. Smallest regression-led implementation plan

H1. Heartbeat tick kind (no owner surface yet).
- Add schedule kind `heartbeat` (or reuse `patrol` if its semantics fit - decide in review) armed
  on a fixed conservative interval (30-60 min) per owner DO.
- The tick runs a bounded due-work scan: due reminders, open loops past due, held briefs that
  quiet hours released. Per-tick cap already exists (MAX_DUE_PER_ALARM).
- Quiet by default: a tick that finds nothing writes a one-line run-history row and sends
  nothing. A tick that acts sends the action with its reason (the actionable receipt).
- Tests: silent tick writes history and sends nothing; due-work tick sends exactly the due item;
  flood control - N findings produce at most one message.

C1. Cron-expression recurrence.
- Extend the recurrence union with `cron` (5-field expression + owner timezone); next-run computed
  from the expression in the owner's timezone. Tests: expression -> next occurrence across DST
  boundaries and month edges; invalid expression rejected at create time.

C2. Owner schedule surface (console + chat).
- Tools/console: create (kind = owner_task, prompt text the owner dictates), list, pause, resume,
  edit, cancel. Every mutation is an owner action on their own DO; no approval desk needed for the
  schedule itself.
- HARD RULE: a scheduled task that would send, spend, or delete hits the existing approval desk
  at RUN time like any other action - creating the schedule grants nothing.
- Tests: pause suppresses runs without deleting history; resume recomputes next run from now;
  cancel tombstones; edit re-parses the expression.

C3. Dedupe/concurrency + missed-run policy.
- One active run per schedule id (an occurrence that is still running blocks the next; the skip
  is recorded, not lost).
- Missed runs: on wake, fire the latest missed occurrence once, record skipped intermediates as
  `missed` in run history. Existing retry/quarantine unchanged.
- Tests: two overlapping occurrences dedupe to one run + one skip record; a 3-occurrence gap
  fires once with two missed rows.

C4. Truthful run history surface.
- New append-only `schedule_runs` table (schedule_id, fired_at, duration_ms, outcome,
  error_class with the Hermes-style split: run error vs scheduler-handoff error vs delivery
  error). Every fire writes one row before any side effect, and updates it at settle - a row
  that never settles IS the crashed-run evidence.
- Console "schedules" section renders from schedule_runs: per schedule, last fired, attempts,
  outcome, next run in owner timezone; per run, its real error class.
- Test: a failed run shows its real error class, not a generic "failed".

Order: H1 and C1 are independent; C2 gates C3's owner value; C4 can land any time after H1.
No vector/graph, no schema churn beyond the recurrence union + kind.

## 5. Explicitly not in this plan

- Engagement-seeking patrol (launch contract, WALDO_BRAIN_RECONCILIATION).
- A HEARTBEAT.md-style file as scheduler state (PR31 audit: rejected).
- Any change to approval-gate semantics: schedules inherit the desk at run time, unchanged.
