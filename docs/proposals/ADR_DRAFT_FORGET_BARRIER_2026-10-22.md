# ADR drafts: forget barrier, derived deletion, asynchronous purge (22 October 2026)

Drafts for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`, read at `c9219839`. The design they record is [`FORGET_REDESIGN_2026-10-22.md`](FORGET_REDESIGN_2026-10-22.md). The owner approved the redesign and these amendments on 22 Oct 09:35Z (PR #1400). They land in `waldo-brain` through its own review; nothing here changes an accepted ADR by itself.

---

## New ADR 0085 (next free slot after 0084): forget is a barrier at the model's view, derived memory is deleted, and the purge gates nothing

```markdown
---
status: proposed
date: 2026-10-22
canonical_location: waldo-brain/01-Waldo/Architecture Decision Records (ADR)/0085-forget-barrier-derived-deletion-async-purge.md
related: [0005-five-typed-memory-halls, 0006-scribe-inbox-merge-not-direct-writes, 0024-scribe-sanitiser-canonical-spec, 0031-recall-before-act-wiring, 0046-external-truth-invalidates-memory, 0055-gdpr-deletion-runbook-all-stores]
---

# Forget is a barrier at the model's view, derived memory is deleted, and the purge gates nothing

When the owner asks Waldo to forget something, the guarantee is that neither the model nor the owner sees it again and
nothing Waldo derived from it survives. Waldo enforced that by proving every store clean before anything could read, so a
store that would not verify withheld whole web pages, history and recall for as long as the forget stayed pending, and the
purge re-ran inside every owner turn. **Decision: the guarantee moves to one seam. A deterministic barrier at the
ContextComposer removes held topics from everything that enters the model's view, by origin; derived memory is deleted,
not redacted; and the purge is a keyed background job with a receipt per store that nothing waits on.**

## Rules

1. **One matching rule.** `literalTextPattern` in `@waldo/contracts`: a word boundary between Latin, Greek or Cyrillic
   letters; other scripts and digits match as substrings. Plurals and compound words survive a forget (owner ruling,
   22 Oct 2026). Every redactor, verifier and the barrier use it.
2. **One seam.** Every model-bound fragment crosses `applyForgetBarrier(fragments, heldTopics)` once, inside the
   ContextComposer. Code-authored text is exempt. Owner stores and owner records drop the matching item, never the read.
   External text has the literal redacted and the rest kept, with a typed note. A fragment the matcher cannot read
   (the topic spelled by escapes that do not decode) is the only whole fragment replaced by the note.
3. **Derived memory is deleted.** Claims, interpretations (nodes, edges), indexes, cards, snapshots and candidates that
   carry the topic are deleted or regenerated from redacted inputs. The owner's own records (transcript, reminders,
   standing orders, loops) are redacted in place by word. Effect custody rows keep their journal shape.
4. **The purge gates nothing.** The forget commits the custody row, the content-free fingerprint and the SQL deletions in
   one transaction, then a keyed, idempotent job cleans the remaining stores in bounded batches with one retry owner and a
   receipt per store. Nightly, compaction, promotion and migration read through the barrier and never defer. The hold has
   no time limit; the owner can see and retry it.
5. **Honest receipts.** Every receipt names the stores still pending and the stores outside reach: observability traces,
   provider logs, the R2 archive and the Durable Object point-in-time restore window.

## Considered options

- **Keep store-by-store verification as the gate** — rejected: it turns a privacy boundary into a product outage (#1286)
  and made the owner's chat the retry owner (#1395).
- **Provider-native compaction or memory deletion** — rejected: a signed or opaque provider block cannot be redacted after
  the fact.
- **Paraphrase detection by a model** — rejected as the guarantee (judgment cannot be a hard boundary); deletion of derived
  memory removes the paraphrases Waldo wrote, and the eval probes paraphrases.
- **A time limit on held topics** — rejected by the owner: after rule 2 a held topic costs words, not pages.

## Consequences

- One function to review for the model's view; a guard test fails if a fragment reaches the provider without crossing it.
- Forgetting is visible at once and finishes in the background; the console lists held topics with a retry.
- A forgotten short word is redacted in external pages while it is held. Accepted.

## Verification

A forget eval with paraphrase probes (recorded and live), twelve mutations on the barrier, purge crash and replay tests,
and a staging end-to-end across the app, WhatsApp and Telegram.
```

---

## Amendment to ADR-0055 (GDPR deletion runbook)

```markdown
## Amendment — 2026-10-22 (per-owner forget cascade)

A per-owner, per-topic forget is a partial erasure and follows this runbook's store enumeration at topic scope
([[0085-forget-barrier-derived-deletion-async-purge|ADR-0085]]). The owner Durable Object keeps one registry,
`FORGET_STORES`, listing every DO SQLite table and KV prefix that holds owner text, each with its class (owner record,
derived, effect custody, tombstone) and mechanism (redact by word, delete, regenerate, journal token). A store missing
from the registry fails the forget-store test. Latency: the model's view is clean at commit (barrier); SQL derived
memory is deleted in the same transaction; the remaining DO stores are cleaned by the `forget_purge` job, normally
within minutes and reported per store. Residue the forget receipt must name: Langfuse/OTel traces (staging captures
text by owner ruling; production does not), provider request logs (governed by the zero-retention terms), the R2
archive, the iMessage bridge's own copies until it exposes a forget call, and the 30-day Durable Object point-in-time
restore window. A restore inside that window re-runs open forgets from the content-free fingerprints, as the post-PITR
provision above does for account erasure.
```

## Amendment to ADR-0046 (external truth invalidates memory)

```markdown
## Amendment — 2026-10-22 (erasure, the third operation)

Beside **supersede** (a newer truth replaces a belief) and **invalidate** (a system of record contradicts it), memory has
**erase**: the owner asked to forget. Erasure is not a supersession: no successor is written and nothing stays reachable
point-in-time. It deletes the derived understanding (claims, interpretations, indexes, cards, snapshots), redacts the
owner's own records by word, and leaves only a content-free fingerprint tombstone so the same text is not re-admitted.
It runs through the same single writer, the owner's Durable Object, and the same matching rule as every forget path
([[0085-forget-barrier-derived-deletion-async-purge|ADR-0085]]). `dominates()` never resurrects an erased belief: a
system-of-record fact that carries an erased topic is admitted to the view only through the barrier, redacted.
```

## Amendment to ADR-0024 (Scribe sanitiser)

```markdown
## Amendment — 2026-10-22 (the forget barrier beside the sanitiser)

The forget barrier ([[0085-forget-barrier-derived-deletion-async-purge|ADR-0085]]) is a deterministic check at the
`internal_context` and `system_prompt` destinations, listed beside the canary and health checks. It is not a sixth
sanitiser rule inside `sanitise()`: it runs once over the assembled model view at the ContextComposer, after the
sanitiser has admitted each fragment, so a fragment admitted unchanged by the sanitiser can still be redacted or dropped
by the barrier. Order: sanitiser admits per fragment; barrier filters the view; nothing is added after the barrier.
```

## Amendment to ADR-0031 (recall-before-act)

```markdown
## Amendment — 2026-10-22 (recall renders through the forget barrier)

Recall is rendered through the forget barrier ([[0085-forget-barrier-derived-deletion-async-purge|ADR-0085]]). Recall
still fails open on availability (no recall is not a blocker), but never on the barrier: a held claim, node, edge or
episode hit is dropped as an item, and the rest of recall is shown. The `<recall>` block is a fragment of origin
`owner_store` like any other.
```

## Amendment to ADR-0005 (five typed halls)

```markdown
## Amendment — 2026-10-22 (canonical implementation: claims and episodes)

The five-hall `memory_blocks` table was never written by runtime code; the accepted intent is implemented by the
`claims` store (typed `kind`, origin, `source_ref`, `supersedes_id`, `valid_to`, pinned `owner_profile` and
`owner_facts` blocks) and the `episodes` index with `search_episodes`. Those are canonical. Typed retrieval and the
write ACL this ADR asks for are carried by `kind`, `origin` and the single owner-DO writer. `memory_blocks` is dropped
after a read-only hosted check shows it empty (owner approval, 22 Oct 2026).
```

## Amendment to ADR-0006 (Scribe inbox merge)

```markdown
## Amendment — 2026-10-22 (canonical implementation: grounded writes and the nightly pass)

`memory_inbox` was never written by runtime code. The accepted intent (no ungrounded direct writes, an audit trail,
nightly consolidation) is implemented by the `remember` tool's quote grounding and `replaces_id`, the claims store's
origin and provenance, and the nightly consolidation pass that extracts claim operations and curates the pinned blocks.
Those are canonical. `memory_inbox` is dropped after a read-only hosted check shows it empty (owner approval,
22 Oct 2026). Forgotten topics are withheld from the nightly pass by the forget barrier
([[0085-forget-barrier-derived-deletion-async-purge|ADR-0085]]), which never defers the pass.
```
