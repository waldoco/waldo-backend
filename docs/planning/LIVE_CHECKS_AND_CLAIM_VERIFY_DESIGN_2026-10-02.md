# Heartbeat and long-thread live checks, and claim-verify wiring: design (draft, no code, no DO edits)

Status: DESIGN ONLY. Nothing here is implemented or run. Layers are named separately: SOURCE (what the code says), CI, STAGING (deployed), LIVE (observed on the running staging bot).

## 1. Heartbeat live check (staging)

What the source says: `heartbeat.ts` runs a deterministic tick every `HEARTBEAT_EVERY_MS` (30 min), no model turn, quiet by default. It records the decision (`heartbeat_result`: quiet or acted) and the send (`delivery`: pending, sent, failed) on the scheduler's `schedule_runs` row, and releases quiet-hours-held day cards. The DO logs hop `heartbeat_tick` and a `machine_turn` with detail `heartbeat`.

Check, read-only, no message sent as the owner:
1. Pass A (tick runs): in the owner console activity page (the narrow `/console/dashboard/api/v1/activity` once routed, or the existing console trace) find a `heartbeat_tick` hop within the last 30 to 40 minutes with `ok: true`. Two consecutive ticks about 30 minutes apart show the schedule is armed and re-arming.
2. Pass B (quiet by default): with no past-due open loop, the tick produces no outbound message. Evidence: no new Telegram message from the bot in the window and the run row shows `quiet`. Absence of a message is only evidence together with a recorded tick.
3. Pass C (acted path) needs a past-due loop. Creating one is an owner-state write on staging and the resulting send reaches the owner's own chat. It is not run without the owner's say; it is listed as the only check that sends.
Fail signals: no tick in 40 minutes (schedule not armed, DO evicted without re-arm), tick with `ok: false`, or a `delivery: pending` row older than one tick (crash between act and confirm; recoverable by design, but it should be reported).
Unknown until run: whether the console trace page shows hop names at this granularity on staging.

## 2. Long-thread live check (staging)

Goal: confirm a long conversation keeps working: context stays bounded, earlier facts survive, tool receipts stay truthful.
Design: one scripted Telegram thread to the staging bot, about 30 short turns, mixing (a) a planted fact early ("my sister's flight lands Tuesday"), (b) two read-only tool turns (Gmail paged read, calendar 7-day), (c) a recall question at the end, (d) an artifact create then export once `export_artifact` is registered.
Pass criteria, each from structured evidence not wording: the final recall matches the planted fact; the turn trace shows no failed hop; per-turn input token usage (usage ledger) stays below a stated ceiling and does not grow linearly without bound; tool receipts for the read turns exist and match the claims made.
Cost: this runs the real model on staging, so it spends owner model budget. It runs only with the owner's explicit go: it spends model budget, and each turn is a message sent as the owner to his own staging bot. No standing approval covers it. Not run tonight.

## 3. Claim-verify wiring

Source today: `hooks/claim-verify-lint.ts` has `checkClaimsAgainstReceipts(claims, receipts)`. It reads structured data only (no text parsing), is advisory and is not wired anywhere. The open question it names is where `DoneClaim`s come from.

Proposal, in steps, each reviewed on its own:
1. Source of receipts (no new behavior): build `ToolReceipt` rows from the dispatcher's own result log for the turn (tool, effect, ok, ref). The effect label comes from a typed table keyed by tool name, not from reply text.
2. Source of claims: a typed optional field on the final reply, `done_claims: [{effect, ref?}]`, produced by the model through the reply schema. No claim extraction from prose. The model is told the field exists; absent field means no claims, which is not a pass or a fail.
3. Shadow mode first: run the check after the turn, write findings only to the trace (`claim_verify` hop with count and effects, never the text). No user-visible change, no blocking.
4. Measure on staging for a stated window: findings per 100 turns, and spot review of each to separate model errors from table gaps.
5. Only after that, a separate decision on a visible consequence (for example a reply-level correction note). Blocking sends is out of scope.
Risks and unknowns: (a) the effect table must be complete or true claims show as findings; (b) a model that omits `done_claims` hides unverified claims, so shadow data cannot prove absence of overclaiming; (c) retries and resumed runs can reorder `seq`, so the check needs the turn's sequence from the run journal, not wall-clock.
Seam: the reply schema and the post-turn hook sit in the owner-turn path and `telegram-owner-do.ts`. Both are Codex-owned seams; this section is a design for them, not a request to edit them.

## Decisions needed (not made here)
- Owner go for spend and for the acted-path heartbeat check (section 1 pass C, section 2).
- Whether shadow-mode claim verify may log effect names to the trace.
