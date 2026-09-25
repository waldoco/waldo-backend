# Memory ontology deep review (2026-09-26)

Scope set by the owner's #187 comment (2026-09-26): a source-pinned reconciliation across four
layers - (1) accepted product/architecture intent, (2) what is implemented at the beta-mvp SHA,
(3) what an owner can observe/control today, (4) gaps proposed for later. Planning docs and
competitor labels are not treated as implementation evidence; every "built/live" claim below is
pinned to a file:line at the stated SHA. This is a review/planning artifact; it changes no code
and justifies no vector/graph expansion on its own.

Pins:
- Runtime: beta-mvp tag = a796554ef80409c2bbd5d07ce2f1f8e702c5c41f (`git show beta-mvp:<path>`).
- Pending-but-merged-in-review: #196 forget purge (head e72a500, CI green, merge-held).
- Canonical ADRs: waldo-brain snapshot be08c4a, mirrored in docs/foundation/accepted-adrs.json
  (frontmatter only; ADR substance quoted from the owner's #187 comment).

## Layer 1 - accepted intent (the decisions on record)

| Decision | Status | What it says |
|---|---|---|
| ADR-0005 five typed halls (facts / events / discoveries / preferences / advice) | accepted | Memory blocks are typed into five halls, not a flat key-value table. |
| ADR-0046 external truth invalidates memory | accepted | Trust-class priority (system-of-record > user-stated > committed memory > provisional inbox > LLM inference); supersedence executed only through the Scribe seam on a bi-temporal model; point-in-time recall for superseded blocks; "Waldo updated its understanding" surfacing rule. |
| ADR-0078 memory edges activation graph | **proposed** | An activation-graph over memory edges. Explicitly proposed, not accepted; the graph waits until retrieval needs justify it. Not a build mandate. |

## Layer 2 - what is implemented at a796554

Two memory systems exist. They share almost nothing.

### 2a. The claims layer (LIVE on the production chat path)

- `claims` table (packages/runtime/src/memory/claims.ts:14-16): kind, text, source
  (stated/inferred), evidence (free-text string), status, created_at, last_seen_at, seen_count.
  **No validity interval, no supersedence chain, no trust class, no taint marker.**
- Nine claim kinds (claims.ts:3): fact, preference, routine, goal, followup, health, event,
  pattern, observation. This does not match ADR-0005's five halls.
- `memoryPrompt()` (claims.ts:87-101) renders **every active claim, every active constellation
  node, and every edge** into each turn's system prompt; used on the chat path
  (channels/telegram-turn.ts:128) and day planning (telegram-turn.ts:209). There is no
  selective retrieval on this path: memory injection is all-or-nothing.
- Owner corrections are model-mediated (claims.ts:113): the extractor is told to dismiss the old
  claim and add the corrected one. If the model omits the dismiss, both stay active and both
  enter the next prompt. There is no mechanism enforcing one-winner.
- `episodes` on the owner DO is an FTS5 table of raw per-turn chat text (channels/episodes.ts:5-8,
  :26) - every saved turn, owner and Waldo sides. `search_episodes` ranks BM25; the nightly
  consolidation reads `episodes.since(...)` (channels/telegram-owner-do.ts:725).
- Constellation nodes/edges (claims.ts:19-24): domain/label/summary/strength/status and
  from/to/relation/strength/evidence_count, plus supporting_spots id lists on nodes. Promotion
  runs nightly, restricted to observation/pattern claims (PROMOTION_SCHEMA). Relations are
  model-written strings ("worsens", "tends to precede"); nothing in the schema or prompt marks
  them as candidate associations rather than proven causality, and evidence_count is the only
  strength signal.
- Legacy `spots` table (memory/migration.ts:12): frozen pre-claims data, migrated from, kept for
  audit. It is not the claims model and must not be described as such.
- Forget (pre-#196): deleted the claims row only. #196 (e72a500, merge-held) extends purge to
  episodes FTS, memory_backups, legacy spots, core_file_revisions and constellation references,
  with re-admission barriers on the model-facing path and fresh-state verification.

### 2b. The halls layer (BUILT, reachable only from the trusted RunLoop surface)

- recall/gateway.ts implements trust classes and source taint (gateway.ts:53, :398-402 filter
  memory_provisional at recall); recall/correctable.ts implements structured correction with
  provenance.
- Mounted only via hooks/registry.ts:134-135 (read_memory / update_memory tools). The production
  telegram turn never references it (no recall/gateway/read_memory import in
  channels/telegram-turn.ts).
- A second, unrelated table named `episodes` exists in the RunLoop DO schema
  (src/do-schema.ts:169: id/user_id/occurred_at/summary/source/source_ref). It shares a name with
  the owner-DO FTS episodes store (2a) but is a different record. Docs and reviews must say which
  one they mean.

### 2c. Action/due state

- The `loops` table (channels/loops.ts:16-17: id, title, due, status, created_at, closed_at) is
  the canonical open-loop ledger, driven by the open_loop/close_loop tools and rendered in the
  system prompt ("Waldo is on" section, loops.ts:50-57).
- The `followup` claim kind (claims.ts:3) duplicates this: a follow-up observed in conversation
  becomes a claim row (text + evidence, no due, no status machine) while the loops ledger holds
  the actionable record. Nothing reconciles them - followup claims are prompt-only. This is the
  duplication observed in live QA (#187 comment). **The loops table is canonical for action/due
  state; the followup claim kind is at best a cue for opening a loop and should be folded into
  the extraction prompt as such (emit open_loop, not a claim).**

## Layer 3 - what an owner can observe and control today

| Capability | Where | State at a796554 |
|---|---|---|
| See/correct/dismiss/forget claims | console actions (telegram-owner-do.ts act handler) | Live. Correct = console edits; chat-side correction depends on the model emitting dismiss+add (2a). |
| "Why do you think that" | claim evidence strings | Free text, not references; cannot deep-link to the episode or event it came from. |
| Forget | console forget + chat-side forget ops | Claim-row only until #196 merges/deploys; #196 purges six derived stores with barriers. Raw hot conversation history (channels/conversation-store.ts:13, restored on wake) is NOT in the purge set - see section 5. |
| Constellation visibility | console nodes/edges views | Nodes/edges render with strength; relations carry no uncertainty marker to the owner. |
| Search own history | search_episodes tool | Live, BM25 over the FTS episodes store. |

## Layer 4 - the gaps, stated as interim vs intent (proposals, not builds)

1. **Claims are an interim implementation of ADR-0005/0046, and the docs should say so.**
   Nine untyped-ish kinds with no validity interval, no supersedence and no trust classes is not
   the five-hall bi-temporal model. Per the owner: describe bi-temporal and selective retrieval
   as NOT shipped, and the claims layer as the interim standing in for it.
2. **Two memory systems, and the governed one is off the live path.** Corrections/trust/taint
   made through the halls path never reach the claims the chat reads; the chat path has no trust
   class, so external-origin content can become a claim with source 'inferred' and no taint.
   Unifying the read path is the natural first slice - but per #187 it must earn its place
   through the golden scenario set below, not through architecture appeal.
3. **Constellation relations need uncertainty language.** Today "worsens"/"tends to precede"
   render as fact in prompts and console. ADR-0078 is proposed only; promotion thresholds,
   provenance shown to owners, and demotion/correction behavior are undefined. Until the
   retrieval/value tests below show claims+episodes insufficient, no graph expansion (no new
   edge types, no activation spreading, no schema change) is justified.
4. **followup vs loops duplication** (2c): pick loops as canonical; teach extraction to open
   loops instead of writing followup claims; migrate existing followup claims or leave them to
   age out with a documented cutoff.
5. **Evidence is free text.** Claims cite a string, not episode/event ids; "why" answers can't be
   verified by the owner. Structured refs (episode:<id>) are the smallest honest upgrade.
6. **Doc reconciliation** (section 6): the three planning docs disagree with the build and with
   each other about what is live.

## 5. Raw transcript retention vs derived-memory forgetting

These are separate questions and the build treats them differently:

- **Derived stores** (claims, constellation, episodes FTS, memory_backups, legacy spots,
  core_file_revisions): post-#196, forget purges all six and barriers block re-admission into
  derived memory. Nightly extraction reads the episodes FTS store (telegram-owner-do.ts:725), so
  purged episode text cannot feed the next nightly pass.
- **Raw conversation state** (channels/conversation-store.ts): the hot chat history, restored on
  wake (conversation-store.ts:33-35), is what the model actually sees turn-to-turn. It is NOT in
  the #196 purge set. A forgotten fact that lives in still-hot conversation history can therefore
  still shape replies until that history ages out, and anything the model re-derives from it is
  caught only by the forget barrier at claim-admission time.
- **State explicitly for owners:** forgetting guarantees removal from long-term stores and from
  future extraction input; it does not retroactively edit the rolling conversation window. If
  the intent is stronger (forgotten content never shapes any reply), the conversation window
  needs a purge step too - proposed, not built.

## 6. Doc reconciliation (source of truth per claim)

| Claim made in docs | Doc | Verdict at a796554 |
|---|---|---|
| "Five halls LIVE ... trust class + taint, scribe-staged writes, trust-filtered recall" | SPOTS_CONSTELLATIONS_AND_DERIVATIONS.md:96 | Misleading. Halls exist but are reachable only via the RunLoop tool surface (hooks/registry.ts:134); the production chat path uses claims (telegram-turn.ts:128). Correct wording: "halls built; live only on the trusted RunLoop surface." |
| "FTS LIVE ... search_episodes" | SPOTS_CONSTELLATIONS_AND_DERIVATIONS.md:97 | Accurate for the owner-DO episodes store (channels/episodes.ts:26). |
| "episodes, spots, constellation, correctable memory, nightly consolidation (live)" | CAPABILITY_MATRIX_2026-09-25.md:19 | Half right. "spots" is a frozen legacy table (migration.ts:12), not the live model; "correctable memory" is RunLoop-surface only. Should read "claims, constellation, nightly consolidation live on chat; halls/correctable on RunLoop surface." |
| "Hot conversation state ... proven live" / "four core files built" | MEMORY_ROADMAP.md:17-18 | Consistent with code (conversation-store.ts; memory/core-files.ts); unaffected by this review. |
| ADR-0078 graph as build mandate | (usage in various planning notes) | Rejected: ADR-0078 is proposed (accepted-adrs.json @ be08c4a). No graph expansion is justified until the golden scenarios below fail on the simple path. |

Durable source of truth going forward: this review pins runtime facts to a796554 and ADR facts to
waldo-brain be08c4a; SPOTS_CONSTELLATIONS_AND_DERIVATIONS.md and CAPABILITY_MATRIX_2026-09-25.md
should carry a pointer here instead of restating live-status claims.

## 7. Golden scenario set (the value test before any expansion)

Run against the live system as scripted owner turns; each scenario names the pass condition and
the metric it feeds. Metrics: correct retrieval, stale/false insertion, correction/forget
completeness, task duplication - never graph-row counts.

1. **Conditional preference, unflattened.** "I take coffee black on weekdays but like a cappuccino
   on weekends." Pass: later recall preserves the condition. Metric: retrieval correctness.
   Known risk at a796554: claims store one flat sentence; the extractor may flatten.
2. **Owner correction beats stale memory.** Owner says "I moved to Pune", later "actually I'm back
   in Mumbai". Pass: the next prompt carries only Mumbai. Metric: correction completeness.
   Known risk (2a): correction depends on the model emitting dismiss+add; no enforcement.
3. **Shared/forwarded content is not owner fact.** Owner forwards an article about keto. Pass: no
   claim about the owner's diet; Waldo's own replies never become evidence either
   (CLAIM_RULES, claims.ts:109 says this - test that it holds). Metric: false insertion.
4. **System-of-record beats memory.** Calendar says the flight moved; memory says 7 PM. Pass: the
   answer honors the live record and says memory was stale (ADR-0046 surfacing rule). Metric:
   conflict honesty. Known gap: no trust classes on the live path, so this is prompt etiquette,
   not mechanism.
5. **Relevant retrieval vs no-match.** Ask about something never discussed. Pass: Waldo says it
   doesn't know rather than confabulating from near-miss claims. Metric: false retrieval.
6. **Forgotten content cannot re-enter.** Forget "the Berlin trip", then discuss adjacent topics.
   Pass: no claim/node/episode text about Berlin re-enters any prompt, nightly extraction holds
   it via barriers, search_episodes returns nothing post-purge. Metric: forget completeness
   across all stores including the hot conversation window (section 5).
7. **Cross-owner isolation.** Two owner DOs; a fact from owner A never appears in owner B's
   prompts, search or console. Metric: isolation breaches (must be zero).
8. **No duplicate owner-visible work.** A "remind me to call the dentist" turn produces exactly
   one actionable record. Pass: one loops row, zero followup claims. Metric: task duplication
   (2c/4).

If scenarios 1-6 pass on the claims+episodes path (with the small honesty fixes above), the case
for graph/vector expansion is weak and ADR-0078 stays parked. If they fail in ways claims cannot
fix, the failures themselves are the evidence base for the next memory decision.
