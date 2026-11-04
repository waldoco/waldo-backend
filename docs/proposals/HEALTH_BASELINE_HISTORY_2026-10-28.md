# Proposal: a baseline that reads history beyond 30 days

**Date:** 28 October 2026 · **Lane:** H1 (health acts) · **Status:** proposal only. No code changes until Brain accepts an ADR-0081 amendment and the owner rules on it.

## Why this stops at a proposal

The H1 brief asked that the baseline read imported history beyond 30 days "within ADR-0081 rules". ADR-0081 as amended on 27 October 2026 (waldo-brain `main` at `2871edc`) rules this out for the current versions:

- **§1, "Window: 30 days."** The owner accepted 30 days on 27 October ("30 days ok"), replacing HI-4's 60 days. The amendment says a longer window "would be a later version once HI-7 lands".
- **§7.** HI-7 ("24-month daily aggregates, and reading history beyond 30 days ('Bring your past')") is deferred "to its own dated amendment with its migration and a privacy-notice line".
- **Version pinning.** The priors and constants are pinned for `recovery.v5`, `form.v9`, `weight.v5` and `sleep-debt.v2`. Any change is a new version, and rows written under an old version are never reinterpreted (`health/scores/baseline.ts`).

Lengthening the window in code would reverse an explicit owner ruling and silently change pinned versions. That needs an amendment, not a backend fix.

## Where the 30 days live today [verified in source at `f32076aa`]

| Seam | File | What it bounds |
|---|---|---|
| `WINDOW_DAYS = 30` | `packages/runtime/src/health/producer.ts` | The series read for every score, and the days the backfill can see |
| `BASELINE_WINDOW_DAYS = 30` | `packages/runtime/src/health/scores/stats.ts`, used by `sleep-debt.ts` | Which nights shape sleep need |
| `BASELINE_DAYS = 14` | `stats.ts`, used by every pillar | When a component is `personal`; unchanged by this proposal |
| `HISTORY_WINDOW_DAYS = 90` | `producer.ts` | Only which days already hold a row, for the backfill |
| Series read cap, 8,000 rows | `waldo.health_series_read` (ADR §1, "The read cap") | A read that reaches it drops its oldest days and is marked truncated |

## Options

**A. Raise the producer window to 90 days, within the 90-day raw retention.**
- It needs no new store and no retention change.
- It is a new version of all four scores (`recovery.v6`, `form.v10`, `weight.v6`, `sleep-debt.v3`), with new golden vectors and the §6 acceptance conditions run again.
- It does not work as a one-line change. Hourly window signals over 90 days pass the 8,000-row cap, so the read would truncate and drop exactly the old days it was meant to add. The baseline needs a second, nightly-signals-only read for days 31–90, as the vitals read is split today.
- It reverses "30 days ok", so the owner rules on it.

**B. HI-7: daily aggregates (recommended).**
- One aggregate row per owner-day: a night's HRV, resting HR, sleep minutes, midpoint, and a day's movement and daylight minutes.
- These are Supabase derived rows under the existing derived-row retention (24 months, ADR-0081's 2026-10-25 amendment, §1). The baseline reads aggregates, not raw series.
- It needs a migration, a privacy-notice line, and an amendment naming the store and the new score versions.
- It is the shape the amendment already points at, and it removes the row-cap problem for good.

**C. Keep 30 days.** Imported history still counts toward `personal` on day 1 (14 of the last 30 days), and it shapes "usual" only for its most recent 30 days. This is the current state.

## Recommendation

Choose B, as its own dated amendment in Brain. It needs the migration, the new score versions, golden vectors for a 90-day and a 24-month owner, and the privacy-notice line. Option A only fits if the owner wants older history counted before the aggregate store exists, and it still needs the version bump and the split read.

**Unverified:** how many days the iOS app actually uploads at first link. The ADR (HI-8) says at most 30. The capability map says the backfill covers 90 days, 30 per run. Before anyone sizes option A, a device run should confirm what arrives.
