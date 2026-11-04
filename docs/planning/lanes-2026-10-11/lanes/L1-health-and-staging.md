# L1: health plane and the staging deploy train

**Owner:** a new Claude session, the successor to the "Waldo app-backend handoff" lane. Repo: `waldoco/waldo-backend`, base `beta-mvp`.

## Why

Staging has zero computed health rows, so no Recovery score can appear on the iPhone. This lane holds the middle of a three-sided dependency:
1. the H3 routes are deployed;
2. the app consents and uploads;
3. a producer writes rows.

This lane is also the **only staging deployer**. Today staging serves an unmerged branch tip (`625214cc`, #1034). A deploy from `beta-mvp` before #1034 merges would silently remove that feature from staging.

## Read first

- [`../IDENTITY_ROOT_PLAN.md`](../IDENTITY_ROOT_PLAN.md) §4 and [`../SESSIONS_ALIGNMENT_REVIEW.md`](../SESSIONS_ALIGNMENT_REVIEW.md) ("The path to the iPhone").
- The previous lane's hand-off, in the shared Claude project memory: `waldo-session-handoff-2026-10-11.md`. It covers H3–H6 detail, staging state, the deploy recipe, and the health semantics in force.
- Ledger `docs/planning/WEBSITE_PROMISE_LEDGER_2026-10-10.md` §9, Wave 3; H1 contract `packages/contracts/src/app/health-ingest.ts`; migration `supabase/migrations/20261011000000_health_plane.sql`.

## Queue (Phase 1)

1. **#1031 (H3 routes).**
   - Merge `beta-mvp` up into it, re-run CI, then ask the owner for the merge go.
   - Deploy the `beta-mvp` tip only after #1034 has merged.
   - Send the app lane (L4) the release id, and record it on #116.
2. **H4 producer plumbing.**
   - A per-day read function: a new migration numbered above `20261011000000` (check ledger §12 reservations first).
   - A producer **called after each ingest commit**. Do not wait for H5: the design computes on `health_arrived`, so H4 alone would write nothing.
   - Consent epoch read before the samples, or in one snapshot.
   - The write goes through `waldo.health_context_write` only.
   - The math comes from Instinct brief 01 (`computeDailyScores`). Build against that interface, and review that PR when it arrives. Until it lands, a minimal Recovery behind the same interface is acceptable if it is the reviewed #998 formula.
3. **Purge gap.** `public.delete_owner` does not delete `health_context_daily` rows. Fix it with a forward migration and a pgTAP test.
4. **H6 backfill (30 days), pulled forward.** Without it, Recovery's 14-day baseline takes two weeks to fill. Also the retention scheduler.
5. **H5 arrival events.** This touches `channels/telegram-owner-do.ts`, which L2 owns: announce first, or ask L2 to make the edit.

## Phase 2 (after the Phase 1 exit)

- Sleep debt, Form (HR/HRV stress), Weight (demand collectors: all calendars, tasks, messages), Quiet flags (add the wrist-temperature HealthKit type with L4), Training.
- History API (7/30/90).
- Samsung source.
- Wire Instinct's weather tool (brief 02); L2 adds the registration line.

## Rules

- **Per-action owner go** for every merge, staging deploy and hosted migration. Staging only, never production.
- **Deploy hygiene:**
  - deploy from a clean detached checkout at the exact SHA;
  - deploy only `beta-mvp` tips;
  - no secrets in argv, logs or prompts.
- **Testing:**
  - red-first;
  - pgTAP for every SQL change;
  - report PASS / FAIL / NOT RUN / UNAVAILABLE at the exact SHA.

## Exit (your part of Phase 1)

- A real consented iPhone (Suyash's) produces a morning Recovery score with its coverage.
- Sparse data shows `unavailable`, never an invented number.
- Withdrawing storage purges the data.
