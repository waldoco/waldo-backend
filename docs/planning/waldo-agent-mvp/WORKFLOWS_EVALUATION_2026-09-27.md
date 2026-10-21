# Cloudflare Workflows evaluation - 2026-09-27

The A5 slice owed an evaluation: should durable background runs adopt Cloudflare
Workflows, or does the per-owner Scheduler on Durable Object alarms carry them?
The build plan's adoption bar, set before this evaluation ran: adopt only if
durable long runs need more than the DO-alarm Scheduler. This is a docs-only
evaluation - it decides and records; it builds nothing.

## What Workflows offers (official docs, developers.cloudflare.com/workflows)

- Durable multi-step execution without timeouts; state persists between steps
  for minutes, hours, or weeks.
- `step.do()` with automatic per-step retries and error handling.
- `step.sleep()` / `step.sleepUntil()` - pause for seconds, hours, or days.
- `step.waitForEvent()` - pause for external events or approvals with a timeout.
- Built-in observability for workflow instances.

## What Waldo already has (all live on beta-mvp)

- **Scheduler** (`packages/runtime/src/scheduler/multiplexer.ts`): per-owner DO
  alarm multiplexer. Persistent entries with recurrence, attempt counting,
  quarantine (`quarantined_until`), bounded batch dispatch (`MAX_DUE_PER_ALARM`),
  and settled run dispositions. It is the durable timer layer.
- **background_runs** (`packages/runtime/src/channels/background-runs.ts`, A5b):
  the typed registry of every background execution with parent hops, finished
  classifications, and the console's Background tasks section.
- **Turn-scoped child loops** (`packages/runtime/src/conversation/subagent.ts`):
  delegate_task children run nested tool loops inside the spawning turn with a
  shared round budget - seconds-to-minutes, flat by construction.
- **Timer-driven fires**: reminders, standing orders, heartbeat beats, day
  cards, nightly memory - each a single dispatch, retried and quarantined by
  the Scheduler, recorded in background_runs.

## The honest inventory of "long durable runs"

Nothing in the running system is a multi-step workflow spanning hours with
durable intermediate state. The longest executions are:

1. Bounded tool loops inside one turn (capped rounds, one turn's lifetime).
2. Single-dispatch timer fires (sub-second to seconds of work).
3. Nightly memory migration - a few chained model calls inside one alarm run.
4. Approval waits (the approval desk) - hours-to-days, but they are *ledger
   holds*, not running processes: the desk persists the pending entry and
   nothing executes while waiting. There is no workflow to pause.

Every one of these is carried today: timers by the Scheduler, registries by
background_runs, waits by the desk ledger, bounded loops by the turn.

## What adopting Workflows would cost

- **Splits the per-owner truth.** A Workflow instance's state lives in the
  Workflows runtime, outside the owner DO. The trace book, run registry, and
  console read one SQLite today; adoption fragments that story for the runs
  that move, and dual-registry reconciliation is real ongoing complexity.
- **A second retry/quarantine semantics.** The Scheduler's attempt/quarantine
  policy is tuned and tested; Workflows adds per-step retry config that must
  be reconciled with it for anything that straddles both.
- **Another billable primitive** for capabilities the current inventory does
  not exercise.

## Decision

**Do not adopt Workflows now. Stays post-alpha, as the audit pre-framed.** The
adoption bar - durable long runs needing more than the DO-alarm Scheduler - is
not met by anything in the alpha inventory.

## Flip conditions (re-evaluate when one lands)

1. A multi-day watch-and-act arc with mid-run model steps (e.g. a price watch
   that re-reasons over days), where the work between wakes is a chain, not a
   single dispatch.
2. B2/B3 shopping rails if the owner-completes-payment window needs a live,
   resumable process rather than a desk ledger hold plus a confirmation fire.
3. Long research or document arcs that must survive across many turns with
   durable per-step state the DO would otherwise hand-roll.

When one lands, the migration shape is already clear: the Scheduler keeps
timers, Workflows owns the long chain, and background_runs records the
Workflow's start/finish as a `loop`-class run row so the console story stays
single-pane.
