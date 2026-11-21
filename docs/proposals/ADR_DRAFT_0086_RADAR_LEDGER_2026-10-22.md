# ADR draft: the mail radar ledger (22 October 2026)

Draft for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. The design it records is [`LAUNCH_JOBS_8_10_RADARS_DESIGN_2026-10-22.md`](LAUNCH_JOBS_8_10_RADARS_DESIGN_2026-10-22.md), revised after the gate review on #1431.

**Number.** 0086 is the next free number after 0085, which the forget-barrier draft in #1414 claims. The final number is assigned in waldo-brain on publication; until then no code cites it by number.

**Status.** Proposed. Not accepted until the owner says so and it is published in waldo-brain. Nothing here changes an accepted ADR by itself.

CLAUDE.md requires bounded contract or ADR review when new stored data extends existing decisions. This draft covers the stored data the radars add and names every existing store their text reaches. It adds no standing grant.

---

```markdown
---
status: proposed
date: 2026-10-22
canonical_location: waldo-brain/01-Waldo/Architecture Decision Records (ADR)/0086-mail-radar-ledger.md
related: [0049-general-agent-tools-v1, 0054-durable-agent-execution, 0055-gdpr-deletion-runbook-all-stores, 0065-do-alarm-multiplexer, 0068-delivery-policy-table, 0081-versioned-health-authority, 0085-forget-barrier-derived-deletion-async-purge]
---

# The mail radars keep a small keyed ledger in the owner's Durable Object; mail bodies and health-admin text are not kept in it

## Context

Launch jobs 8–10 run as scheduled reader jobs over the owner's mail: bills and subscriptions, parcels and returns, and
health admin. A daily job must not report the same bill every day, must notice when a known item changes, and must
apply each result once. That needs state that survives between jobs. The worker layer keeps a job's brief, checkpoint
and result in `task_jobs`; it drops the checkpoint and the result when the job settles or is cancelled, and trims
settled rows to the newest 200. That is not a ledger of what the owner has already been told.

Mail is external, tainted text. CLAUDE.md treats full mail bodies as normal agent context within the owner's
authorization, and requires their storage and egress to be documented in the owning contract. Health values must never
be stored in Durable Object SQLite. Lab results need a health-plane contract review before Waldo reads their values,
and the owner ruling on health data in chat does not cover health facts taken from mail.

## Decision

The owner's Durable Object (the only writer) keeps four tables for the radars. No worker writes them. All writes but
two happen in the apply transaction of a radar job, together with that job's settle; the two exceptions hold ids only
(`radar_cards` at each card, `radar_state.budget_hit_job` at a budget refusal).

1. **`radar_state`**, one row per radar family:
   - columns: `family TEXT PRIMARY KEY CHECK (family IN ('household','health_admin'))`, `through_ms INTEGER`, `backfilled_at INTEGER`, `last_job_id TEXT`, `last_outcome TEXT`, `budget_hit_job TEXT`, `failed_days INTEGER NOT NULL DEFAULT 0`, `updated_at INTEGER NOT NULL`;
   - `through_ms` is the watermark. It advances, to the window end the job's brief named, when the result is `done` or a budget-limited `partial` (`budget_hit_job` names this job). Backfill is best effort: what a budget-limited run skipped is named in its `left`. Any other outcome leaves the watermark;
   - `failed_days` counts consecutive days whose runs all failed or were parked; a `done` or budget-limited run resets it. At 3, the owner is told once that Waldo could not check their mail.

2. **`radar_items`**, one row per obligation the model identified:
   - columns: `item_ref TEXT PRIMARY KEY` (`rad_` + 12 hex), `family TEXT NOT NULL`, `type TEXT NOT NULL CHECK (type IN ('bill','subscription','delivery','return','health_admin'))`, `key_hash TEXT NOT NULL`, `due TEXT`, `state TEXT NOT NULL CHECK (state IN ('reported','dismissed','resolved','expired'))`, `title TEXT`, `counterparty TEXT`, `suspicious INTEGER NOT NULL DEFAULT 0`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`, `UNIQUE (family, key_hash)`;
   - **key**: `key_hash` is SHA-256 of the model's own name for the obligation, NFKC-normalised and lowercased. The name itself is not stored;
   - **health admin is one type** until the lab-report review: no row records that the owner has an appointment, a refill or a result;
   - `due` is a strict ISO date, or an ISO date-time with offset, validated by the contract before it is stored;
   - `title` (≤120 characters) and `counterparty` (≤80) are mail-derived text, kept **for household items only**. A `CHECK (family = 'household' OR (title IS NULL AND counterparty IS NULL))` enforces it. Any field that names a medicine dose is cleared before it is stored;
   - `dismissed`: the owner skipped, or let expire, a card linked to the item. A later update reaches the digest, never another card.

3. **`radar_evidence`**, the dedupe key:
   - columns: `message_ref TEXT PRIMARY KEY` (`mail:<Gmail message id>`), `item_ref TEXT NOT NULL REFERENCES radar_items(item_ref) ON DELETE CASCADE`, `seen_at INTEGER NOT NULL`;
   - an item report whose evidence is all already recorded is dropped before the apply turn. An update applies only with at least one new message id.

4. **`radar_cards`**, the card count and links:
   - columns: `approval_id TEXT PRIMARY KEY`, `job_id TEXT NOT NULL`, `item_ref TEXT REFERENCES radar_items(item_ref) ON DELETE CASCADE`, `created_at INTEGER NOT NULL`;
   - written when a card-raising call in a radar apply turn succeeds, so a re-run apply counts the cards its earlier run raised. At most 3 per job: the 4th card-raising call is refused and pointed at the digest;
   - `item_ref` is set only when the card's frozen arguments have the same stable digest as the worker proposal the item named.

**Retention.**
- A `reported` or `dismissed` item expires 90 days after its due date, or 90 days after `updated_at` when it has none. Expiry clears `title` and `counterparty`. `expired` and `resolved` rows are deleted 30 days later, so a row lives at most 120 days past its due date and holds text for at most 90.
- Evidence and linked card rows go with their item; unlinked card rows are deleted after 30 days.
- A hard cap of 1,000 items per family deletes the oldest settled first and never an unexpired `reported` item.
- The sweep runs in the radar executor, with no new timer. It also deletes radar rows in `update_cards` once folded and 30 days old.

**Not kept, by rule.**
- **Mail bodies are not kept in task checkpoints.** `read_thread`, `get_communication` and `search_communication` join the tools whose output a checkpoint replaces with "not kept; call again", for every job. A resumed attempt reads again, so the read budget is counted per attempt and a job's reads are bounded by the budget times the crash limit.
- **A settled radar job keeps no titles.** The apply transaction replaces the brief's known-items list with its count before the settle; the settle drops the result and the checkpoint.
- **No radar text goes to memory.** The radar apply turns have no `remember`; memory grounding refuses mail quotes in any case.
- **No dose is stored or shown.** One runtime dose definition is applied to every radar title, counterparty, finding, proposal and card argument, in both families.

**Where radar text does go.** The design's §6 table is the inventory: store, what it holds, retention, forget and
disconnect. In short:
- household titles and counterparties: `radar_items`, the household digest rows in `update_cards`, an open job's brief;
- every radar job's findings and proposals: the job's result until settle, and the apply turn's input, which the
  conversation store keeps as a machine entry with its reply;
- household apply-turn mail reads: the tool-output offload, as summaries of at most 500 characters, newest 6 kept;
- every card: its frozen arguments and summary on the approval desk (`ledger`), and after approval the reminder,
  loop or calendar event.

**Health-admin text** (place, date, prep; never values or doses) is not kept in `radar_items`, in `update_cards` (its
overflow line holds a count and dates only) or in a settled `task_jobs` row. It does pass through the job's result
until settle, and is kept in the conversation store as the apply turn's input, on the approval desk as each card's
frozen arguments, and after approval in the reminder or calendar event. The health-admin apply turn reads no mail, so
none reaches the tool-output offload. The owner sees every card's text before approving; the conversation entry and a
decided card's payload are kept whether or not the owner approved it.

**Forget.** All four tables join the forget-store inventory (today the `TABLES` map in
`packages/runtime/test/forget-store-table.test.ts`; `FORGET_STORES` in the ADR-0085 draft):
- `radar_items` is **derived**: an item whose title or counterparty carries a held topic is deleted with its evidence and card links;
- `radar_evidence`, `radar_cards` and `radar_state` hold ids, hashes, counts and times, and are exempt.
Open radar jobs are already cancelled by the `task_jobs` forget path. `update_cards`, `task_jobs`, the conversation
store and the tool-output offload are purged by literal redaction today. The approval desk's decided rows are a known
forget gap that this ADR does not widen or close; waiting cards carrying the topic are ended.

**Disconnect and erasure.**
- When the last mail-capable Google grant is removed, the owner object cancels every open radar job (fencing its worker and withdrawing its cards) and empties the four tables and the radar rows in `update_cards`, in one transaction, so the next connect starts a fresh backfill. A run that was mid-apply finds its job cancelled at commit and writes nothing.
- Account erasure deletes them (ADR-0055 inventory).
- They are inside the Durable Object's 30-day point-in-time restore window, like every DO table.

**Egress.**
- Ledger text leaves the Durable Object only into the radar job's brief, as the known-items list the worker uses to judge "same item", into the apply turn's input, and into the day card's input as digest lines.
- All are model-bound and tainted. The day card turn reads them as tainted data (a build prerequisite).
- Nothing from the ledger is logged; trace hops carry counts and codes only.

**Additive contracts.** None changes an existing field:
- `ScheduleKind` gains `radar`, with no trigger;
- schedule preferences gain `household_radar` and `health_admin_radar`, on by default;
- `taskResultSchema` gains an optional `items` array of `radarItemSchema` (one health-admin type, strict ISO `due`, an optional `proposal` index), which only radar jobs read;
- `toolErrorCodeSchema` gains `budget_exhausted`, with its row in `TOOL_ERRORS`: the refusal a radar read past its budget returns. Turn-event error codes and hop names are free strings and need no change.

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
- **Store the health-admin kind (appointment, refill, result ready) as the row type.** Rejected until the lab-report
  review: the type itself is a health fact taken from mail.
- **Hash-only for household too.** Rejected for now: the worker could not judge "same bill, new notice" without
  reading every earlier evidence thread again, which multiplies reads. Revisit if the owner prefers no stored titles
  (open question 6 in the design).
- **Key by model-written key in plain text.** Rejected: the hash dedupes exactly as well and stores no mail text.
- **Advance the watermark only on `done`.** Rejected: a capped backfill or a heavy day ends `partial`, so the
  watermark would never move and the "couldn't check your mail" notice would fire falsely.

## Consequences

- A daily radar applies each piece of evidence once and reports only what is new or changed.
- Four small, bounded tables of derived data and ids, one of them forget-derived.
- The checkpoint rule also closes the question of whether reader checkpoints can hold mail-borne health values, for
  every reader job.
- Backfill and heavy days are best effort; the owner is told how far back a first run read.
- A crash between the apply turn and its commit no longer raises a duplicate card: the desk returns a still-waiting
  tainted or calendar proposal with the same digest.
- Health-admin text the cards need is kept where every apply turn's input and every card are kept. Narrowing that
  (an apply turn not saved to the conversation) is a later change to the turn runner, not part of this ADR.

## Verification

- Schema: `CHECK` constraints reject health-admin text and any type outside the five; the contract rejects a free-text
  `due`; the forget-store test fails if a radar table is missing from the inventory.
- Watermark: a budget-limited partial advances it and records what was skipped; a transient partial leaves it; only
  failed or parked days count toward the notice.
- Dedupe: a job re-run on the same mail applies zero items, and an update with only old evidence is dropped.
- Cards: the 4th card-raising call of a job is refused, including after a re-run apply; a skipped linked card makes its
  item `dismissed`.
- Settle: after settle, a radar job's brief holds no titles and its result and checkpoint are null.
- Checkpoint: a reader job's checkpoint never holds `read_thread` output.
- Dose: no radar table, digest row or card holds text that names a dose.
- Disconnect: removing the mail grant mid-run cancels the job and leaves the four tables empty.
- Forget: forgetting a merchant name deletes its household item, evidence and card links.
```

## Open review points

- Placement of `namesDose`, the one dose definition, today in `packages/runtime/evals/nightly/dose.ts`. Contracts or runtime; the build PR decides and says why. It is a safety boundary, not stored data; this ADR records only that it covers all radar text.
- The `close_loop` gate (owner-made loops close only by card under external taint) is a prerequisite reviewed in its own PR; it extends ADR-0049's taint law and adds no stored data.
- The inbound-mail ingress for the no-CASA option is a separate ADR: a new ingress, a new store of mail content and sender authentication. Nothing in this draft depends on it.
