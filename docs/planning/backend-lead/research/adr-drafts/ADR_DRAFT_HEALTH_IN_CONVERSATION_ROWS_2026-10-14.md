> **DRAFT for owner decision.** Written 14 Oct 2026 by the backend lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. Each draft went through research, two adversarial verifiers (source and risk) and a reviser. Status: Proposed. Not accepted until the owner says so.

# ADR draft: health values in conversation rows (the transcript and its index keep them; a model class gates new stores and claims)

Status: Proposed. Decision packet G37. It is not authoritative until four things happen: the owner rules, it is published in Brain under the next free number (it carries the ADR-0081 matrix row in 2.8 as an amendment), the canonical security checklist in Brain is amended and remirrored, and `docs/foundation/accepted-adrs.json` is regenerated.

Source read at `beta-mvp` `e5c022ef`, Brain at `23c4f99`. File paths are under `packages/runtime/src/` unless named otherwise.

## 1. Context

**Where a value goes today.** A health value is a measurement, reading, score, lab result or medication dose. The owner may type one in chat, or Waldo may say one back in an owner-channel reply. Either way it is stored verbatim:

1. **The transcript row.** The canonical store scrubs only secret URLs (`conversation/canonical-owner-store.ts:19-22`, applied at `:150`). The Telegram store does the same (`channels/conversation-store.ts:54-56`). iMessage uses the canonical store (`channels/owner-do.ts:2820`).
2. **The episode index.** An FTS5 table in the owner object (`channels/episodes.ts:51`), fed by the Telegram and app stores (`owner-do.ts:2750`, `:2814`). Its readers all feed model context: `search_episodes`, B3 recall (`memory/turn-recall.ts:42-55`) and the nightly model call (`owner-do.ts:3031-3039`).
3. **Claims.** `remember` stores an owner-grounded claim and its quote (`tools/live/memory.ts:50-71`). Health is a profile kind (`memory/claims.ts:19-21`), so the claim enters every turn's system prompt through `turnMemoryPrompt` (`claims.ts:1056-1075`, called at `channels/owner-turn.ts:546`). Tests pin this (`test/memory-health-contact-route.test.ts:28`, `test/memory-health-owner-turn.test.ts:37-38`). The nightly instruction does not ask the model to leave numbers out (`claims.ts:1111`).

**What rejects health today.** The generic floor at `memory_block`, `r2_summary` and the other destinations (`packages/contracts/src/memory/sanitise.ts:349-362`). The numeric check on a compaction summary (`owner-turn.ts:745-746`), using `numericHealthIn` (`scribe/sanitiser.ts:90-91`). That predicate is English keyword regexes for sensor and score shapes. It misses lab values, doses and non-English text.

**The rules in force.**
- Ruling 2: the owner's readings and derived context may reach model context and owner-channel replies end to end (`docs/app/HEALTH_PLANE_AMENDMENT.md:7`).
- Long-term memory holds qualitative patterns plus a pointer (`:23`).
- Raw retention is 90 days; withdrawing model use stops health use in conversation (`:27`). Withdrawal-purge scope gates outside users (`:9`).
- CLAUDE.md line 11: whether a row is health is a judgment; no fixed rule decides it. Medication dosing is a hard boundary.
- CLAUDE.md line 23: sensitive chat is classified at ingress; never logs, audit, R2, browser jobs, third-party sends or drafts, tainted paths, or bulk long-term memory.
- ADR-0081: "never" means the schema and the sanitiser reject (line 80). A user-stated numeric goal persists in the DO as quoted user intent (row at line 90). Withdrawal deletes reconstructive residues, DO run residues included (lines 111, 113). Its matrix has no row for a value inside a conversation row.
- The retained contract asks for deterministic classification and a quarantine before any transcript write (`docs/planning/waldo-agent-mvp/IMPLEMENTATION_CONTRACTS.md:16-17, :39`). It also requires generations that late writers check (`:37`, `:41`).

**Why this blocks features.** Semantic recall (B4) promises that health is never embedded, but no store knows which row is health. Compaction (B2) was waiting on whether its input may hold values.

**What the owner needs.** The app shows each row's text verbatim (`channels/app-api.ts:197-218`). The owner must see their own words on every device.

## 2. Decision

### 2.1 Scope
A conversation row carries a health value when it states a measurement, reading, score, lab result or medication dose about any person: the owner, family or anyone else. The model decides whether a row does.

### 2.2 The transcript and its index keep the row as written
- The transcript row stays verbatim in the store that holds the chain. The scrub stays secret-URL only.
- The episode index is part of the transcript record. It keeps rows verbatim, under the same forget, thread erase and account deletion as the transcript. Its readers feed model context only.
- The model window, recall and search read these rows under ruling 2, while model-use consent is active.
- Neither the row nor the index text goes to logs, audit records, R2, metrics, browser jobs, or third-party sends or drafts, unless the owner asks to share that item.

### 2.3 One class per row, from the model
- Each row gets one class: `none`, `qualitative` (health in words, no value) or `values`. For `values`, the answer also carries `value_free_text`: the row restated without any value, in the row's language.
- **When.** At ingress, beside the turn: one call per owner turn, never awaited by the reply. It classifies the new owner row and up to N pending rows of the chain, the previous reply included. CLAUDE.md line 23's "classified at ingress" is met by the pending record at persist and this call.
- **How.** Outside any SQLite transaction. `admit()` before the call and before the write. The purpose is metadata-only in the model-call log. The chat provider runs with `store: false`.
- **Retries.** The nightly pass is the one retry owner. It drains pending rows in bounded batches and counts attempts. After 3 failed attempts a row becomes `unclassified`, a terminal fail-closed state.
- No regex decides the class.

### 2.4 Where the class lives, and who writes it
- Table `row_class` in the owner object's SQLite: `entry_id` (primary key), `chain_ref`, `persisted_at`, `class` (pending, none, qualitative, values, unclassified), `value_free_text` (values rows only), `source_digest`, `consent_epoch`, `attempts`, `classified_at`.
- Its only writer is `conversation/row-class.ts`. A wrapper on all three chain stores writes `pending` when a row persists.
- **Fence.** A class answer commits only if, in the same commit, the source row still exists, its digest equals the digest sent to the model, the class is still `pending`, and the consent epoch is unchanged. Otherwise the answer is dropped.
- A row with no class row counts as not classified for every reader.
- **Never authority.** The class only narrows what a store receives. It never widens a destination and never authorises cross-surface replay, a send or a draft. Class labels never appear in logs, metrics, traces or audit; only content-free counts of pending and unclassified rows may.

### 2.5 What each store takes

| Store | `none` | `qualitative` | `values` | pending, unclassified or no class row |
|---|---|---|---|---|
| Transcript and episode index | verbatim | verbatim | verbatim | verbatim |
| Compaction input | verbatim | verbatim | verbatim; the summary follows policy (a) and its numeric floor | verbatim |
| Embeddings (B4) | yes, if the text passes `numericHealthIn` | no | no | no |
| Claims | as today | qualitative claim | qualitative statement plus `source_ref`; never the value | qualitative statement plus `source_ref` |

- **Claims.** The `remember` description and the nightly instruction ask the model for a qualitative statement plus `source_ref`. `remember` keeps its `internal_context` destination. `numericHealthIn` runs explicitly in `remember` and in the nightly settle as the ADR-0024 Art-9 backstop. It catches sensor and score shapes only.
- **Exact value on demand.** `read_memory` may return the exact value from the source row, as model context, only when the chain's recall reach includes that row. Otherwise it returns the qualitative claim.
- **Existing claims.** A one-time model pass rewrites numeric health claims to the qualitative form and purges their `memory_backups` payloads.

### 2.6 Forget, deletion and withdrawal
- **Forget.** A forget hit on a row's text redacts it literally in the transcript, the index and `value_free_text`. The row's class is then reset to `pending` and re-derived from the redacted row, because a paraphrase can carry a topic without its words.
- **Embeddings.** A forget settles only after the vector delete is read back.
- **Deletion.** Thread erase removes class rows. Account deletion wipes them through `storage.deleteAll()`.
- **Storage withdrawal (required before any outside user).** A consent signal reaches the owner object and advances the consent generation before any purge. Each `values` row in the transcript and index is rewritten to its `value_free_text`, with its witness, in one unit. `unclassified` and unclassed rows get the fixed marker `[health details removed]`.
- **Model-use withdrawal (required before any outside user).** Values rows are projected value-free into the model window, recall and search at read time. The exact-value read is off.

### 2.7 Retention (amends ADR-0081 §3 for conversation rows)
- Owner-typed rows that carry values stay until the owner deletes the message, thread or account, or forgets it. Precedent: ADR-0081's user-stated goal row, kept as quoted user intent.
- Waldo's reply rows that carry values are rewritten to their `value_free_text` after 90 days, matching the raw window. This runs before any outside user; during owner-only beta it does not.

### 2.8 ADR-0081 matrix row (amendment carried by this ADR)

| Field class | Canonical destination and retention | Authenticated product surface | Prompt / DO / R2 / memory / trace eligibility | External-channel eligibility |
|---|---|---|---|---|
| Health value inside a conversation row (owner-typed, or in Waldo's owner-channel reply; about any person) | The owner's transcript row and its episode index in the owner object. Owner-typed rows: until deleted or forgotten. Reply rows: value-free after 90 days. Withdrawal per 2.6. | The owner's own transcript | Model context: yes while model-use consent is active (ruling 2). Embeddings: excluded by model class plus the numeric floor; residual: misclassified values the floor does not match, in any language. Compaction summary: qualitative only, numeric floor. Claims: qualitative plus pointer, model-judged, numeric floor backstop. R2, logs, audit, metrics: never (schema and sanitiser). Traces: the staging exception only. | Only when the owner asks to share that item |

### 2.9 The switch
`ROW_CLASS.enabled` gates classification. Off, no class rows are written, and B4 embeds no rows (no class means no embedding). Compaction does not depend on it.

## 3. Considered Options

1. **Quarantine at ingress** (the retained contract, with model classification in place of DLP). The strongest Art-9 posture. Rejected for now: a crash window before persist, a hosted migration, an app.v1 change, markers on the owner's own screen, and [inference] the value has already crossed the channel and the provider. It returns if a legal or App Store review forbids owner-typed values in Waldo's own storage.
2. **Verbatim everywhere.** Rejected: it breaks `HEALTH_PLANE_AMENDMENT.md:23` and compaction policy (a), puts health text into an invertible embedding store (Morris et al., EMNLP 2023: 92% exact recovery of 32-token inputs on the models tested), and Vectorize deletes are asynchronous.
3. **This decision.** The transcript and index stay verbatim; the class gates embeddings and claims.
4. **Full split.** The index, compaction input and nightly pass take a value-free form. Rejected for now: it puts three slices in front of compaction, pending rows stall search, nightly and compaction, and index paraphrases read as the owner's words. It becomes the choice if the owner reads the index as long-term memory.

## 4. Consequences

- **Benefits.**
  - The owner sees their words verbatim on every surface.
  - Compaction is unblocked by this ruling alone.
  - "Health never embedded" and "qualitative plus pointer" become enforceable, decided by the model, with a stated residual.
  - Exact values leave the every-turn system prompt.
  - No app.v1, Supabase, wrangler or edge change.
  - A3 visibility can read the class later, to narrow only.
- **Costs and risks.**
  - One cheap model call per owner turn. [inference] Small; the build PR reports tokens per turn.
  - The index keeps values as long as the transcript does.
  - Misclassified values the floor misses can reach embeddings.
  - The claims rule rests mostly on model judgment.
  - `row_class` holds value-free paraphrases, so forget must reach it.
  - Two pinned memory tests change.
- **Amended text.**
  - ADR-0081 §3 (matrix and retention) and §5 (withdrawal), for conversation rows, through 2.6-2.8.
  - `IMPLEMENTATION_CONTRACTS.md:16`, `:17` and `:39` are superseded for rows in the owner's own channel. `:37` and `:41` stand; the fence in 2.4 and the generation in 2.6 meet them.
  - The security checklist's "no health values in DO SQLite tables" gets an exception for the owner's transcript and index, through a canonical Brain edit and remirror.
- **Impact surface.** New `conversation/row-class.ts`; `channels/owner-turn.ts`; `channels/owner-do.ts` (store wiring, erase, classifier host, nightly drain, hideHistory, resolver, consent signal); `memory/claims.ts`; `tools/live/memory.ts`; `channels/app-health.ts`; `conversation/canonical-owner-store.ts`; `channels/conversation-store.ts`; `channels/episodes.ts`; the B4 vector outbox; tests for each.

## 5. Verification and tests

All fixtures are synthetic. None carries a real value.

- **Class.** Each persisted row on all three chain stores gets exactly one `row_class` row. A `values` row's `value_free_text` contains no reading.
- **Fence.** Forget, thread erase and withdrawal each land between the classify call and its commit. No class row and no `value_free_text` survive.
- **Terminal state.** A classifier that always fails leaves the row `unclassified` after 3 attempts. Nothing else waits on it. Only content-free counts are logged.
- **Ingress.** The classify call does not delay the reply (trace assertion on hop order). A closed run writes nothing.
- **I/O order.** The model call runs outside the SQLite transaction.
- **Embeddings.** Conformance: a `qualitative`, `values`, pending, `unclassified` or unclassed row never reaches the embedding call. A `none` row whose text trips `numericHealthIn` is not embedded. Vector deletes are read back before a forget settles.
- **Claims.**
  - A sensor-shaped value in `remember` text or evidence is refused with the qualitative-plus-pointer instruction.
  - Scenario eval: the owner states a lab value and a dose; the stored claim is qualitative with a `source_ref`.
  - `read_memory` returns the exact value from the source row in reach, and the qualitative claim when the row is in a private thread out of reach.
  - The one-time pass leaves no numeric health claim and no matching `memory_backups` payload.
  - The two pinned tests are rewritten red first.
- **Forget.** A topic present only in a `values` row is forgotten from the transcript, the index and `value_free_text`, and resurfaces nowhere after re-derive.
- **Withdrawal.** Storage withdrawal leaves no `values` row verbatim in any chain store or the index. Model-use withdrawal sends value-free text to the model and disables the exact-value read.
- **Retention.** A Waldo reply row with values older than 90 days is rewritten value-free; an owner-typed row is not.
- **App.** The transcript page returns the owner's row verbatim, with no app.v1 change.
- **Hostile.** A row that tells the classifier to mark it `none` is classed by its content. A malformed answer counts as a failed attempt.
- **Concurrent.** Two turns on one chain settle classes without loss or duplication.
- **Classifier eval (the falsifier).** At least 150 rows per class, with subsets for third-party values, doses, Hindi, Marathi and mixed text, and quoted content. Three runs. Report the 95% upper bound. Flip bar: upper bound of values rows labelled `none` at most 3%, and no subset with a values row labelled `none` in more than one run; `none` rows labelled `values` at most 5%.

## 6. Rollback

- `ROW_CLASS.enabled = false` stops new class writes. B4 then embeds no rows, because no class means no embedding. Compaction is unaffected.
- Existing class rows stay and are ignored. They hold no values.
- Claims already in pointer form stay valid.
- No hosted data changes, so no data rollback is needed. Rolling back reopens G37 for B4.