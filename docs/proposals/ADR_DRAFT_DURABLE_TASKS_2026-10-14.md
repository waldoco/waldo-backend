# ADR draft: durable background tasks on the owner scheduler

Status: draft for review. It is built behind `DURABLE_TASKS` (off unless `'1'`) as a tracer slice. It becomes an ADR in Brain under the next free number when the switch is turned on by default.

Author: the C7 builder session (claude.ai/code `session_01V7kpVJaPZUuGytfbo12xE3`). Source read at `beta-mvp` `e5c022ef`. Spec: #1103 comment 6154789747; design posted on #1103 before code.

## 1. Context

**Waldo can't finish multi-step work it promised.** A turn lasts at most one bounded attempt (about 150 s). Work that spans several steps or several hours has nowhere to live, so an interrupted turn is quarantined, not resumed. The owner's "text it a chore and it comes back" has no path.

**What already existed, unused:**
- `channels/responsibilities.ts` holds the responsibility book: items, dependencies, and revision fencing (`start`, `finishWorker`, `superseded_result`). No runtime code called it, so the model could never call `track_responsibility`.
- `delegate_task({ background: true, item_id })` was in the contract, but `owner-turn.ts` built the handler without deps, so it refused.
- The Scheduler (`scheduler/multiplexer.ts`) owns the one alarm per owner. It re-delivers a one-shot entry that an eviction left `running`, and it retries or quarantines only when an executor throws.

**Not adopted:** Cloudflare Workflows, per `docs/planning/waldo-agent-mvp/WORKFLOWS_EVALUATION_2026-09-27.md`. The `task_step` executor is the seam a Workflow instance would start from if a flip condition lands.

## 2. Decision

### 2.1 State and its writers

- **The task** is a responsibility, and **its steps** are its items. Both stay in the owner object's SQLite. The book is their only writer, as before.
- **The attempt journal** is one new table in the same SQLite: `task_step_attempts`.
  - Columns: `item_id`, `attempt`, `round_start`, `revision`, `status`, `report`, `created_at`, `ended_at`. `round_start` is the first attempt since the step was started or reset; the attempt budget counts from it.
  - `status` is `armed`, `running`, `done`, `failed`, `interrupted` or `cancelled`. `report` is `sending` or `sent`.
  - It's created lazily, like the book's tables, with no DO migration.
  - Its only writer is `channels/tasks/step-runner.ts`.
  - It holds ids and states only, never task text.
- **No new store, service, binding or wake lane.** One schedule kind, `task_step`, joins the existing `dispatchDue`.

### 2.2 Step boundary and intent before I/O

- One step attempt is one schedule entry with its own id, `task:<item>:<id>`. Its payload is only `{ item_id, attempt_id }`.
- **Arming writes the schedule entry first, then the journal row.** If the schedule write throws, the journal is unchanged and the executor throws, so the Scheduler delivers the current entry again. A redelivered `running` attempt resumes as interrupted, and a redelivered `done` attempt arms the steps that follow it. A step is never left armed with nothing to run it.
- **Before any I/O**, one `transactionSync` commits `book.start` (which bumps the item's revision) and the attempt row as `running` at that revision.
- **The I/O runs outside the transaction:** one machine turn through `responder.prompt`, the path standing orders use.
  - The turn runs under `asOwnerJob`, so every tool call and the reply pass `ownerJobAdmission`, whose `assertFresh` re-asks the directory.
  - Its tools are `TASK_STEP_TOOLS`: the read-only child set minus the health reads.
- **After the I/O**, one transaction commits `finishWorker` and the attempt's end state.

### 2.3 One retry owner

The runner owns retries, and the executor never throws a step's failure to the Scheduler.
- A failed attempt arms the next one as its own entry, 30 s × n later (n counted from `round_start`), up to `TASK_STEP_MAX_ATTEMPTS = 3`.
- A closed authority (`ClosedRunError` or `OwnerAdmissionError`: a revoke, a rebind, a directory outage) isn't the step failing. The same attempt is armed again 30 s later and spends nothing. While the owner isn't admitted, the scheduled pass holds before any executor runs.
- Every entry has its own id and names its attempt (`payload_refs.attempt_id`). Arming never rewrites the entry being dispatched, and an entry for an attempt already replaced or settled runs nothing.
- After the third failure the item fails, and the owner is told once.
- The Scheduler's own retry and quarantine apply only when the executor itself throws: a crash, or a schedule write that failed (§2.2).

### 2.4 Resume after eviction

On a wake, the runner may find a `running` attempt at the item's current revision. That is its own attempt, cut off by an eviction or a deploy.
- It is marked `interrupted`, and a fresh attempt runs in the same wake, counted against the three.
- This is safe because a step holds read tools only.
- A step that may hold an effect tool needs `effects_dispatched` on the attempt: an interrupted attempt with an effect is never re-run, the responsibility becomes `uncertain`, and the owner is asked. That lands with the first such step (wait-on-event, PR 2), not before.

### 2.5 Cancellation fencing

- A step runs only at the revision its entry was armed with, and only while its responsibility is `open` or `waiting`.
- `update_todo` and `close_responsibility(dropped)` bump the revision; dropping now also cancels the unfinished steps.
- A cancel between steps makes the next wake a no-op: no model call, no message.
- A cancel during a non-final step makes its result land as `superseded`, kept aside.
- A cancel during the last step is checked again in a transaction right before the send, so the result isn't sent.
- An `update_todo` that sets a step back to `pending` fences any armed attempt and, in a task already running in the background, arms a fresh round at the new revision. That's also how the owner retries a step that failed.
- A cancel never claims that a read already done was undone.

### 2.6 What the owner hears

- **After a non-final step:** one templated line, "Step k of n done for "<task>": <step>."
- **After the last step:** the step's reply, as the result. The runner then closes the responsibility `done`, with the attempt ids as evidence.
- **After the third failure of a step:** one line saying it stopped.
- **The delivery path:** all of these go through the same `api.sendMessage` the standing-order fire uses.
  - For an app owner that's `appDeliveryFor`, which re-asks the directory per row.
  - Before each send, the runner also calls the job admission's `assertFresh`.
- **Progress lines are at most once.** The `report` column is set to `sending` before the send and `sent` after it, and a progress line is never sent again. A crash mid-send can lose a progress line, never repeat it.
- **The result is at least once.** The result is kept nowhere but the owner's channel, so the last step is `done` only after its send succeeds. A failed send runs the step again: an ordinary failure spends an attempt, a closed authority doesn't. An attempt found `running` with its report `sent` is finished without sending again. Only a crash between the send and that `sent` mark can deliver the result twice; nothing loses it.
- **Owner steps:** in a task already running in the background, when the owner marks their own step done (`update_todo`), any Waldo step waiting on it is armed. A task the model never started in the background is never started by an update.

### 2.7 Privacy

- **A step's result** is kept on its item (`result_ref`) for the next step. Raw health values may never be written to the owner object's SQLite, so:
  - steps hold no health read tool;
  - a non-final result that the Scribe's numeric health floor (`numericHealthIn`, the predicate the compaction ADR uses) matches is not kept, and the attempt fails;
  - the last step's text goes only to the owner channel, and its item keeps "Reported to the owner."
- **Taint:** a step that reads an earlier step's result runs with `sourceTaint: 'external'`.
- **Logs:** trace hops carry ids, attempt numbers and codes, never task text.
- **Forget:** `responsibilities` (title, intent, closing evidence) and `responsibility_items` (title, result, superseded result) are in the forget path's literal-redaction stores, with redaction, readback and span selection like `goals`.

### 2.8 Contracts

Additive, runtime contracts only; no app.v1 change.
- `scheduleKindSchema` gains `task_step` (priority 10, trigger `null`).
- `ownerJobSchema` gains `task_step` (trigger `intervention`, like `standing_order`).

An older Worker reads a `task_step` row as unreadable and leaves it alone; that's the existing roll-back path for schedule rows.

## 3. Alternatives considered

- **Cloudflare Workflows** (`step.do`, `waitForEvent`). Rejected for now per the 27 Sep evaluation: a second durable engine outside the owner object, a wrangler binding and an owner step, and its state outside the one per-owner authority root. Revisit when a multi-day chain with mid-run model steps lands.
- **Let the Scheduler own retries** (throw on a step failure). Rejected: the Scheduler would count crashes and step failures together, quarantine for 24 h, and send its generic pause notice, while the journal could not tell an interrupted attempt from a failed one.
- **Run steps inside the turn** (foreground `delegate_task`). This already exists. It can't outlive the turn's 150 s, and it can't survive an eviction.
- **A separate tasks table.** Rejected: the responsibility book already models tasks, steps, dependencies and fencing. A second table would be a second writer for the same aggregate.

## 4. Consequences and roll-back

- **Switch off (the default):** no responsibility tools, `delegate_task` behaves as before, and no `task_step` executor is registered. A `task_step` entry armed while the switch was on fails at hand-off ("no scheduler executor"), and the Scheduler retries and then pauses it like any entry with no executor. It has no failure-notice name, so the pause is silent.
- **Roll-back of the Worker:** an older Worker skips `task_step` rows as unreadable. The `task_step_attempts` table and the book's rows stay, inert.
- **Known gap, named, not built:** switching off leaves armed `task_step` entries to the Scheduler's no-executor retry and pause.
- **Still open:** wait-on-event (approvals), effect-bearing steps with the `uncertain` rule, the app's Carrying rows, and a `progress` reply part, once the A4 seam exists. These are PR 2.
