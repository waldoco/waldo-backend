> **DRAFT for owner decision.** Written 14 Oct 2026 by the backend lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. Each draft went through research, two adversarial verifiers (source and risk) and a reviser. Status: Proposed. Not accepted until the owner says so.

# ADR draft: a per-owner monthly model-spend ceiling (amends ADR-0051 for alpha and beta)

Status: Proposed. It is not authoritative until the owner approves it, it is published in Brain under the next free number, and `docs/foundation/accepted-adrs.json` is regenerated.

Source read at `beta-mvp` `e5c022ef`. Ceiling value from owner ruling 18 (10 Oct, 19:05Z), recorded in `docs/planning/WEBSITE_PROMISE_LEDGER_2026-10-10.md:24`.

## 1. Context

**Spend is not durable today.**
- The owner DO records model, tokens and usd per hop in `trace_log`, which keeps only the newest 500 rows (`channels/harness.ts:62-69`, `:91`).
- Every usage view sums that log: the console Usage page (`console.ts:317-321`) and Telegram `/usage` (`harness.ts:29`, `owner-do.ts:2072`). No one can say what an owner cost this month.

**A ledger and a posture function exist but are not wired.**
- `llm/cost-ledger.ts` defines `cost_ledger` and `spendPosture`: low effort from 80%, background skipped at 100%, interactive never limited.
- The owner DO never creates the table and builds its trace book without it (`owner-do.ts:2138`).
- The trace book would infer turn vs background from the pruned trace log (`harness.ts:87`) and store the hop name as `trigger` (`:88`).

**All owner-DO model calls pass one function.** `complete` in `channels/owner-turn.ts:198-262` calls the provider at `:230`. Subagent rounds, nightly memory, thread titles and the browser-metered gateway all reach it. A successful call logs usage for every purpose (`:257-260`); a failed call logs none (`:256`).

**Background work runs under a closed job enum.** `OwnerJob` is brief, pre_activity_spot, dreaming, reminder, heartbeat, standing_order, device_followup (`contracts/src/runtime/invocation.ts:68-69`). Scheduled executors, device follow-ups and boot work run through `OwnerDO.asOwnerJob` (`owner-do.ts:689-693`, `:1831-1832`, `:1880`, `:2638-2639`). An executor that throws counts an attempt; after 3 it can be quarantined and a paused-job notice is sent (`scheduler/multiplexer.ts:26`, `:304`, `:347`; `owner-do.ts:3006-3016`).

**The owner set a ceiling.** $25 per user per month, for an alpha cohort of 5 to 10 people, at most 50, built before outside users join.

**Accepted ADR-0051 says something different.**
- A per-user per-day cap on metered model and voice spend.
- The day's total lives in DO storage and is checked before each LLM call. It resets at the user-local day. Metering goes to the run journal (ADR-0054).
- Above the cap every call degrades to a cheaper model, never a template. The degrade is silent in conversation and shown in the usage view.
- The abuse circuit-breaker stays a separate path. An AI Gateway per-route budget is the fleet backstop.

**The 0051 clamp cannot simply be wired to owner turns.**
- It lives in the RunLoop (`llm/provider.ts:1129-1140`, `:1383-1389`) and switches to `ROSTER.primary`, a Workers AI model.
- Owner turns run on the GPT-6 Luna pin through the OpenAI adapter (`owner-turn.ts:215`). That pin is an owner grant: "ceiling GPT-6 Luna, nothing beyond" (`contracts/src/model/roster.ts:22-26`).
- The owner turn never passes `spend` (`owner-turn.ts:230-240`). No AI Gateway budget sits in the owner path [inference].

**Two later owner rulings bind the surface.** Users get no slash commands (14 Oct). Proactive messages go to the owner's chosen surface, otherwise the app (ruling 20).

## 2. Decision

### 2.1 The ledger

**Where it lives.**
- Table `cost_ledger` in the owner DO's SQLite, with the existing schema (`cost-ledger.ts:33-38`).
- Created idempotently when the owner DO starts, as `trace_log` is.
- No Supabase table and no hosted migration.

**Who writes it.**
- One writer: the trace book's `record`, when a successful priced model call is logged.
- A local insert after the call returns. No external I/O runs inside a SQLite transaction.

**What it holds.**
- UTC day, kind, trigger, model, input/output/cached tokens, usd, and an optional responsibility id.
- No owner text and no health values. The forget inventory already classes it EXEMPT.
- `kind` is decided inside `complete`, from the calling responder's own owner-turn state: `turn` for any call made for an owner turn (including its memory, compaction and title calls), `background` otherwise. It is never inferred from the trace log or from a DO-wide field.
- `trigger` is a closed value: the OwnerJob kind, or `owner_turn`. It is never a hop name or free text.

**Retention.** Rows older than 13 months are pruned once per UTC day. The table goes with the owner DO on account deletion.

**Scope.** Successful priced model calls made in the owner DO. Failed calls carry no usage and are not counted; a provider may still bill some of them [inference]. Browser spend keeps its own reservation store. Voice transcription is unpriced and outside this ceiling unless the owner rules otherwise.

### 2.2 The ceiling

- **Where the value lives.** One value per deployment in `WALDO_MODEL_SPEND_CEILING_USD`, parsed by `parseCeilingUsd`.
  - Unset or invalid means no ceiling. That is intended for dev and preview.
  - The owner sets 25 for staging and production in `wrangler.jsonc`.
  - When `WALDO_ENVIRONMENT` is staging or production and the value is missing or invalid, `/healthz` and the console show a warning. The console shows "no spend ceiling set" whenever it is unset.
- **The window.** The UTC calendar month, matching the ledger's UTC days. Dates shown to the owner are rendered in the owner's timezone.
- **No per-owner overrides.** This ADR adds none.

### 2.3 Enforcement

**Where.** One check in `complete`, before the provider call. The posture is read from the ledger and the env value only.

**Below 80%.** Nothing changes.

**From 80% (`LOW_EFFORT_FRACTION`).**
- Prompts for background jobs carry one line stating the month's budget state. The model decides what still matters today.
- Batching and dropping remain the model's judgment, under the interruption policy.
- The model and reasoning effort do not change; effort is already `low` on every call.
- Owner turns are unchanged.

**At 100%.**
- A `background` call throws a typed `SpendCeilingReached` before the provider call, unless its job is an exception below. A call with an unknown or missing job kind is refused (fail closed).
- `OwnerDO.asOwnerJob` catches that type, logs one `spend_ceiling_skip` hop whose detail is only the job kind, and returns normally. The occurrence counts as done: no attempt is counted, nothing is quarantined, no paused-job notice is sent, and a recurring entry moves to its next occurrence.
- Executors that catch errors themselves rethrow `SpendCeilingReached`.
- This is a budget boundary over a closed enum of job kinds, not a content judgment.

**Exceptions at 100%.**
- `reminder`: delivered with the owner's own note, without the model rewrite.
- `device_followup`: runs, because it returns work the owner asked for.
- `standing_order`: runs (proposed, pending owner ruling), because the owner set it under a standing grant. If the owner rules otherwise, it is skipped and the notice says so.
- Owner turns on every surface run at normal quality.

**Deferrals.** The boot core-file memory migration stays pending and runs after rollover. Skipped briefs, heartbeats and nightly memory are not replayed.

**Interactive turns are never refused, degraded, or switched to another model by this ceiling.** Interactive spend has no hard stop here. The guards that remain are the abuse circuit-breaker (`owner-turn.ts:230`), per-turn tool-loop step limits, and a provider-project limit the owner sets.

**The notice.**
- Exactly one per owner per UTC month, on the first skip.
- The DO writes the marker `spend_notice:YYYY-MM` and the outbox row `spend-notice:YYYY-MM` in one local transaction (`enqueueFenced`). The send happens later from the outbox, so intent comes before I/O.
- If the DO stops before that transaction, neither exists, and the next skip or scheduled pass tries again. Nothing is lost silently.
- During the owner's quiet hours the enqueue waits for a later pass. The notice is delayed, never dropped.
- It goes through the current deliver path to the owner's chosen surface. It does not use the failure-notice field, which is tied to a live failure pause.

**Notice wording principle.**
- Plain and factual. It states the amount and the limit, what is paused, what still works, and the date it resumes, in the owner's timezone.
- No apology, no model or provider name, no command, no upsell, no health content.
- A fixed template is used because the notice reports a fact.

Example (if standing orders run):

> I've reached this month's limit for background work ($25.00 of model use). Until 1 November I'll skip briefs, check-ins and overnight memory work. Chats work as usual, and your reminders and standing orders still run.

### 2.4 Surfaces

- The console Usage page shows this month's spend by kind and by job, and the ceiling.
- A read-only tool lets the model answer "how much have you cost me this month" in any surface. It has a contract schema, a tool-permission entry and valid/invalid tests, and is resolved per turn.
- No slash command is added or extended.
- An optional additive spend block on the app account view follows, contract first.

### 2.5 Relationship to earlier decisions

For owner-DO model calls during alpha and beta, this amends ADR-0051 on five points:
1. **Window:** user-local day becomes the UTC calendar month.
2. **Action at the cap:** degrade every call to a cheaper model becomes skip background calls only, with exact exceptions.
3. **UX:** silent becomes one notice per month.
4. **Metering store:** the run journal (ADR-0054) becomes owner-DO `cost_ledger`.
5. **Scope:** model and voice becomes model only, pending owner ruling.

Unchanged from ADR-0051:
- The check runs before each call.
- Per-user enforcement stays in the DO.
- The abuse circuit-breaker stays a separate path with its own log.

Other relationships:
- 0051's fleet backstop (an AI Gateway route budget) is not in the owner path today. A provider-project limit set by the owner takes its place until revisited.
- The RunLoop clamp (`RouteSpendState`) stays as is for trusted RunLoop runs and is not wired to owner turns.
- ADR-0051's tier caps and ADR-0069's clamp are revisited before paid tiers.

## 3. Considered Options

1. **Wire ADR-0051's daily clamp into owner turns.**
   - Rejected: it is daily, not monthly.
   - It degrades chats too.
   - It switches to a model the owner path does not serve, which breaks the GPT-6 Luna grant.
   - It is silent.
2. **Skip a listed set of job kinds at the job seam.**
   - Rejected: a list is not complete by construction. A new background path would spend past the cap unnoticed.
   - The chosen chokepoint refuses any non-turn call by default.
3. **Ledger in Supabase.**
   - Rejected: it needs a hosted migration.
   - It adds a network write per call and a network read before every background call.
   - It moves enforcement out of the DO, against 0051's DO-only rule.
   - Langfuse already gives a text-free fleet view.
4. **Hard stop for everything at $25.**
   - Rejected for alpha: a chat refused for money breaks the core promise.
   - The cohort is small and known, and chat is human-paced.
   - Revisit before outside paid users.
5. **Silent posture with no notice (0051's UX).**
   - Rejected: background work the owner relies on would stop without explanation.
6. **Merge #1113 whole.**
   - Rejected: its guard changes are a separate decision.
   - On the current tip they weaken the A0 ratchet and remove the OpenAPI freshness check.

## 4. Consequences

- **Gains.**
  - Per-owner monthly spend becomes durable and visible.
  - Runaway background spend stops at the ceiling, on every current and future background path.
  - Owners are told once and keep chatting.
- **Over-ceiling chat spend.** Chats can push spend past $25. The console shows the overage. Only the provider-project limit caps it.
- **Expected spend.** At the current price table, a typical call costs about $0.0016, so $25 is roughly 15,000 calls. In alpha the ceiling is mainly a runaway backstop [inference].
- **Ledger accuracy.**
  - It uses the flat price table in `llm/pricing.ts`; the over-272K input tier is not modelled.
  - Failed calls are not counted (observed, `owner-turn.ts:256`). Aborted or incomplete responses may still be billed by the provider [inference]. The reconciliation check measures this gap.
- **Impact surface.**
  - Runtime: `llm/cost-ledger.ts`, `channels/harness.ts`, `channels/owner-turn.ts` (cost kind, trigger, the check, the budget note), `channels/owner-do.ts` (job seam, reminder path, notice, boot migration, view), `channels/console.ts`, `/healthz`, the `telegram-webhook.ts` env type.
  - Contracts: one read-only tool contract and its permission entry; later an additive app.v1 field.
  - Config: `wrangler.jsonc` vars, the owner's edit.
  - No Supabase change. No health data.
- **Lane overlap.** The enforcement slice touches owner-do.ts job and delivery code that other workstreams reshape. Files are registered on the coordination issue first.
- **Process.** This record needs owner approval, publication in Brain, and regeneration of `accepted-adrs.json` before the enforcement slice merges.

## 5. Verification and tests

- **Ledger.**
  - The ledger sum equals the `trace_log` usd for a turn.
  - A real OwnerDO ledgers every successful priced call, and no failed call.
  - The table is created once, however often the DO starts.
  - Kind is `turn` for an owner turn, including its thread-title call after the reply, even after the trace log has pruned the turn's hops.
  - Kind is `background` for a job, with and without a job host.
  - `trigger` values come only from the OwnerJob enum or `owner_turn`.
- **80%.**
  - At 79.9% there is no budget note.
  - At 80% a background prompt carries it, and the model and effort are unchanged.
  - The run-eval gate runs for the prompt change, or its absence is recorded.
- **100%.**
  - Each OwnerJob kind behaves as in §2.3: brief, pre_activity_spot, dreaming and heartbeat make no provider call and log `spend_ceiling_skip` with only the job kind.
  - A reminder delivers the owner's note. A device follow-up runs. A standing order follows the owner's ruling.
  - A background call with no job kind is refused.
  - An owner turn at 150% runs normally on every surface.
  - After a skipped recurring occurrence: attempts are 0, nothing is quarantined, no paused-job notice is sent, and nothing bursts at rollover.
  - The boot memory migration at the cap stays pending and runs after rollover.
- **Notice.**
  - Sent exactly once across two alarm passes, a DO restart, and a stop between the skip and the enqueue.
  - A notice due during quiet hours arrives after they end.
  - None in the next month until the ceiling is hit again.
  - The resume date is correct for a non-UTC owner timezone.
  - It contains no model or provider name, no command and no health content.
- **Rollover.** On the first UTC day of a new month, posture returns to normal and background jobs run.
- **Unset or invalid ceiling.**
  - No enforcement, and the console says no ceiling is set.
  - In staging or production, `/healthz` and the console warn.
- **No undeclared model is ever called** on the owner path.
- **Hostile.** Text in a tool result or an email cannot change the posture, the kind or the trigger. These read only the ledger, the env value and the responder's own state.
- **Reconciliation, operational.** During the first two alpha weeks, summed ledgers are compared with the provider's billed usage. More than 10% difference reopens this decision.

## 6. Rollback

- Remove `WALDO_MODEL_SPEND_CEILING_USD` from the deployment and redeploy (the owner's action). Posture returns to normal, and nothing is skipped or noticed. The health check then shows the missing-ceiling warning, which is expected.
- Reverting the enforcement slice has the same effect.
- Reverting the ledger slice leaves the `cost_ledger` table in place, unused and holding no owner text. The usage views fall back to the trace log.
- Notice markers are local KV/SQLite rows and do nothing once enforcement is gone.