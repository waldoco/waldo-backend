# ADR drafts: Memory v2, and an ADR-0081 destination for a per-turn health summary (25 October 2026)

These are drafts for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. The design they record is
[`MEMORY_V2_2026-10-25.md`](MEMORY_V2_2026-10-25.md). They widen #1534, the owner profile ADR the owner said yes to on 25 Oct.
They land in `waldo-brain` through its own review after the gate approves. Nothing here changes an accepted ADR by itself.
Numbers are the next free slots at publication. The welcome constellation is this ADR's first producer, in its own section, and it stays separately shippable.

---

## Memory v2

```markdown
---
status: proposed
date: 2026-10-25
canonical_location: waldo-brain/01-Waldo/Architecture Decision Records (ADR)/00NN-memory-v2-notebook-over-claims.md
related: [0005-five-typed-memory-halls, 0024-scribe-sanitiser-canonical-spec, 0046-external-truth-invalidates-memory, 0049-source-taint, 0055-gdpr-deletion-runbook-all-stores, 0081-health-computation-destinations, 0085-forget-barrier (proposed)]
---

# Memory v2: a readable notebook, derived from one store of sourced facts

The owner wants Waldo to remember like a human personal assistant: learn about the person, write it down, understand it, and keep
it current, in a form the owner can read and edit. Current personal agents keep markdown notebooks for this, such as a USER.md and
dated daily logs. Waldo had markdown core files until 24 Sep 2026 and replaced them with claims. Whole-file edits had no per-line
provenance, and a forget could not prove where a fact had gone.

**Decision: claims remain the only truth for facts about the owner. Two markdown notebooks are derived from them by one writer
each:**
- *About you*, read on every turn and bounded;
- *Journal*, one page per local day, searched and never injected whole.

Every notebook line cites the claims or episodes it rests on. An owner edit lands on the cited claims, and the page recompiles.
A forget deletes the lines that cite what was forgotten.

## Rules

1. **One truth.** Claims hold facts and episodes hold what was said. Notebook pages, journal pages and constellation nodes are
   derived. No derived page is ever edited directly, by the model or the owner.
2. **One writer per derived aggregate.**
   - *About you*: the notebook compiler. It runs debounced after a claim change, nightly, and after the welcome build, never
     inside a turn. Owner-grounded claims newer than the last compile render as a *New since* tail, so nothing the owner said
     waits for the compile.
   - It compiles in two calls that never mix trust. Owner sections are compiled from owner-grounded claims only. *Waldo's read*
     is compiled from every other live claim. Outside text therefore cannot steer a line about the owner that rides every turn.
   - *Journal*: the nightly job.
   - *Constellation*: the nightly promotion and the welcome build, as today.
3. **Every line keeps its source.** Code admits a notebook or journal line only when each ref it cites is live, not held by a
   forget, and belongs to that page's scope. A line without a live ref is dropped. Lines resting on inferred or non-owner
   claims are rendered apart as Waldo's read.
4. **Judgment is the model's.** The model decides what matters, how to group it and how to say it. Code holds provenance, size
   caps, the forget barrier and the health rule (rule 6). It holds nothing that judges topic, tone or importance.
5. **Forget deletes everywhere.** Lines citing a forgotten claim or episode are deleted in the forget's transaction, and the page
   recompiles from what remains. Any future embedding row is deleted with its source row. Both new tables join the forget
   inventory as derived stores.
6. **Device health data is never persisted in memory.** Notebook, journal and node text hold health patterns in words only. A line
   carrying a numeric health value is dropped (`numericHealthIn`). A reading the owner states is a dated claim under the
   22 Oct 2026 ruling. It is never rendered in a notebook or journal page, and the owner can forget it as any claim.
7. **Bounded context.**
   - *About you* is at most 4,000 characters on every turn and replaces the two pinned blocks.
   - Owner pins become "must appear" constraints on the compiler.
   - Recall gains a journal leg (FTS5).
   - Semantic recall is not part of this decision. It needs its own amendment, after the memory evaluation shows keyword recall
     plus aliases falling short.
8. **Procedural memory is not new storage.** Skills stay in `skills.body_markdown` with their review. The owner's preferences
   about how Waldo works are preference claims. Waldo's voice and behaviour instructions stay protected, reviewed assets that
   the model cannot edit.

## Persistence

- New DO tables: `notebook_sections(section, body_md, claim_ids_json, compiled_at, version)`,
  `journal_days(day, body_md, refs_json, written_at, version)`, and the FTS5 table `journal_recall`.
- Removed after an inventory, in a separate step: `memory_blocks`, `memory_inbox` and `patrol_log`. None has a writer.

## Considered options

- **Markdown as the truth, with claims derived from it** (Hermes- or OpenClaw-style files). Rejected. Whole-file edits lose
  per-line provenance and make forget unprovable, which is the failure of 24 Sep.
- **The model writes the notebook and claims in one tool.** Rejected. It makes two writes that must agree and still leaves two
  truths.
- **Pinned blocks only (today).** Rejected as the end state. Nightly-only curation leaves a new owner with a thin profile on
  day 1. The blocks are a list of facts, not an understanding of the person.
- **Embeddings now.** Deferred. DO SQLite supports FTS5, but no vector extension is documented for it. Brute-force vectors in
  BLOB rows or a per-owner Vectorize namespace are both feasible later. Neither is justified before the evaluation shows a gap.

## Consequences

- The app and console gain an *About you* view, a *Journal* view, and claim confirm and forget actions. Spots are renamed notes.
- The pinned-block renderer is retired once *About you* ships. M-8 pins carry over as compiler constraints.
- The welcome constellation's interim `<owner_constellation>` block is retired into *About you*'s *Waldo's read* section.

## First producer: the welcome constellation (separately shippable)

This can be accepted on its own, before the rest of this ADR, so that it can ship in the cohort deploy.

When setup ends, Waldo builds a small constellation from the owner's connected sources and shows it as a welcome gift. The build
writes memory from outside text (mail, calendar) and from health data, at a moment when the owner has not yet said anything
about themselves. **Decision: one idempotent welcome job per owner, in the owner's OwnerDO. It reads each source within a bound.
Each source gets one structured model call. Code admits what the model returns only as inferred, non-owner support claims and
the nodes they back. Web text stays in look-up findings and is never copied.**

#### Rules

1. **One writer, once.** `welcome.start` writes a single `welcome_builds` row and arms one job, inside the caller's
   transaction. Reads and model calls run in the job, outside any SQLite transaction. A second start returns the first row.
   A rerun needs the owner's act.
2. **Bounded reads, as pointers.**
   - Health: 30 days through the signed series read, under live `storage_compute` and `model_processing` consent, and only
     while the owner keeps health in memory. Health runs first; the other stages get its nodes as context.
   - Calendar and Tasks: every connected Google account, named explicitly.
   - Mail: senders, subjects, dates and thread ids over 90 days, never bodies or snippets.
   - Web: only through the existing look-up and its `owner_lookup` consent.
   - Each source has a time and page budget and a recorded state.
3. **Judgment is the model's; hard checks are code's.** The model decides what is worth showing and how to say it. Code holds
   only these checks:
   - schema and lengths;
   - no digit and no numeric health value in any stored string;
   - forget-barrier hits;
   - budgets and the total cap.
4. **Waldo's read until confirmed.**
   - Support claims are `kind: observation` and `source: inferred`. Their origin is `untrusted` for mail and calendar, and
     `agent` for health.
   - `source_ref` holds `welcome:<source>:<pointer>`.
   - They are never recalled as owner facts, never pinnable, and never touch an existing row.
   - Confirming owner-grounds them; correcting replaces them with the owner's words.
5. **Narrow outside-text exception (`welcome_read`).** The job's health, calendar and mail stages make no tool calls and carry
   no effects. Their only writes are rule 4's rows. The web stage's only writing tool is `record_owner_finding` (`honest_origin`).
6. **Chat sees what the gift shows.** Each turn gets a bounded `<owner_constellation>` block. Untrusted-origin nodes are
   labelled as Waldo's read, and look-up findings are counted, not quoted. The block passes the held-topic filter.
7. **Health stays numberless outside the health plane** (ADR-0081).
   - Values reach the model only inside the health stage's own untainted call (`source_taint: null`), under live
     `model_processing` consent.
   - Every welcome call's purpose is metadata-only, so trace capture records no text.
   - No DO table, log, trace or event payload holds a value.
   - When the `HealthPattern` contract (#1472) ships, the stage reads admitted patterns instead of daily values.
8. **Forget is final.** A node forget barriers the label and each support's text, purges the supports and deletes the node. A
   rebuild cannot relearn it. Withdrawing `owner_lookup` erases findings (existing behaviour). Account deletion removes all of
   it with the DO (ADR-0055).

#### Persistence

- One new DO table, `welcome_builds`, holding stage states and counts only, never text.
- Rows in the existing `claims`, `constellation_nodes` and `constellation_edges` tables. No new column.

#### Considered options

- **Source-backed nodes with new node columns** (`sources`, `confirmation`). Rejected: the app projection drops unsupported
  nodes, so every reader and forget path would need a second support model.
- **Web nodes copied from findings.** Rejected: two copies of external text, and a break with the rule that findings stay out of
  prompts until kept.
- **One agentic machine turn over all sources with tools.** Rejected: unbounded reads, a tool-taint fight with the write gate,
  and no per-source progress.
- **Store welcome health nodes as `HealthPattern` rows** (#1472 §5). Rejected for now: that contract is computed evidence in
  Supabase, with false-discovery control, and it is not built. A welcome node is Waldo's digit-free phrasing, not evidence.
  Once patterns exist, the welcome node points at them, and the two do not compete.
- **Wait for the nightly pass.** Rejected: its two-day evidence rule cannot produce a first-day gift, and the owner ruled for a gift.

#### Consequences

- The app gains three additive keys (`welcome`, `sources`, `confirmation`) and three node actions on the controls route.
- The privacy notice gains a welcome-build paragraph before it is published.
- A cohort deploy without the published notice ships the web stage as `skipped`.
```

---

## ADR-0081 destination amendment: a per-turn health summary

```markdown
---
status: proposed
date: 2026-10-25
amends: 0081-health-computation-destinations
---

# A live, unpersisted health summary in each owner turn

The owner wants Waldo to reason with real health numbers on every turn when the owner shares health. Today numbers reach the
model only when it calls `get_health`, and it often does not.

**Decision: add one model destination, `turn_health_summary`.** When a health source has both `storage_compute` and
`model_processing` live, each owner turn's context carries a `<health_today>` block. It holds at most 600 characters of the
latest night's sleep, the current scores with their bands, resting heart rate and HRV against the owner's 14-day baseline, and
freshness. It is read live from the health plane through the signed series and scores read at turn start.

## Rules

1. **Never persisted.** It is not written to DO SQLite, KV, the conversation store, episodes, notebooks, R2, logs or traces.
2. **Untainted context.** It is turn context, not the cached system prompt. It never shares a model request with outside text
   in a way that taints it. It is allowed only at `internal_context` with `source_taint: null`, as the sanitiser already enforces.
3. **Withheld from traces.** Before export, trace text replaces the block with `[health summary withheld]`, whether or not
   text capture is on. A test pins this.
4. **Honest absence.** With no live consent the block is omitted. With readings older than 72 hours it says the data is stale,
   in words, with no stale numbers.
5. **No new computation.** It shows scores and baselines the health plane already computes. ADR-0081's computation rules are
   unchanged.

## Considered options

- **Keep tool-only access (`get_health`).** Rejected by the owner's ask. The model skips the call on turns where the body
  matters.
- **Put numbers in the cached system prompt.** Rejected. Cache entries are provider-side state, and the numbers change daily.
- **Persist a daily numeric snapshot in the DO.** Rejected. It breaks ADR-0081's destination rule.
```
