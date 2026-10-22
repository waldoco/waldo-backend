# ADR draft: the mail radar ledger (22 October 2026)

Draft for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. The design it records is [`LAUNCH_JOBS_8_10_RADARS_DESIGN_2026-10-22.md`](LAUNCH_JOBS_8_10_RADARS_DESIGN_2026-10-22.md).

**Number.** 0086 is the next free number after 0085, which the forget-barrier draft in #1414 claims. The final number is assigned in waldo-brain on publication; until then no code cites it by number.

**Status.** Proposed. Not accepted until the owner says so and it is published in waldo-brain. Nothing here changes an accepted ADR by itself.

CLAUDE.md requires bounded contract or ADR review when new stored data extends existing decisions. This draft covers the stored data the radars add. It adds no standing grant.

---

```markdown
---
status: proposed
date: 2026-10-22
canonical_location: waldo-brain/01-Waldo/Architecture Decision Records (ADR)/0086-mail-radar-ledger.md
related: [0049-general-agent-tools-v1, 0054-durable-agent-execution, 0055-gdpr-deletion-runbook-all-stores, 0065-do-alarm-multiplexer, 0068-delivery-policy-table, 0081-versioned-health-authority, 0085-forget-barrier-derived-deletion-async-purge]
---

# The mail radars keep a small keyed ledger in the owner's Durable Object; mail bodies and health-admin text are not kept

## Context

Launch jobs 8–10 run as scheduled reader jobs over the owner's mail: bills and subscriptions, parcels and returns, and
health admin. A daily job must not report the same bill every day, must notice when a known item changes, and must
apply each result once. That needs state that survives between jobs. The worker layer keeps a job's brief,
checkpoint and result in `task_jobs`; settled rows are trimmed to the newest 200. That is not a ledger of what the
owner has already been told.

Mail is external, tainted text. CLAUDE.md treats full mail bodies as normal agent context within the owner's
authorization, and requires their storage and egress to be documented in the owning contract. Health values must never
be stored in Durable Object SQLite. Lab results need a health-plane contract review before Waldo reads their values.

## Decision

The owner's Durable Object (the only writer) keeps three tables for the radars. It writes them only in the apply
transaction of a radar job, together with that job's settle. No worker writes them.

1. **`radar_state`**, one row per radar family:
   - columns: `family TEXT PRIMARY KEY CHECK (family IN ('household','health_admin'))`, `through_ms INTEGER`, `backfilled_at INTEGER`, `last_job_id TEXT`, `last_outcome TEXT`, `failed_days INTEGER NOT NULL DEFAULT 0`, `updated_at INTEGER NOT NULL`;
   - `through_ms` is the watermark. It advances only when the job's result is `done`.

2. **`radar_items`**, one row per obligation the model identified:
   - columns: `item_ref TEXT PRIMARY KEY` (`rad_` + 12 hex), `family TEXT NOT NULL`, `type TEXT NOT NULL`, `key_hash TEXT NOT NULL`, `due TEXT`, `state TEXT NOT NULL CHECK (state IN ('reported','resolved','expired'))`, `title TEXT`, `counterparty TEXT`, `suspicious INTEGER NOT NULL DEFAULT 0`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`, `UNIQUE (family, key_hash)`;
   - **key**: `key_hash` is SHA-256 of the model's own name for the obligation, NFKC-normalised and lowercased. The name itself is not stored;
   - `title` (≤120 characters) and `counterparty` (≤80) are mail-derived text, kept **for household items only**. A `CHECK (family = 'household' OR (title IS NULL AND counterparty IS NULL))` enforces it;
   - health-admin rows hold no text: type, due date and state only.

3. **`radar_evidence`**, the dedupe key:
   - columns: `message_ref TEXT PRIMARY KEY` (`mail:<Gmail message id>`), `item_ref TEXT NOT NULL REFERENCES radar_items(item_ref) ON DELETE CASCADE`, `seen_at INTEGER NOT NULL`;
   - an item report whose evidence is all already recorded is dropped before the apply turn. An update applies only with at least one new message id.

**Retention.**
- A `reported` item expires 90 days after its due date, or 90 days after `updated_at` when it has none. `expired` and `resolved` items are deleted 30 days later.
- Evidence rows go with their item.
- A hard cap of 1,000 items per family deletes the oldest settled first and never an unexpired `reported` item.
- The sweep runs in the radar executor, with no new timer.

**Not kept, by rule.**
- **Mail bodies are not kept in task checkpoints.** `read_thread`, `get_communication` and `search_communication` join the tools whose output a checkpoint replaces with "not kept; call again", for every job. A resumed attempt reads again; these are safe reads. A job's checkpoint therefore never holds mail text, which may include health values from a clinic or pharmacy mail.
- **Health-admin results are scrubbed at settle.** A health-admin job's kept `result_json` is rewritten to item types, changes and due dates plus finding counts, in the settle transaction.
- **No radar text goes to memory.** The radar apply turn has no `remember`; memory grounding refuses mail quotes in any case.
- **Health-admin text is stored only where the owner approved it.** It does not go to update cards. It is stored only in the approval card's frozen arguments, and, after approval, in the reminder or calendar event the owner approved.

**Forget.** All three tables join the forget store registry (`FORGET_STORES`, ADR-0085) as **derived**:
- an item whose title or counterparty carries a held topic is deleted with its evidence;
- `radar_state` holds no text and is untouched.
Open radar jobs are already cancelled by the `task_jobs` forget path.

**Disconnect and erasure.**
- When the last mail-capable Google grant is removed, all three tables are emptied for the owner, so the next connect starts a fresh backfill.
- Account erasure deletes them (ADR-0055 inventory).
- They are inside the Durable Object's 30-day point-in-time restore window, like every DO table.

**Egress.**
- Ledger text leaves the Durable Object only into the radar job's brief, as the known-items list the worker uses to judge "same item", and into the apply turn's input.
- Both are model-bound and tainted.
- Nothing from the ledger is logged; trace hops carry counts and codes only.

**Additive contracts.** None changes an existing field:
- `ScheduleKind` gains `radar`, with no trigger;
- schedule preferences gain `household_radar` and `health_admin_radar`, on by default;
- `taskResultSchema` gains an optional `items` array of `radarItemSchema`, which only radar jobs read.

## Considered options

- **No ledger; rely on the time window alone.** Rejected: a follow-up mail about a known bill would look new every
  time, and a re-run after a partial job would repeat cards.
- **Reuse `loops` and `loop_mail_sources` (keyed by mail thread).** Rejected:
  - a source loop must bind to mail the update sweep observed (`observed_mail`), which the radar does not write;
  - a thread is not an obligation (one thread can hold many statements);
  - a loop is owner-visible state, and the radar must not create it without the owner's card.
- **Store full item text for every family.** Rejected for health admin: it would persist clinical-adjacent text the
  owner never approved. Household titles are kept because dedupe and "what changed" need them, and the text is the
  kind the update sweep already stores.
- **Hash-only for household too.** Rejected for now: the worker could not judge "same bill, new notice" without
  reading every earlier evidence thread again, which multiplies reads. Revisit if the owner prefers no stored titles
  (open question 6 in the design).
- **Key by model-written key in plain text.** Rejected: the hash dedupes exactly as well and stores no mail text.

## Consequences

- A daily radar applies each piece of evidence once and reports only what is new or changed.
- Two small, bounded, forget-covered tables of derived data, plus one state row per family.
- The checkpoint rule also closes the question of whether reader checkpoints can hold mail-borne health values, for
  every reader job.
- A crash between the apply turn and its commit can still raise a duplicate card, because card idempotency rests on
  the model's tool-call id. The design adds desk dedupe by `(tool, args_digest)` for waiting tainted proposals.

## Verification

- Schema: `CHECK` constraints reject health-admin text; the forget-store test fails if a radar table is missing from
  the registry.
- Dedupe: a job re-run on the same mail applies zero items, and an update with only old evidence is dropped.
- Scrub: after settle, a health-admin job's `result_json` holds no title, counterparty or finding text.
- Checkpoint: a reader job's checkpoint never holds `read_thread` output.
- Disconnect: removing the mail grant empties the three tables.
- Forget: forgetting a merchant name deletes its household item and evidence.
```

## Open review points

- Placement of `namesDose`, the one dose definition, today in `packages/runtime/evals/nightly/dose.ts`. Contracts or runtime; the build PR decides and says why. It is a safety boundary, not stored data, so it is not part of this ADR.
- The inbound-mail ingress for the no-CASA option is a separate ADR: a new ingress, a new store of mail content and sender authentication. Nothing in this draft depends on it.
