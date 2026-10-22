# Health plane amendment (beta, staging)

Status: owner-ruled scope, not yet implemented. Applies to ADR-0081, ADR-0024 and the 21 June 2026 meeting note. Implementation lands in separate red-first PRs; migrations are staging-only and apply only after the owner approves the design note.

## Rulings applied
1. Recovery is the only score shipped in the first app stage. Form and Weight report "unavailable" with a reason until their inputs exist (intraday signals, calendar demand). ADR-0081's algorithm is re-versioned as `recovery.v1` (sleep, HRV, resting HR against the owner's own baseline); the view schema and registry change with it.
2. The owner's wearable readings and derived health context may reach model context and owner-channel replies end to end. This replaces the 28 Sep owner-typed-text-only ruling and the ADR-0081 "no numerics in prompts" row for the owner's own data.
3. The consent contract is the beta-mvp one (class, status, integer version, source/purpose evidence). Health ingest and consent tables follow in a migration PR after a design note. Staging only.
4. App Store, DPDP, residency and withdrawal-purge scope stay a hard gate before any outside user.
5. The 21 June note "health stays on-device, never auto-synced" is superseded by consent-bound server storage.

## What changes in the sanitiser (scope the owner approved)
- Structured health objects and health numerics stop hard-denying at model-bound destinations (system_prompt, internal_context, owner_reply) when the source taint is null (owner or system-derived). `health_value_leak` leaves the hard-reason set for those destinations.
- The derived view gets a non-Form schema and carries both `trigger_prompt` and `volatile_run` eligibility.
- A bounded read tool lets the agent pull daily or series readings on demand; the composer still injects only a compact derived view each turn.

## What stays blocked
- Third-party egress (send_message, draft_email, draft_document): health values blocked unless the owner explicitly asks to share a specific item.
- Externally tainted content (mail, web, files): redaction stays.
- Logs, audit records, R2 summaries, browser jobs: no health values.
- Traces: during alpha and beta, by owner ruling (10 October 2026), the staging Langfuse project captures model text for opted-in testers, health included. Production never captures text (enforced in code); revisit before production.
- Secrets, canaries, forget and withdrawal guarantees.
- Long-term memory: no bulk readings. Synced wearable readings and numeric pattern evidence (owner ruling, 10 October 2026) live in the Supabase health plane and are read live; memory holds patterns and pointers. Owner-stated readings are the exception below.
- Provider requests set `store: false`.

## Retention and access (recommendation the owner approved in scope, "90 d raw / 24 mo aggregate")
- Raw readings: 90 days in owner-only tables. Daily aggregates and scores: while the account is active, at most 24 months. All deleted when storage consent is withdrawn or the account is deleted. Withdrawing model use alone stops Waldo using health in conversation and deletes nothing (owner ruling, 10 October).
- Encrypted at rest and in transit; row-level security per owner; writes only from the ingest route with service credentials; agent reads through the signed owner-scoped RPC; raw reads leave count-only receipts.
- No health values in analytics, traces or error text.

## Addendum: continuous ingest (owner decisions of 10 October 2026)
Design: `docs/app/HEALTH_INGEST_DESIGN_2026-10-10.md`. Contract: `packages/contracts/src/app/health-ingest.ts`.
- **Intraday window summaries.** The app may upload point records and window summaries (heart-rate min/mean/max, an RMSSD or SDNN value with its beat count, SpO2, respiratory rate, step and energy windows, workouts). They are raw readings under the retention above. Beat-to-beat series and the 24 h heart-rate stream stay on the phone. This reverses the app's earlier decision that intraday data never leaves the device. Consent copy version 2 names it.
- **Scores.** The backend computes the official scores from stored readings and is the only writer of `public.health_context_daily`. A phone may show a provisional score; a device score cannot become canonical by upload (ADR-0081 stands). Candidate-labelled scores may reach owner replies with their algorithm version.
- **HRV.** RMSSD is canonical. SDNN is accepted only as a labelled fallback with its own baseline and lower confidence, never blended.
- **Time.** Every upload carries an IANA zone and each reading its UTC offset. A day holding two zones is allowed and flagged. The owner-settings timezone stays the agent's default.
- **Zone vocabulary.** The stored row keeps `low|moderate|good|high|unknown` for every pillar, mapped by `packages/contracts/src/health/zone-bridge.ts`, direction by meaning (the heavier the day, the higher the stored word). Reads for the app use the meaning-bearing words.

## Addendum: the Brief's sleep chip (owner ruling of 13 October 2026)
Ruling: a chip on a Brief card may show last night's raw sleep duration (#1103 comments 6140376774 and 6140220362, item 6). ADR-0081's matrix keeps raw and normalised sleep duration out of the morning Brief DTO. This is the one exception, for one field at one destination.
- **Where it shows.** Only as the label of a `sleep` ref on a card's `latest` in the app's day view (`GET /app/v1/controls?view=day`). It shows for the owner's own authenticated session only.
- **Where it comes from.** It is filled when that view is read, from the Supabase health plane, through the signed `health_series_read`. The read covers one local day and `sleep_duration`, time asleep only. The owner's health storage consent covers it. Model-use consent is not needed, only because no model reads it.
- **When it is gone.** The chip is left out entirely, never shown empty or as zero, in three cases: there is no reading, storage consent is withdrawn, or the health connection is lost (the read fails or reports the owner not linked).
- **What never holds it on this path.** The card text on any surface, including the Telegram copy and push text. The model's input and output for the card, the card delivery record, Durable Object storage, R2, memory, traces, logs and metrics. On this path the number leaves the health plane only into that one response. Other paths keep their own rules: ruling 2's model context, the bounded read tool and the staging trace exception.
- **Proof before it ships.** Tests show that the stored card text and the delivery record never hold the duration. They show the label is absent without storage consent or without a reading, and that the Telegram copy carries no number. Before the chip is emitted, ADR-0081's matrix change and its destination fixtures land in waldo-brain.

## Addendum: what the owner tells Waldo (owner ruling of 22 October 2026)
Ruling on #1379 (comment 6343869643): what the owner tells Waldo about their own health may go into their memory, numbers included.
- **What is kept.** Readings and goals the owner states, through `remember`, the nightly pass, the memory flush before compaction and the notes-file migration. The owner's health notes setting turns this off for every writer but `remember`. A stated reading is kept as a dated statement ("On 22 Oct said resting HR was 52"), a goal as a standing entry the owner can replace. Only what the owner said: never an inferred condition or diagnosis, a government or insurance id, a medication dose, or someone else's health unless the owner asks. What counts as a stated reading or goal is the model's judgment, through its instruction.
- **What stays in the health plane.** Synced wearable readings are never copied into memory. They are read live with `get_health`, which wins for anything current.
- **What stays blocked, keyed on source.** A health number that arrives in externally tainted content (mail, web, MCP output) is not written to memory from that path: `remember` refuses one in a turn that read outside content, and the background writers hold one whose evidence is not the owner's own words, stated. A held reading keeps no fingerprint of its words. Lab values from those sources wait for the health-plane contract review. Logs, production traces, R2, metric labels and third-party sends or drafts still never carry the value.
- **Deletion.** These are ordinary claims: per-claim forget, topic forget and account deletion cover them in the owner's Durable Object.
