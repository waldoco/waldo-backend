> **UNVERIFIED DRAFT (research stage only).** Produced 14 Oct 2026 by the lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. The two adversarial verifiers and the reviser did not run because the session limit was reached. Verify against source before relying on it. Not accepted: the owner decides.

# ADR draft: health values in conversation rows (the transcript keeps them; derived stores never do)

Status: Proposed. Decision packet G37. It is not authoritative until three things happen: the owner rules, it is published in Brain under the next free number together with the ADR-0081 matrix row in 2.8, and `docs/foundation/accepted-adrs.json` is regenerated.

Source read at `beta-mvp` `e5c022ef`, Brain at `23c4f99`. File paths are under `packages/runtime/src/` unless named otherwise.

## 1. Context

**Where a value goes today.** A health value is a reading, score or lab result. The owner may type one in chat, or Waldo may say one back in an owner-channel reply. Either way it is stored verbatim in four places.

1. **The transcript row.** The canonical store scrubs only secret URLs (`conversation/canonical-owner-store.ts:19-22`, applied at `:150`). The Telegram store does the same (`channels/conversation-store.ts:54-56`).
2. **The episode index.** It is an FTS5 table in the owner object (`channels/episodes.ts:51`). The owner's message is indexed when it is stored, before the turn runs (`:141-145`). Saved rows follow (`:146-152`). The boot backfill indexes `appPayload` as is (`:157-163`). Three readers use it: `search_episodes`, B3 recall (`memory/turn-recall.ts:42-55`) and the nightly pass (`channels/owner-do.ts:3031-3039`).
3. **Claims.** `remember` stores an owner-grounded claim and its verbatim quote (`tools/live/memory.ts:50-71`). Tests pin a numeric lab value being stored and read back (`test/memory-health-contact-route.test.ts:23-31`, `test/memory-health-owner-turn.test.ts:25-41`). The pre-tool destination for `remember` is `internal_context` (`hooks/registry.ts:904-917`). There the free-text health scan is off for null-taint text (`scribe/sanitiser.ts:585-590`). Health claims render into the system prompt's "About you" block (`memory/claims.ts:997`).
4. **The nightly pass.** It reads the index text, so it sees every value.

**What rejects health today.** The generic floor at `memory_block`, `r2_summary` and the other destinations (`packages/contracts/src/memory/sanitise.ts:349-362`). The numeric check on a compaction summary (`channels/owner-turn.ts:745-746`).

**The rules in force.**
- Ruling 2: the owner's readings and derived context may reach model context and owner-channel replies end to end (`docs/app/HEALTH_PLANE_AMENDMENT.md:7`).
- Long-term memory holds qualitative patterns, with numeric evidence in the health plane and "the qualitative pattern and a pointer" in memory (`:23`).
- CLAUDE.md line 23: never logs, audit records, R2 summaries, browser jobs, third-party sends or drafts, externally tainted paths, or bulk long-term memory; sensitive chat is classified at ingress.
- CLAUDE.md line 11: whether something is health is a judgment, so no fixed rule decides it.
- CLAUDE.md line 17: conversation-body storage needs this review.
- ADR-0081's matrix has no row for a value inside a conversation row.
- The retained contract asks for a deterministic quarantine before any transcript write (`docs/planning/waldo-agent-mvp/IMPLEMENTATION_CONTRACTS.md:15-17, 39`). It predates ruling 2, and its deterministic classification conflicts with CLAUDE.md line 11.

**Why this blocks two features.**
- Compaction is approved and built behind `COMPACTION.enabled = false` (`conversation/compaction.ts:7-8`). It summarises a verbatim chain.
- Semantic recall (B4) promises that health is never embedded.
- Neither can be held to its own rule without knowing which row carries health. No store knows that today.

**What the owner needs.** The app shows each row's text verbatim (`channels/app-api.ts:197-218`). The owner must see their own words on every device. Thread titles already use the value-free pattern: the title model is told to leave out numbers and readings (`channels/app-threads.ts:53-58`).

## 2. Decision

### 2.1 Scope
A conversation row carries a health value when it states a measurement, reading, score or lab result about the owner's body. The owner may have typed it on any surface, or Waldo may have said it back in an owner-channel reply. The model decides whether a row does.

### 2.2 The transcript keeps the row as written
- The chain is the owner's own channel. The row stays verbatim in the store that holds the chain: the owner object today, the publication service if the build plan's move lands.
- The scrub stays secret-URL only. The model window reads the row verbatim, under ruling 2.
- The row never goes to logs, audit records, R2, metrics, browser jobs, or third-party sends or drafts.
- This is the one exception to "no health values in DO storage". It is bounded to the owner's own rows.

### 2.3 One class per row, from the model
- Each new row gets one class:
  - `none`: no health content;
  - `qualitative`: health in words, no value;
  - `values`: at least one value. For `values`, the same answer carries `index_text`: the row restated without any value, in the row's language, written as Waldo's note about the message.
- When it runs: the owner row's call starts when the row is persisted at ingress, beside the turn, never blocking the reply. The reply row is classified after delivery.
- How it runs: outside any SQLite transaction, under the run scope (`admit()` before the call and before the write). The purpose is metadata-only in the model-call log, as for `compaction` (`owner-turn.ts:255`). The call goes to the chat provider with `store: false`.
- No regex decides the class.

### 2.4 Where the class lives, and who writes it
- A new table in the owner object's SQLite, beside the `episodes` FTS table: `episode_class(entry_id TEXT PRIMARY KEY, class TEXT NOT NULL, classifier TEXT, classified_at INTEGER)`. It holds no content.
- Its only writer is the episode index module (`channels/episodes.ts`). The module writes a row's class and its index rows in one commit. The forget paths that write `episodes` with raw SQL today (`owner-do.ts:2770-2777`, `memory/claims.ts:626-632`) move behind the module's methods.
- Persisting an owner row writes `pending` and nothing else.
- A `values` row's text lives only in its index row, so content is never copied.
- One writer covers both chain stores, which both feed this index (`owner-do.ts:2750`, `:2814`).

### 2.5 What each derived store takes

| Store | `none` | `qualitative` | `values` | `pending` |
|---|---|---|---|---|
| Episode index, `search_episodes`, B3 recall | verbatim, as today | verbatim | `index_text`, as a whole-message row that never reads as the owner's own words (`episodes.ts:12-15`) | not indexed |
| Embeddings (B4) | yes | no | no | no |
| Compaction input | verbatim | verbatim | `index_text` | the span waits; no attempt counted |
| Nightly pass | as today | as today | `index_text`; it never grounds a claim | holds the nightly mark |
| Claims | as today | qualitative claims | qualitative statement plus `source_ref` to the row | n/a |

- **Backstop.** Before a `values` row's `index_text` is written, it passes the Scribe's numeric predicate (`numericHealthIn`, `scribe/sanitiser.ts:90-91`). On a hit, the index stores the fixed marker `[health details left out]` instead. This is ADR-0024's Art-9 lockout at a persistent write; it never classifies.
- **Compaction summary.** It keeps its numeric check (`owner-turn.ts:745-746`).
- **Claims.**
  - `remember` and the nightly settle refuse a claim whose text or evidence carries a numeric reading, through the ADR-0024 memory-write floor. The tool error tells the model to keep the qualitative statement and the pointer.
  - `read_memory` returns the exact value from the source row when the model asks, as model context only.

### 2.6 Forget, deletion and withdrawal
- **Forget.** A forget whose topic hits a row's verbatim text removes that row's index rows and class by `entry_id`. The row is then re-derived from its redacted text. A paraphrase can carry a topic without its words, so the literal rewrite alone is not enough; compaction rows are forgotten by `covers` for the same reason.
- **Embeddings.** A forget settles only after the vector delete is read back.
- **Deletion.** Thread erase (`owner-do.ts:990-997`) and account deletion remove class rows with their index rows.
- **Withdrawal of health storage consent.** During owner-only beta, chat rows are unchanged. Before any outside user, withdrawal rewrites each `values` row in the transcript to its `index_text`, with its witness, in one unit.

### 2.7 Existing rows and the switch
- Rows indexed before this decision become `pending` and are re-derived in bounded batches by the nightly pass.
- `ROW_CLASS.enabled` gates classification. Compaction's flip and B4's flip each require it on and the backlog empty; a conformance test asserts both.

### 2.8 ADR-0081 matrix row (to publish in Brain)

| Field class | Canonical destination and retention | Authenticated product surface | Prompt / DO / R2 / memory / trace eligibility | External-channel eligibility |
|---|---|---|---|---|
| Health value inside a conversation row (owner-typed, or in Waldo's owner-channel reply) | The owner's transcript row. It stays until the owner deletes the message, thread or account, or forgets it. Withdrawal per 2.6. | The owner's own transcript | Model context: yes (ruling 2). Episode index, embeddings, compaction summary, nightly pass, claims: the class-derived form only, never the value. R2, logs, audit, metrics: never. Traces: the staging exception only. | Never, unless the owner asks to share that item |

## 3. Considered Options

1. **Quarantine at ingress** (the retained contract, with model classification in place of DLP). Values go to a new owner-only Supabase table; the transcript holds a marker and an opaque ref. This is the strongest Art-9 posture. Rejected for now:
   - the classify call must finish before the row persists, or a crash loses the input;
   - it needs a hosted migration and an app.v1 change;
   - every reader must resolve refs, and the owner sees markers on a new device;
   - [inference] the value already crossed the channel and the provider.
   It returns if a legal or App Store review forbids owner-typed values in Waldo's own storage.
2. **Verbatim everywhere** (amend ADR-0081). The least work and the best recall. Rejected:
   - it breaks HEALTH_PLANE_AMENDMENT.md:23 and the owner-approved compaction policy (a);
   - it puts health text into an embedding store. Vec2Text recovered 92% of 32-token inputs exactly on the models it tested (Morris et al., EMNLP 2023), and Vectorize deletes are asynchronous.
3. **Verbatim inside the owner object; classify only at new stores.** Rejected:
   - the index keeps feeding values to the nightly pass and recall blocks;
   - it does not meet "classified at ingress";
   - it needs the same classifier anyway.
4. **The split** (this decision).

## 4. Consequences

- **Benefits.**
  - The owner sees their words verbatim on every surface, and the model sees them in its window.
  - Every derived store reads one per-row answer, written by the model.
  - "Health never embedded" and "qualitative plus pointer" become enforceable.
  - No app.v1, Supabase, wrangler or edge change.
  - A3 visibility can read the same class later. This ADR does not decide visibility.
- **Costs and risks.**
  - One or two cheap model calls per turn. [inference] Small; the build PR reports tokens per turn.
  - A row is unsearchable while pending.
  - Paraphrase loses detail; the pointer recovers the exact value.
  - A misclassified `values` row would index verbatim. The numeric backstop catches only pattern-shaped values.
  - Two pinned memory tests change.
  - The existing index needs a one-time re-derive.
- **Impact surface.**
  - `channels/episodes.ts`;
  - new `conversation/row-class.ts`;
  - `channels/owner-turn.ts`;
  - `channels/owner-do.ts` (the classify call, the hideHistory hunk, the nightly mark);
  - `memory/claims.ts`, `tools/live/memory.ts`, `hooks/registry.ts`;
  - `conversation/compaction.ts`;
  - the B4 vector outbox;
  - the tests for each.
- **Superseded text.**
  - `IMPLEMENTATION_CONTRACTS.md:17` and `:39`, for rows in the owner's own channel.
  - The security overlay's "no health values in DO storage", for transcript rows only.
- **Process.** Not authoritative until the Brain publication and the regenerated `accepted-adrs.json`.

## 5. Verification and tests

All fixtures are synthetic. None carries a real value.

- **Class.** For each class, a row gets exactly one `episode_class` row. A `values` row's index text has no reading. A `pending` row is in no index, vector or compaction input.
- **Backstop.** A fake classifier returns `index_text` that still carries a reading. The index stores the fixed marker, never the reading.
- **Ingress.** The owner row's class call does not delay the reply: trace assertion on hop order. A crash between persist and class leaves the row `pending`, and the next turn classifies it.
- **I/O order.** The model call runs outside the SQLite transaction. A closed run writes nothing.
- **Compaction.** A `values` row inside the span never reaches the compaction call's input. The existing health pair from the B2 addendum still holds.
- **Embeddings.** Conformance: a `qualitative`, `values` or `pending` row never reaches the embedding call.
- **Nightly.** A `values` row never grounds a claim as the owner's words. A late-classified row is consolidated exactly once.
- **Claims.**
  - `remember` with a numeric reading in text or evidence is refused with the qualitative-plus-pointer instruction.
  - `read_memory` returns the exact value from the source row.
  - The two pinned tests are rewritten red first.
- **Forget.**
  - A topic present only in a `values` row's verbatim text is forgotten. The index text and class are removed and re-derived from the redacted row, and the topic resurfaces nowhere.
  - Vectors are deleted and read back before the forget settles.
- **Deletion.** Thread erase and account deletion leave no `episode_class` row.
- **App.** The transcript page returns the owner's row verbatim, with no app.v1 change.
- **Hostile.** A row that tells the classifier to mark it `none` is still classed by its content. The classifier output is schema-validated, and a malformed answer leaves the row `pending`.
- **Concurrent.** Two turns on one chain classify and commit without losing or duplicating index rows.
- **Classifier eval (the falsifier).** A synthetic labelled set of at least 150 rows, run three times. The flip bar:
  - at most 2% of `values` rows misclassed;
  - zero readings in stored index text after the backstop;
  - the r1 recall scenario and the compaction recall probes no worse than the verbatim baseline on non-numeric facts.

## 6. Rollback

- `ROW_CLASS.enabled = false` restores today's indexing at persist. The class table stays and is ignored.
- Compaction and semantic recall cannot be on while the switch is off; the conformance test refuses it. Rolling back therefore turns those features off as well, and it reopens G37.
- Index rows already written as `index_text` stay. They are value-free and only less precise. The boot backfill can rebuild the index from the transcript if wanted.
- Claims written in pointer form stay valid.
- No hosted data changes, so no data rollback is needed.