# ADR drafts: Memory v2, and an ADR-0081 destination for a per-turn health summary (25 October 2026)

These are drafts for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. The design they record is
[`MEMORY_V2_2026-10-25.md`](MEMORY_V2_2026-10-25.md). They widen #1534, the owner profile ADR the owner said yes to on 25 Oct.
They land in `waldo-brain` through its own review after the gate approves. Nothing here changes an accepted ADR by itself.
Numbers are the next free slots at publication. The welcome constellation's draft,
[`ADR_DRAFT_WELCOME_CONSTELLATION_2026-10-25.md`](ADR_DRAFT_WELCOME_CONSTELLATION_2026-10-25.md), becomes this ADR's first
producer, and stays separately shippable.

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
     inside a turn.
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
6. **No health value is persisted in memory.** Notebook, journal, node and claim text hold health patterns in words only. A line
   carrying a numeric health value is dropped (`numericHealthIn`).
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
