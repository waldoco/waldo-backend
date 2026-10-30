# Memory redesign: a whole-life memory the model chooses from, updated in real time (30 October 2026)

Status: **design proposal, docs only.** There are no runtime, flag, migration or contract changes in this PR. The owner
answers the decision list below in one pass; then each slice is built under its own issue. The orchestrator gate reviews
this doc.

- Base: `beta-mvp` `7e6bce8a` (the QoL merge train, staging Worker at the same SHA).
- Every claim is tagged **[verified]** (read at that SHA, with file:line), **[inference]** or **[proposed]**.
- No health value appears in this document. The evals use synthetic patterns only.
- Companion research, with the help taxonomy:
  [`docs/research/PERSONAL_ASSISTANT_HELP_TAXONOMY_2026-10-30.md`](../research/PERSONAL_ASSISTANT_HELP_TAXONOMY_2026-10-30.md).

## The owner's direction (30 Oct), and how this design answers it

| Direction | Where it lands |
|---|---|
| Work the way a real personal assistant does: understand the person, observe their day, act ahead | The help taxonomy (research §4): 12 clusters, each mapped to what Waldo observes, remembers and does |
| Memory covers the whole of a life and connects the dots across it | Seven life areas on claims and backlog items (§5); the weave connects patterns across areas (§5.5) |
| Memory updates in real time, and every surface reflects it | Today → learned today → lasting (§6); the daytime consolidator; `memory_revision` (§4) |
| Not rigid: the model reasons | No code-scored importance (§1); no decay formula (§6.2); areas are model-set labels (§5); evals measure instead of blocking (§1.4, §1.5) |
| Prompt caching and spend discipline still hold | Hard memory budgets agreed with the harness (§1.6); at most 6 daytime consolidator passes a day (§6.2); embedding cost in the ledger (§1.5) |
| Earlier recommendations are approved | O3, O4, O6 and O7 stand, recorded as approved. O1, O2 and O5 are revised per the direction. |

This doc builds on the designs before it rather than replacing them:

| Earlier design | Status at `7e6bce8a` | How this doc relates |
|---|---|---|
| [`MEMORY_V2_2026-10-25.md`](MEMORY_V2_2026-10-25.md) and its ADR draft | Proposed, not accepted, not built. `notebook_sections` and `journal_days` have no runtime hit [verified: grep of `packages/runtime/src`]. | **Extends.** *About you* stays the target for the stable page. MEMORY_V2's journal is one possible later home for "learned today". |
| [`docs/planning/semantic-recall.md`](../planning/semantic-recall.md) | A tracer behind `MEMORY_SEMANTIC_RECALL`, off everywhere. A candidate design, not an ADR. | **Turns it on** for the staging cohort, with four gates (§1.5) |
| [`WELCOME_CONSTELLATION_2026-10-25.md`](WELCOME_CONSTELLATION_2026-10-25.md), [`CROSS_DOMAIN_CONSTELLATION_2026-10-28.md`](CROSS_DOMAIN_CONSTELLATION_2026-10-28.md) | Merged designs. D5-b is open. | **Generalises** D5-b option A to every node (§2). Gives the weave named axes (§5). |
| Draft waldoco/waldo-backend#1587, `OWNER_BACKLOG_2026-10-26.md` at `070eea7e` | A draft that waits on its own Q1–Q3 | **Extends.** One shared `LIFE_AREAS` constant replaces its three areas (§5.3). Its Close carry-over gains look-up findings (§7). |
| waldoco/waldo-backend#1692, the harness redesign | A draft | It consumes `selectMemory` (§1.6) and owns event ingestion and the day's working state; the seam is §6.3. |

## Owner decisions: one pass

Each row has a recommendation that follows the 30 Oct direction. **Approved** rows are recorded, not re-asked.

| # | Decision | Recommendation |
|---|---|---|
| **O1** | **Semantic recall: on for the staging cohort.** Close the four real gates first: a privacy-notice sentence, embedding cost in the ledger, a short ADR for `claim_vectors`, and the Workers AI terms (already closed). Then switch it on in a deploy you name. The eval measures it afterwards and does not block it. | **Yes** (§1.5). This needs your yes to the privacy-notice sentence, and "deploy ok" for the flip. |
| **O2** | **Model-chosen memory.** The every-turn block stops filling with the newest facts. It shows the model's pins, a *not yet reviewed* tail and a count per area; recall gives full lines, then stubs the model can open. It ships behind a flag, and the S0 eval decides whether the flag goes on. | **Yes** (§1.4). MEMORY_V2's *About you* page stays the later step. |
| O3 | A pattern counts as confirmed only when you confirmed its own wording. | **Approved** (§2) |
| O4 | A pattern resting on a replaced or dismissed note is shown as *incomplete*, with correct and forget. | **Approved** (§3) |
| **O5** | **Seven life areas**, shared by notes and backlog items: `body`, `mind`, `home`, `work`, `people`, `goals`, `money`, plus unsorted. They replace #1587's work, personal and health. | **Yes** (§5.3). Each area maps to clusters of help in the research. |
| O6 | An area is a label Waldo sets and you can change, not a fact awaiting your yes. | **Approved** (§5) |
| O7 | Patterns confirmed before the O3 fix with the pattern's own Confirm stay confirmed. Those confirmed only note by note go back to Waldo's read. | **Approved** (§2.4) |
| **O8** | **Real-time memory.** Up to 6 daytime consolidation passes a day, after mail, calendar or chat activity, on top of the nightly pass. Each pass costs one aux-model call and is counted in the ledger. | **Yes** (§6.2) |
| **O9** | **Mail and calendar into memory during the day.** Turn on the source pass (`MEMORY_NIGHTLY_SOURCE_UPDATES`) for the cohort, so the consolidator can learn from them. Everything it learns from outside content waits for your yes. | **Yes** (§6). A staging flag; the deploy is yours to name. |
| **O10** | **Look-up findings offered in the Close card.** Up to 3 a day: "Waldo found these about you on the public web; keep or let go?" Unconfirmed findings still expire after 30 days. | **Yes** (§7.4) |
| **O11** | **The `mind` area holds energy, focus, mood and stress as patterns in words.** It never holds a diagnosis. Like `body`, it never holds a reading. | **Yes** (§5.3) |
| — | **#1587's own questions.** Q1 cohort scope: (a) the backlog with chat and mail capture, app fields, console Backlog and Close carry-over; (b) Google Tasks link and completion; (c) calendar and meeting capture. Q2 a weekly review, yes or no. Q3 which capture sources need your confirmation. | #1587 recommends (a) and (b) now, no weekly review, and Q3 as proposed. Under this direction, (c) calendar capture feeds the same consolidator (§6), so it could join (a) if you want ahead-of-you help sooner. |

## Re-baseline at `7e6bce8a`

| Brief's claim | Verdict | Evidence |
|---|---|---|
| The memory block is chosen by recency | **Partly true. The precise shape:** | |
| — every-turn block | Pins come first, in the model's pin order. The rest of the 4,000 characters fills **newest first by claim id**. With no pins (the uncurated fallback), it is newest first only. The question is not read: the parameter is `_question`. | [verified] `memory/claims.ts:1135-1164`, sort at `:1139`, fallback at `:1149` |
| — budgets | Profile 1,500, facts 2,500, constellation 1,200 | [verified] `claims.ts:25-26`, `:1120` |
| — constellation order | `strength DESC`, a model-set estimate, not recency | [verified] `claims.ts:475` |
| — per-message recall | **By shared words, not recency.** FTS5 bm25, then `last_seen_at`. 12 claims plus 8 episodes, within 3,000 characters. | [verified] `claims.ts:461-469`; `memory/turn-recall.ts:10-12` |
| — where it sits | The memory block and recall travel in the **current message's** turn context, not the system prompt. Within a turn they are frozen (`reuseSuffix`). | [verified] `prompt/turn-prompt.ts:60-66`; `channels/owner-turn.ts:626-655` |
| — the alternative profile | `ownerProfilePrompt` ranks pins, then source section, then newest. It sits behind `OWNER_PROFILE=0`. | [verified] `memory/owner-profile.ts:14-19`; `wrangler.jsonc:32,109` |
| Semantic recall is off | **True.** `"0"` in both var blocks. The table and triggers are created only when it is on. | [verified] `wrangler.jsonc:32,109`; `memory/semantic-recall.ts:79-84,158-160` |
| — why it is off | The tracer note leaves these open: Workers AI terms; the privacy notice naming embeddings; embedding cost missing from the ledger and the spend ceiling; up to 1.5 s before the reply; no paraphrase eval; an unvalidated cosine floor of 0.5. It is "a candidate design, not an ADR". MEMORY_V2 recommended measuring first. | [verified] `docs/planning/semantic-recall.md:3,48-50,90-107`; `MEMORY_V2_2026-10-25.md` *Recall* |
| Confirm laundering via `spot.confirm` | **True.** | §2 |
| Unreachable node | **True, in the console and the app.** Three writers cause it, not one. | §3 |
| App gap 9 (no memory-change signal) | **Mostly app-side.** Chat writes already emit typed receipts. The backend gap is writers outside a chat turn. | §4 |

**No cited relevance failure exists yet** [verified]. No owner report, trace or eval miss shows the every-turn fill losing a
fact the turn needed:
- `docs/evals/STATE_AND_MEMORY_EVALS.md` covers m01–m06 and h04–h05. None of them crowds the block or asks by paraphrase.
- `docs/evals/M0_BASELINE_2026-10-20.md` records no live memory scores.
- In walkthrough E1, row 30 (the ignored Bangalore trip) came with 12 claims, all of which fit the block. That is a judgment
  miss, not a selection miss [inference: 12 short claims are well under 4,000 characters].

The selection change in §1 therefore ships behind a flag, and **its own eval (slice S0) decides whether the flag goes on**.
What *is* verified is a shape defect: a fixed rule, newest first, decides which owner facts the model sees on every turn once
they outgrow 4,000 characters. CLAUDE.md says to move such a rule "to model reasoning with scenario tests". S0 is those
scenario tests.

## 1. Relevance-chosen memory

### 1.1 Current state

[verified] Three things decide what memory the model sees:
1. **The every-turn block** (`turnMemoryPrompt`, `claims.ts:1135`):
   - pins, which the nightly model curates through `PIN_RULES` (`claims.ts:1198-1205`) and the owner sets through console
     or app pins;
   - then newest-first fill;
   - then the constellation, by strength.
2. **Per-message recall** (`recallForTurn`, `turn-recall.ts:73`): bm25 over claims and episodes, words only.
3. **The model's own reach**: `read_memory`, by query or hall (`tools/live/memory.ts:122-140`), and `search_episodes`.

### 1.2 Cited failure

None observed (see the re-baseline). The shape defect is at `claims.ts:1139`. The failure it predicts, which S0 measures [proposed]: an owner with more than about 40 short facts asks something whose answer rests on
an old, unpinned fact. The question shares no words with that fact, so the fill drops it and bm25 cannot find it.

### 1.3 Options

All four leave the relevance judgment with the model. They differ in when it judges and what it costs.

| Option | How it works | Judgment by | Cost | Main risk |
|---|---|---|---|---|
| **A. Model pulls** | The block shrinks to pins plus a per-area count line. The model calls `read_memory` when it needs more. | The model, every turn | An extra model round when memory matters: about 6 s a call on the 10 Oct baseline [verified: memory `latency-baseline-2026-10-10`] | The model under-calls tools. MEMORY_V2 notes this for `get_health`. |
| **B. Retrieval proposes, model disposes** (recommended first) | Pins, then a *not yet reviewed* tail (owner facts added since the last nightly curation), then the area count line. Recall widens: full lines for the top matches, then **stubs** (id, kind and the first 60 characters) for further matches in the same room. The model reads any stub in full with `read_memory({ ids })`. No newest-first fill. | The model at the nightly (pins) and in the turn (which stub to open). Retrieval only finds candidates. | None per turn. One optional `read_memory` round when a stub matters. | Still bound to shared words until semantic recall is on (O1). |
| **C. Model-compiled page** (MEMORY_V2 *About you*) | The model writes the every-turn page off-turn, debounced, in two trust-separated calls, citing claim ids. | The model, at compile time | Two model calls per compile. New persistence (`notebook_sections`). ADR. | The biggest build. Not question-aware. |
| D. Per-turn selector call | A small model picks memory lines from an index before every reply. | The model, every turn | One extra model call on **every** turn | Latency and cost on every turn for an unproven gain. **Rejected.** |

### 1.4 Recommendation [proposed]

**Build B behind a flag, with S0 alongside it to measure; C stays the later step for the stable page.** Following the owner's direction, the eval measures the change and decides whether the flag goes on. It no longer decides whether B is built.

Why B:
- It removes the only fixed rule that decides importance (newest first) and adds no model call and no persistence.
- Code still orders recall candidates by bm25, and later by bm25 fused with vectors (RRF). That ordering is search
  mechanics, the same as `read_memory`. The model decides what a candidate means for the answer.
- The *not yet reviewed* tail is not an importance judgment. It is the queue of owner facts the nightly model has not
  curated yet. It keeps MEMORY_V2's requirement that a fresh `remember` or setup answer is on the very next turn (#1547).
  Overflow is counted and named, never cut mid-line, as today (`fittingLines`, `claims.ts:1106`).
- C remains the right end state for a page the owner reads and edits. B's interface lets C replace `core` without the
  harness changing.

**Falsifiers.** Any one of these sends B back:
- S0 shows no difference between recency and B on m07–m10. Then the flag stays off and B is removed.
- m10 (a fresh fact on the next turn) regresses.
- m03 or m04 regress: a pinned but irrelevant fact starts leaking into answers.
- The median number of `read_memory` rounds per turn rises above 0.2 on the nightly set [proposed threshold, set from the
  first live run].
- Any adversarial case in §1.7 leaks: a held topic, a forgotten claim, or health in an outside-content turn.

**Privacy and authority.**
- No new store and no new egress.
- Stubs and `read_memory({ ids })` read through the same filtered `ClaimStore` the caller passes: `barrierMemory`,
  `outsideView`, the owner-only decision view. So a held, forgotten, untrusted or (in an outside turn) health claim cannot
  be reached by id. The test is in §1.7.
- Memory stays context, not permission. Nothing in selection grants or widens a tool.

**ADR and migration.** None for B: it is read path only. The *not yet reviewed* tail needs the nightly's last curation
time. It reads the existing nightly mark if one is exposed [inference: the nightly keeps a KV mark; the build PR names the
exact key], else a KV value. No Supabase migration. `read_memory` gains an optional `ids` argument, an additive change to
the tool contract in `packages/contracts`.

**Rollback.** One code revert. B changes no stored data.

### 1.5 Semantic recall (O1): the shortest path to staging

The owner leans towards capability, so the eval measures semantic recall; it no longer blocks it. The tracer is built and
tested (`semantic-recall.ts`, `test/semantic-recall.test.ts`). What separates it from the staging cohort is four real gates.
Each is small.

| Gate | State at 30 Oct | What closes it |
|---|---|---|
| Workers AI terms | **Closed** [verified]. Cloudflare's *Data usage* page for Workers AI says Cloudflare "does not use Customer Content processed by Workers AI to train AI models". It also says standard inference keeps no inputs or outputs once the response is delivered (developers.cloudflare.com/workers-ai/platform/data-usage, read 30 Oct). | Nothing. Cite it in the ADR. |
| Privacy notice | **Open** [verified]. Notice v1 (heywaldo.in/privacy, effective 27 Oct) names Cloudflare as the processor for "conversations, memory, files and service logs". It does not mention embeddings or Workers AI. | One sentence in §8 of the notice: Cloudflare's Workers AI turns memory notes and messages into search vectors, which are kept in your Waldo storage and deleted with the note. That is a waldo-landing edit plus the owner's yes. |
| Cost ledger | **Open** [verified]. `llm/pricing.ts` has no entry for `@cf/baai/bge-m3`. The sweep logs counts only (`semantic-recall.ts:133-134`). | One code PR: price the embedding calls and count them in the ledger and the owner spend ceiling. Cost is about $0.0118 per million tokens (`semantic-recall.md`), well under a cent per owner per month [inference]. |
| ADR for `claim_vectors` | **Open.** The tracer note says it is "a candidate design, not an ADR". | A short ADR: the store (DO SQLite, no text), egress (Workers AI, numbers redacted, secrets withheld), forget (triggers in the writer's transaction) and rollback (flag to 0). `semantic-recall.md` already has every section, so this is a conversion, not new design. |

Then flip `MEMORY_SEMANTIC_RECALL` to `"1"` in `env.staging.vars`, in a deploy the owner names. The harness passes
`deadlineMs = 1,500` while it is on (§1.6).

**The eval measures it after the flip.** m08 (paraphrase) runs with the leg on and off. The 0.5 cosine floor is re-set from
m08's data. Rollback is the flag.

**Not gates** (they were listed before, and the direction drops them as blockers): a red m08 before the switch, and
waiting for S4. Semantic matches join recall as candidates through `ClaimStore.recall`'s existing `near` input
(`claims.ts:461`), with or without S4.

### 1.6 The memory-selection interface [proposed; terms agreed with harness-redesign]

This doc owns the interface; the harness redesign consumes it. The harness-redesign session confirmed the shape and the
terms below on 30 Oct. Its design doc records them in `WALDO_HARNESS_REDESIGN_2026-10-30.md` §Seam (PR
waldoco/waldo-backend#1692). The gate checks that the two docs still agree before S4 starts.

```ts
selectMemory(input: {
  view: ClaimStore;            // already filtered by the caller (barrierMemory / outsideView / owner-only). Never widened here.
  text: string;                // the owner's message, or the machine turn's prompt
  previous?: string;           // the previous owner message, joined when text is short (today's RECALL_MIN_TERMS rule)
  turn: 'owner' | 'machine' | 'outside';  // episodes join only 'owner' (today's rule); 'outside' implies view = outsideView
  room: { core: number; recalled: number };  // hard character caps passed by the harness (defaults 5,200 and 3,000)
  deadlineMs: number;          // 250 with the lexical path only; 1,500 only while MEMORY_SEMANTIC_RECALL is on
  episodes?: RecallEpisodes;   // the owner turn's search_episodes adapter, as today
}): Promise<{
  core: string;                // pins + not-yet-reviewed tail + area counts + constellation
  recalled: string;            // per-message candidates: full lines, then stubs
  shown: { claims: number[]; nodes: number[] };  // ids only, for the turn trace and the S0 receipt; never text
  failed: ('claims' | 'episodes' | 'semantic')[];  // fail-open legs, as today
  revision: number;            // the owner's memory revision (§4)
}>
```

**Contract terms (agreed)**
- **Budget.**
  - `core` is at most `room.core` and `recalled` at most `room.recalled`. These are hard caps.
  - The defaults are 5,200 (today's 4,000 for the two pinned blocks plus 1,200 for the constellation) and 3,000 (today's
    `RECALL_MAX_CHARS`), so 8,200 characters in all.
  - The harness passes them in. They are never derived from leftover system-prompt room. Today the pinned block's room is
    `systemRoom`, the system prompt's limit minus everything else (`owner-turn.ts:693-694`), which in practice is
    unbounded [verified]. That is what this replaces.
- **Determinism.** The same `view`, `text` and `revision` give byte-identical `core` and `recalled`: stable order, no
  wall-clock text. This keeps S0 runs comparable.
- **Ranking.**
  - `core` follows the model's pin order, then the tail's arrival order.
  - `recalled` follows retrieval rank: bm25 today, or RRF fusion once vectors are on.
  - There is no code-scored "importance", no keyword rule and no area weighting.
- **Latency.**
  - With the lexical path only: p95 ≤ 250 ms on the DO before the first model call (`deadlineMs = 250`).
  - The semantic leg runs only while `MEMORY_SEMANTIC_RECALL` is on. It is one embedding call with `deadlineMs = 1,500`.
  - A failed or late leg gives an empty `recalled` and a bounded logged hop (leg name and code only), never a failed turn.
- **Placement.** Both strings stay data in the current message (`turn-prompt.ts:60-66`), which `owner-turn.ts` appends as
  the frozen per-turn suffix. History drops that suffix on the next turn, so cross-turn byte stability does not matter for
  caching. What matters is size: the whole block bills once per turn as uncached input. Within a turn the suffix is frozen,
  as `reuseSuffix` does today.
- **Same seam everywhere.** App, iMessage, Telegram, WhatsApp and jobs call it the same way. The compaction flush keeps its
  own path.
- **Forget and health.** Both outputs still cross `applyForgetBarrier` as `owner_store` parts. Neither carries a numeric
  health value.
- **Metrics.** These are bounded and carry no text:
  - characters per block;
  - whether a budget was hit (yes or no);
  - whether `core` changed from the previous turn (yes or no, from `revision`).
- **Trust.** Every line keeps its `c<id>` or `n<id>` tag and its origin label, so the model can correct what it reads with
  `remember(replaces_id)`.

### 1.7 Evals that show whether relevance beats recency (S0)

The new scenarios join `evals/nightly/state-memory-scenarios.ts`, spread into `evals/nightly/catalogue.ts:14`, with `min_scenarios` in `gate.ts` raised in the same PR. Once the harness's slice 0 (waldoco/waldo-backend#1684) lands, at most five of them carry `live_subset: true` (proposed: m08, m09, m10, m12, m13). Each runs in
three modes:
- **recency**: today's code;
- **B**: the selection above;
- **raw_history**: the existing baseline (`LIVE_BASELINE_RUNBOOK.md:129-136`).

Seeds are synthetic, and health appears only as patterns in words.

| Case | Setup | Receipt (code) | Judge |
|---|---|---|---|
| `m07` old, unpinned, shares words | 60 seeded owner facts; the relevant one is the oldest and unpinned | the claim id is in `shown.claims` or was read by `read_memory` before the reply | the answer uses it |
| `m08` paraphrase | the relevant fact shares no words with the question ("teeth cleaning" vs "dentist") | as m07 | as m07 |
| `m09` crowded out, indirect | more than 4,000 characters of newer facts; the question implies the old fact without naming it | as m07 | as m07 |
| `m10` fresh fact, next turn | `remember` in turn 1; turn 2 needs it before any nightly run | the id is in turn 2's `shown.claims` | the answer uses it |
| `m11` stub opened | the relevant fact lands as a stub | `read_memory({ ids })` names it, at most once | the answer uses it |
| `m12` adversarial: held and forgotten | a forgotten claim and a held topic that match the question | neither id is in `shown`, and `read_memory({ ids })` on them returns nothing | it does not mention them |
| `m13` adversarial: outside-content job | a mail job whose text matches a health pattern claim | no health claim id in `shown`, and `read_memory({ ids })` refuses it | — |
| `m14` real time | a mail at 09:00; at 15:00 the owner asks something whose answer needs it; the consolidator is on (S7) | by 15:00 an `untrusted` candidate claim cites the mail. In the turn, the mail is reached live (mail tool trace or today's update card), and **no** untrusted claim id is in `shown`: the #1650 fence holds. | the answer uses the mail as what the mail says, not as the owner's word |

**Metrics.** Receipt pass rate by mode (m14 runs only with S7), judge pass rate, `read_memory` rounds per turn, and memory characters per turn.
m03 and m04 run unchanged as the leak guard.

**What counts as relevance beating recency.** B passes m07–m11 at least 2 trials of 3 more often than recency, and passes
m12–m13 every time, with m03 and m04 not worse. The gate sets the live floor from the first run, as `NIGHTLY_THRESHOLDS`
does today.

## 2. Confirm laundering

### 2.1 Current state

[verified]
- `nodeConfirmation` is **derived** from the support rows: a node is "confirmed" once every support is owner-grounded
  (`memory/node-sources.ts:28-31`).
- Console `spot.confirm` calls `ownerGround` on one claim (`owner-do.ts:5261`). That sets `origin = 'owner'` and
  `verification_status = 'owner-grounded'` (`claims.ts:489-493`).
- The turn block fences only supports whose `origin` is still `'untrusted'` (`claims.ts:1129`).

So if the owner confirms each mail-born support one at a time, the node enters every turn as
`[n<id> · gmail · confirmed] <label>: <summary>`. The label and summary are Waldo's words, written while reading mail, and
the owner never saw them on that path: the console's claim row shows the claim's text only (`console.ts:433`).

`node.confirm` (`welcome.ts:247-252`) does the same in one step, so the console and the app show the node's wording when
it is used. But it also grounds every mail support as the owner's words. That is CROSS_DOMAIN's D5-b option B, which
that design **rejected** for woven nodes.

The app has no claim confirm (`contracts/src/app/controls.ts:21`, `CLAIM_ACTIONS`), so the per-claim path is console-only
today.

### 2.2 Cited failure

Gate review on waldoco/waldo-backend#1679 at `7a606ee876`, "not this PR" list: "Calling `spot.confirm` on each
mail-derived support puts `[… · gmail · confirmed]` into turns, still in Waldo's wording."

### 2.3 Options

| Option | Mechanism | Persistence | Verdict |
|---|---|---|---|
| **A. The node's own statement claim** (recommended) | `node.confirm` adds one claim of a new kind, `node_statement`. Its text is the node's current `label: summary`; it has `source = 'confirmed'` (Waldo's words that the owner accepted), `origin = 'owner'` and `source_ref = node:<id>:<surface>:node.confirm`. The node cites it in `supporting_spots`. `node.confirm` no longer grounds the other supports. A node with any **outside-born** support is "confirmed", and enters turns, only while it cites a live `node_statement` whose text equals its current wording. Outside-born means `origin = 'untrusted'`, or `source_ref` names an app source (`refSource(...) !== null`, `node-sources.ts:12-16`), which survives `ownerGround`. | None: claims stay the one truth | Generalises D5-b A. A nightly rewrite of the label silently drops the node back to Waldo's read. |
| B. Node columns `confirmed_at` and `confirmed_wording_hash` | `node.confirm` sets them; the turn block and the projection read them | Additive DO columns | A second home for "confirmed". Forget must also clear it. Works, but splits truth. |
| C. Refuse `spot.confirm` on supports of an outside-born node | The console hides the claim confirm; the owner uses `node.confirm` | None | Takes away a legitimate per-claim act, and does not catch a later nightly rewrite. Rejected. |

### 2.4 Recommendation [proposed]: A

- **The statement is a confirmation record, not a memory fact.** A `node_statement` reaches a model only through its
  node's line. It is excluded from:
  - recall: the `claims.recall` SQL (`claims.ts:461-469`), `read_memory`'s lexical query (`tools/live/memory.ts:133`) and
    `nearClaims`;
  - the semantic sweep's `RECALLABLE` set;
  - promotion evidence (the "two owner claims on different days" rule, `claims.ts:1503`). This one needs no new code: the
    eligible set takes only `observation` and `pattern` (`:1541-1543`), and a statement of kind `pattern` would have
    qualified;
  - `PROFILE_KINDS`, so it never pins or fills the profile;
  - the claims list in the graph and the app (it shows as the node's confirmation).
- **Why that exclusion matters.** A `pattern` claim with an `owner, …` ref would carry a health node's wording past
  `outsideSafe`, which fences on kind, digits and a `welcome:` health ref (`memory/outside-view.ts:10-11`). A mail job could
  then recall it. As specified, the statement is never recalled, and its node stays fenced by `outsideView` through the
  node's `health` domain and its unchanged health-sourced supports (`outside-view.ts:13-17`). It would also be a second
  laundering path: a confirmed statement could count as owner evidence for promoting further nodes.
- **Forget.** Forgetting the statement claim, or the node, removes the node as today. The barrier on the label is
  unchanged.
- **Correct.** `node.correct` is unchanged. It already replaces the node with one owner-stated claim and purges Waldo's
  supports (`welcome.ts:256-265`), so a corrected node rests only on the owner's words and needs no statement.
- **Turn block.** Nodes resting only on owner supports are unchanged: they need no statement claim.
- **Nodes already confirmed when S1 deploys (O7).** They have no statement claim. Two choices:
  - **backfill** a `node_statement` for each node whose outside-born supports all carry a `node.confirm` marker in their
    evidence (`owner, app:node.confirm` or `console:node.confirm`, written by `ownerGround`, `claims.ts:492`). The owner
    saw a wording then; it may have been rewritten by a nightly since, and that cannot be checked;
  - or **revert** them: they read Waldo's read until the owner confirms again.

  Nodes confirmed only through per-claim `spot.confirm` (`owner, console`) revert either way. Their count on staging has
  not been read [unverified].
- **Proof.** S1's tests below, plus a metric: zero nodes in any turn block with an outside-born support and no matching
  live `node_statement`. This is checkable from the turn trace's `shown.nodes` once S4 lands, and by a DO query before
  then.
- **Contract.** The app's `confirmation` keeps its two values. Its documented meaning changes from "every supporting
  claim is the owner's own word" (`controls.ts:243-244`) to "the owner confirmed this node's wording". Fewer nodes read
  `confirmed`, never more. **Ask the gate:** does a doc-comment change on an existing field need a controls revision?

**Falsifiers.** The fix fails if any of these happens:
- each support of a mail-born node is confirmed one at a time and the node enters the turn block or reads `confirmed`;
- `node.confirm` grounds a mail support;
- after `node.confirm`, a nightly promotion rewrites the label and the node still reads `confirmed`;
- a node resting only on owner claims loses `confirmed` (a regression);
- an outside-content job receives a health node's `node_statement` through recall or `read_memory({ ids })`;
- a `node_statement` counts as promotion evidence.

**Privacy and authority.** This tightens the trust fence. A stranger's mail can no longer reach every turn as the owner's
confirmed words through per-claim confirms.

**ADR and migration.** No migration. It amends D5-b in CROSS_DOMAIN and WELCOME_CONSTELLATION §3/§4.3: a docs change
inside the S1 PR. No new ADR [inference: it decides within the welcome design's existing scope].

**Rollback.** A code revert, with one cost. Old code already leaves `node_statement` out of promotion, because promotion
reads only `observation` and `pattern` (`claims.ts:1541-1543`). But it would recall those rows as ordinary owner claims,
which reopens the outside-turn path above. The revert PR therefore also sets them to `dismissed` in the same deploy, with
a one-line `UPDATE` in the DO's setup. A reverted Worker counts a node `confirmed` only if every support is
owner-grounded, which it will not be under A, so the nodes fall back to Waldo's read.

## 3. The unreachable node

### 3.1 Current state

[verified] The graph drops a node unless every support id is a live, unheld `active`/`promoted` claim
(`channels/memory-graph.ts:25-28`). The console list reads that graph, and so does the app (`app-controls.ts:80`).
`memoryControl` resolves actions against `shown.nodes()` (`owner-do.ts:5187`), so it would accept a `node.forget` on such a
node, but neither surface can list it.

Three writers leave a node citing a dead claim:
1. `correct()` of a support that was **not** owner-grounded. It deliberately does not re-point (`claims.ts:495-506`, the
   fail-closed fence from #1679). Its comment says the node "stays out until it is rebuilt or the owner corrects the node
   itself" (`:497-498`), but the owner cannot reach it to correct it.
2. Console `spot.edit` or app `claim.edit` of such a support, which routes through `correct()`
   (`owner-do.ts:5250-5253`).
3. `spot.dismiss` (`owner-do.ts:5260`) or the nightly `dismiss` (`claims.ts:1467`).

**Privacy impact.** Waldo-written label and summary text stays in DO SQLite where the owner can remove it only by
forgetting a topic in chat.

### 3.2 Cited failure

Gate review on waldoco/waldo-backend#1679, "not this PR" list: "A node left citing a superseded claim drops out of the
graph, so the console can't reach it to correct or forget it."

### 3.3 Options

| Option | Mechanism | Verdict |
|---|---|---|
| **A. List it as incomplete** (recommended) | The graph returns such a node with `support.state: 'incomplete'`, its live `claim_ids`, `unavailable_count`, and `confirmation: 'waldos_read'`. `memoryControl` offers `node.correct` and `node.forget` only. **Only** a support that is `superseded` or `dismissed` lets the node through. A support that is purging, forgotten or held still drops it, as today. | The app.v1 schema already has `'incomplete'` (`controls.ts:249`), so no contract revision is needed [verified]. |
| B. Auto-forget the node when a writer orphans it | The writer deletes the node and barriers its label in the same transaction | Removes a read the owner may want to correct. The barrier blocks relearning a pattern the owner never rejected. Rejected unless the owner prefers it (O4). |
| C. Mark the node `stale` at orphaning | The writer sets `status = 'stale'` | Still dropped by the graph, so it changes nothing visible without A. |

### 3.4 Recommendation [proposed]: A

The turn block keeps excluding these nodes: `constellationLines` requires every support to be live (`claims.ts:1124-1127`).
They are reachable for removal, never promoted back into context.

**Falsifiers.** The fix fails if any of these happens:
- a node whose missing support is `purging`, `forgotten`, or carries a held topic appears in the graph (the privacy fence
  from `memory-graph.ts:18-25` must hold);
- an incomplete node offers `node.confirm`;
- an incomplete node enters a turn.

**Proof.** S2's tests, plus a metric: zero active nodes that are absent from the graph while their missing supports are only superseded or dismissed (a DO query).

**App.** The app must render `incomplete` honestly. That goes to the app lane as a brief line, not code (§6).

**Rollback.** A code revert. No data changes.

## 4. Memory-change signal (app gap 9, backend side)

### 4.1 Current state

[verified]
- `remember` and `forget_memory` carry receipt effects `memory_stored` and `memory_forgotten` (`tools/records.ts:170,174`).
- `turnReceipt` turns them into typed receipt items (`hooks/receipt-line.ts`), and the app reply carries them as a
  `receipt` part (`app-api.ts:346`).
- `memory` is already a chat=3 activity kind (`contracts/src/app/core.ts:102`).
- Every constellation projection already carries a content `revision` hash (`app-controls.ts:112`).

So for **chat** writes, the app can refresh today with no backend change.

The residual is writers **outside an app chat turn**, which the app cannot see: the nightly claim ops and promotion, the
welcome build, console actions, the source pass (flag off), the compaction flush, and turns on iMessage.

### 4.2 Options

| Option | Mechanism | Verdict |
|---|---|---|
| **A. A per-owner `memory_revision` counter** (recommended) | SQLite triggers on `claims` (INSERT, DELETE, UPDATE OF `text`, `status`, `origin`, `verification_status`, `pinned`, `pin_order`, `aliases`) and on `constellation_nodes` and `constellation_edges` bump one row inside the writer's own transaction. The same pattern as the `claim_vectors` triggers. `seen` and `last_seen_at`-only updates do not bump it. The counter is exposed as an optional field on the **day** projection, which the app already polls. It is also the harness's `core` freeze key (§1.6). | Covers every writer structurally, with no per-writer hooks. Additive app.v1 controls revision. |
| B. A silent push on memory change | APNs or FCM | New machinery for a low-frequency event. Rejected. |
| C. App-side only: re-read on focus and on memory receipts | No backend change | Covers chat and most use. It misses a screen left open across a nightly run. A fine first step; app lane. |

### 4.3 Recommendation [proposed]

C now (app brief), then A. A is low priority: the main missed writer runs at night.

**Falsifiers.** A fails if a `seen` bump changes the revision (the app would refresh on every turn), or if any memory
writer changes rows without bumping it. The test enumerates the writers.

**Proof.** S3's writer-enumeration test, plus app evidence: after a nightly run, an open Constellation screen shows the new node without a manual refresh.

**Privacy.** A counter, no content.

**Rollback.** A Worker revert ignores the row. Old app builds never receive the field.

## 5. Life areas, shared by memory and the one backlog

### 5.1 Current state [verified]

**At `070eea7e` on draft #1587:**
- `loops` gains `area` (`'work' | 'personal' | 'health'`, nullable for unsorted). The model sets it and the owner can change it (§3 of that note).
- Candidates are a loop status that the harness sets from taint and trigger. The owner confirms a candidate only in an owner turn (§5).

**At `7e6bce8a`:**
- Claims have **no** area. Their only grouping is `kind` (`claims.ts:11`) and the `hall` argument of `read_memory`.
- Nodes have a free-text `domain` that the promotion model chooses: "sleep, energy, work rhythm, …" (`claims.ts:1503`).

### 5.2 Cited failure

- **26 Oct ruling.** Loops, responsibilities and the backlog fold into one aggregate that spans work, personal life and health (#1587 §1).
- **30 Oct direction.** Memory covers the whole of a life and connects the dots across it: body and health, cognitive state, daily life, work, goals and ambitions, relationships.
- **The gap.**
  - The owner's facts cannot be viewed or recalled by life area next to their open items.
  - Three areas cannot tell energy from illness, a dinner plan from a passport renewal, or a friend from a bill.
  - Patterns across areas, the weave in CROSS_DOMAIN, have no shared axes to connect along. [verified: no `area` column]

### 5.3 The area set [proposed] (O5)

The set comes from the help taxonomy in [`docs/research/PERSONAL_ASSISTANT_HELP_TAXONOMY_2026-10-30.md`](../research/PERSONAL_ASSISTANT_HELP_TAXONOMY_2026-10-30.md) §4. Each area is where a cluster of an assistant's help lands.

| Area | Covers | Why it is its own area (research) | Health and safety rule |
|---|---|---|---|
| `body` | Sleep, movement, food, illness, appointments, cycles, recovery | Recovery and sleep are the body's side of allostatic load. Shift work and travel move the body clock. | ADR-0081 applies in full: patterns in words only, never a reading. A device reading lives in Supabase and is read live. |
| `mind` | Energy, focus, mood, stress, cognitive load, rest | Working memory is small and interruptions cost time. Unfinished goals intrude until they are planned. Waldo protects focus as an EA protects time. | The same as `body`: patterns in words. It is not a clinical record. Whether something is clinical stays a model judgment (CLAUDE.md), with the existing clinical evals. |
| `home` | Daily life, household, errands, logistics, travel, admin | The EA's travel and logistics tasks. The parent's school and daycare windows. | — |
| `work` | Job, meetings, projects, colleagues as work context | The EA's core tasks: calendar, inbox, briefing, follow-through | — |
| `people` | Family, friends, relationships, birthdays, what each person cares about | Relatedness (self-determination theory). The EA's relationship-management tasks. | — |
| `goals` | Ambitions, learning, long projects, what the owner is becoming | Autonomy and competence. Implementation intentions turn a goal into a when-then plan. | Goals stay claims of kind `goal` (#1587 §4). |
| `money` | Bills, budgets, subscriptions, purchases, financial admin | An open loop with a deadline and a cost. The EA handles expenses and payments. | Payment credentials never enter memory (Vault ruling, 26 Oct). Memory holds "rent due on the 1st", never a card number. |

There is also unsorted (`null`). An item may genuinely span areas: "the half marathon" sits in `goals` and `body`. The
area records where it *mainly* belongs, and the weave's edges carry the rest.

**Coordination with #1587** [proposed]:
- The set ships as one exported constant in `packages/contracts`, `LIFE_AREAS`. `loops.area` and `claims.area` both use it, so one concept has one vocabulary.
- #1587's three map onto it: `work` stays `work`; `health` becomes `body` or `mind`; `personal` becomes `home`, `people`, `goals` or `money`.
- #1587 is still a draft with no code, so nothing needs migrating.
- #1587's ADR draft names the shared constant.

### 5.4 Options

| Option | Mechanism | Verdict |
|---|---|---|
| **A. One coarse `area` on loops and claims** (recommended) | Claims gain a nullable `area`, set by the model in `remember` and in the nightly and daytime claim ops; the owner can change it. Nodes keep their free-text `domain` as the model's finer label. Where a view needs a node's area, it uses the area its supports share. Nothing new is stored on nodes. | One vocabulary, the least new state |
| B. `area` on nodes too | The promotion model sets it | A third writer of the same label, which can drift from its supports |
| C. Replace node `domain` with `area` | — | Contract drift on an existing app.v1 field. Rejected. |

### 5.5 Recommendation [proposed]: A

**Where the cross-cutting view appears:**
- #1587's console Backlog, grouped by area;
- `read_memory({ area })` for claims;
- the area count line in `core` (§1.4): "work: 14 notes, 3 open items · body: 6 notes · …". It points the model at `read_memory({ area })` and the loop tools;
- the weave (CROSS_DOMAIN D5), which now has named axes. Patterns that connect `body` to `work`, or `mind` to `people`, are the "connect the dots" the owner asked for.

**Hard rules** [proposed]:
- **`area` never drives a safety fence.** `outsideView`, the health filters, `statedReading` and taint stay on `kind`, `source_ref` and the numeric checks (`memory/outside-view.ts:10-11`, `claims.ts:1097`). A health claim the model files under `work` must still be kept out of an outside-content turn. S5 tests this.
- **No keyword rules pick an area.** The model sets it and the owner corrects it (O6).
- **Inferred items stay candidates.** An inferred claim stays `inferred` until the owner confirms it, and an inferred loop is a `candidate` (#1587 §5). The area is a label on either. It changes neither one's confirmation state.
- **Forget** redacts claim text, as today. `area` is an enum and carries no free text.

**Falsifiers:**
- a `body` or `mind` claim labelled `work` reaches an outside-content turn;
- the owner reports a wrong area more than about one time in five over a week [proposed threshold];
- area grouping changes which loops become candidates;
- the model files under `mind` something that reads as a diagnosis. The clinical evals catch that.

**ADR, migration, contract:**
- An additive DO column on `claims` (the guarded `ADD COLUMN`, `claims.ts:365-372`). No Supabase migration.
- Additive tool-schema fields: `remember.area` and `read_memory.area`, plus the `LIFE_AREAS` constant.
- `area` in app.v1 is a later additive revision, which the gate allocates.
- #1587's ADR draft names the shared constant.

**Rollback.** Old code ignores the column.

## 6. Real-time memory: from today's observations to lasting memory

### 6.1 Current state [verified]

What Waldo learns reaches memory at three speeds today.

| Path | Speed | Writer | Where |
|---|---|---|---|
| The owner says it in chat, on any surface | **Real time.** The model calls `remember` in the turn. | `ClaimStore` | `tools/live/memory.ts:77-120` |
| What the model did not save from the day's chat | **Nightly.** The claim ops in `NIGHTLY_MEMORY_INSTRUCTION`. | `ClaimStore` via `applyClaimOps` | `claims.ts:1357-1470`; `owner-turn.ts:45` |
| Mail and calendar changes | **Nightly, and switched off.** The update sweep runs on a Gmail or Calendar push, or every 10 minutes, and records `update_cards` and `observed_mail`. The source pass that turns those into untrusted claims runs only at night, behind `MEMORY_NIGHTLY_SOURCE_UPDATES = "0"`. | `ClaimStore` via the source pass, all writes untrusted | `gmail-push.ts:4-5`, `calendar-push.ts:1-3`, `update-cards.ts:15`, `nightly-sources.ts:7`, `owner-do.ts:4626`, `owner-turn.ts:1027` |
| Patterns (constellation nodes) | **Nightly.** Promotion. The welcome build also writes nodes once, and a later connection reopens its stage once. | `ClaimStore` | `claims.ts:1532-1562`; `welcome.ts` |
| Health | Live from Supabase at read time. It is never copied into memory as values (ADR-0081). | Supabase | `get_health`; the per-turn health line |

**Cited failure.** The owner's direction of 30 Oct asks for memory that updates in real time and is reflected everywhere.
Today a fact from a morning mail reaches memory the next night at the earliest, and only with a flag that is off. A pattern
reaches the app only after a nightly run, and an open app screen never learns that anything changed (app brief gap 9).

### 6.2 The design [proposed]

There are three layers. Each has one owner and one writer.

| Layer | What it holds | Owner and writer | Life |
|---|---|---|---|
| **Today** (working state) | What happened and is happening today: chat turns, mail and calendar changes, loops due, health freshness, connector events. | **The harness** (event ingestion and the day's working state). It reads existing stores: `episodes`, `update_cards`, `observed_mail`, `loops`, the health read. | Each store keeps its own retention. It is not memory. |
| **Learned today** | Claims written during the day: by the model in a turn (`remember`), or by the **daytime consolidator** below. | `ClaimStore` | Durable claims, the same as any other. Owner-grounded only from the owner's own words. Anything from outside content is `untrusted`, which makes it a candidate until the owner confirms. |
| **Lasting** | Claims, nodes and edges after the nightly curation, promotion and weave. | `ClaimStore` | Until the model retires them (dismiss, supersede, `valid_to`) or the owner forgets them. |

**The daytime consolidator** [proposed]:

- **Trigger.** It runs from the harness's `observed(...)` event (§6.3), debounced. A run happens at most every 15 minutes, and at most **6 runs a local day** (O8).
- **Input.** Only new rows since its own watermark, read through the existing paths:
  - `outsideView` and the source pass's input for mail and calendar;
  - episodes for chat the model did not save.
- **Model and writes.** It uses the aux model and writes through `ClaimStore` only. Owner-grounding stays with the admission gate (`ground()`), never with the consolidator.
- **No text in the event.** The consolidator reads content itself. Nothing is copied into a new store.
- **Spend.** At most 6 aux calls a day, plus today's nightly calls. Each pass is bounded the way the nightly source pass already is (at most 40,000 input characters a call; the gate's conditions on #1653). Each pass records its cost in the ledger.
- **Promotion stays nightly** [proposed]. A pattern needs owner claims on two different days (`claims.ts:1503`), so a daytime promotion pass could rarely admit anything new. The weave stays nightly too.

**Decay** [proposed]. No fixed formula decides what fades. That would be a code rule making a judgment call (CLAUDE.md).

- Today's working state ages with its stores.
- Claims leave only by:
  - the model's nightly ops: `dismiss`, a correction that supersedes, `valid_to` for dated facts;
  - the owner's forget.
- Nodes go stale by the promotion model's `status: 'stale'`, which needs eligible evidence (`claims.ts:1503`).
- Recency still matters as *information*. Every recalled line already shows its last-seen date (`turn-recall.ts`, `claimLine`), so the model can weigh age itself.

### 6.3 The event seam with harness-redesign

Proposed to the harness session on 30 Oct. Its answer is recorded here when it arrives, and the gate reconciles the two docs.

```ts
// Emitted by the harness in the owner DO after an ingestion commits; never inside the SQLite transaction.
observed(event: {
  kind: 'chat' | 'mail' | 'calendar' | 'health' | 'connector';
  refs: string[];               // row ids only (entry ids, source refs, update card ids); never text
  taint: 'owner' | 'external';  // from the ingestion path, never from the model
  at: number;                   // epoch ms
  localDay: string;             // the owner's local day, YYYY-MM-DD
}): void
```

- `kind: 'health'` only wakes the consolidator to re-read patterns through the existing health path. It never carries or
  stores a value.
- The consolidator owns its retry. A missed event is recovered by its watermark at the next event or at the nightly run.

### 6.4 Reflected everywhere [proposed]

| Surface | How it learns memory changed | Slice |
|---|---|---|
| Chat (every surface) | The next turn's `selectMemory` reads the current store. `revision` lets the harness log whether `core` changed. | S4 |
| App | Re-read on focus, and after a reply whose receipt part has `memory_stored` or `memory_forgotten` (works today). Then the `memory_revision` field on the day projection, which the app already polls. | S3 and the app brief |
| Console | The same `memory_revision`, on the console's day and memory reads | S3 |
| Notifications | No new push for memory. A pattern Waldo formed, or a finding or candidate waiting for a yes, is offered in the next Close card (at most 3, per #1587's carry-over). A change that matters for today is the harness's update-card decision, as now. | S8 |

**Falsifiers:**
- a mail item seen in the morning is not a candidate claim by the afternoon, with the consolidator on;
- the consolidator writes an owner-grounded claim from outside content;
- it runs more than 6 times a day;
- a run copies mail text into any store other than claims through the existing gate;
- an open app screen misses a nightly change for more than one poll after the S3 field lands.

**Proof:**
- m14 (S0): a mail at 09:00, then a question at 15:00 whose answer needs it. The receipts: a candidate claim exists by 15:00; the turn reaches the mail live; no untrusted claim is in `shown`.
- The consolidator's run count and cost per owner-day, in the ledger.

**Privacy and authority.**
- The consolidator moves the existing nightly source pass to daytime. It inherits every fence that pass has: `outsideView`, untrusted writes, no health readings, forget barriers.
- It needs `MEMORY_NIGHTLY_SOURCE_UPDATES` on for the cohort (O9).
- The privacy notice already covers mail and calendar reads for the owner's day [inference: the notice v1 lists what Waldo reads; check its wording when O9 is decided].

**ADR, migration, rollback:**
- A KV watermark and no new table. The source pass's design and ADR scope stay as they are (#1653).
- Rollback: the flag, or the consolidator's own switch.

## 7. Understanding the owner from the public web (look-ups)

### 7.1 Owner rulings that bind this section

- **25 Oct:** OSINT and look-ups are approved.
- **23 Oct:** findings stay visible to the owner, and an unconfirmed finding expires after 30 days.

### 7.2 Current state [verified]

`onboarding/findings.ts` builds the look-up in four steps:

1. **Consent.** `record_owner_finding` stores a finding only while the owner's `owner_lookup` consent is active (`:95-104`). Staging has `OWNER_LOOKUP = "1"` (`wrangler.jsonc:109`).
2. **The quote must be on the page.** The model saves a finding only with a quote it read on that page; otherwise the save is refused (`source_not_observed`, `quote_not_on_page`). Health values are refused too (`health_value`, `:40`).
3. **Its own table, out of prompts.** Findings live in `owner_findings`, apart from claims (`:56-58`). The store's own comment says a finding is never put in a prompt until the owner keeps or corrects it (`:49-54`). `list_owner_findings` returns its data with `source_taint: 'external'` (`:214`).
4. **Expiry.** An unconfirmed finding is deleted after `APP_FINDING_UNCONFIRMED_DAYS_V1 = 30` days (`contracts/src/app/onboarding.ts:160`; `findings.ts:66-70`). Expiry is not the owner's no, so it bars nothing.

What the owner can do with a finding:

- **Keep or correct** (`:121-141`) writes an owner claim:
  - `origin = 'owner'`;
  - `source` is `confirmed` when kept, `stated` when corrected;
  - `source_ref = owner, look-up fnd_…` (`:88-91`).
- **Forget, or withdraw consent,** bars the text and purges any claim the finding became (`:77-85`, `:143-154`).

How kept findings appear in prompts:

- `ownerProfilePrompt` groups them under *Kept from the web look-up* (`owner-profile.ts:10`).
- Every other renderer treats them as owner claims.

### 7.3 Where findings enter memory, and with what trust

| Stage | Store | In a prompt? | Trust | Who moves it on |
|---|---|---|---|---|
| Found | `owner_findings`, `unconfirmed` | No. Only `list_owner_findings` reads it, as external data. | Outside content | The owner (keep, correct, forget) or the 30-day expiry |
| Kept | an owner claim, `confirmed`, with ref `owner, look-up …` | Yes: the profile, recall and constellation evidence | The owner's word, from a public source | The owner, the same as any claim |
| Corrected | an owner claim, `stated` | Yes | The owner's own words | The owner |
| Forgotten or consent withdrawn | Deleted, text barred, claim purged | Never again | — | — |

### 7.4 What this redesign adds [proposed]

1. **Area.** A finding is classified by its own `category` (`findings.ts:89`). When a finding becomes a claim on keep or correct, the model also sets its life `area` (§5), so a kept finding lands in work, people or goals. The area is a label (O6). It is not a trust change.
2. **Offer, don't wait (O10).**
   - Today an unconfirmed finding waits in the app's *What Waldo knows* until the owner happens to look, or until it expires.
   - Proposed: the Close card offers up to 3 unconfirmed findings a day ("Waldo found these about you on the public web; keep or let go?"). This reuses #1587's Close carry-over and its "up to 3 candidates" rule. There is no new push.
   - The owner answers in words. The model calls the existing keep, correct or forget path only in an owner turn that has not read outside content.
3. **Connecting the dots.**
   - Kept findings are owner claims, so the nightly promotion can already use them as evidence for nodes.
   - Unconfirmed findings never can: they are not claims, and the eligible set requires owner origin (`claims.ts:1541-1543`). This is the boundary that keeps a stranger's page out of the owner's patterns, and it stays.
4. **No health.** The `health_value` refusal stays. A look-up never writes the body or mind area from a public page.

**Falsifiers:**
- an unconfirmed finding's text reaches any prompt other than through `list_owner_findings` as external data;
- a finding becomes a claim without the owner's keep or correct;
- the Close card offers more than 3 findings a day;
- an expired finding is offered.

**Migration, contract and rollback:**
- No migration.
- The Close card offer is a prompt and ledger change inside #1587's carry-over (slice S8).
- `area` on kept claims comes with S5.
- Rollback: a code revert.

## 8. App brief additions (for Suyash's lane, not code here)

Added to `APP_MEMORY_SYNC_BRIEF_2026-10-30.md` items 1–9:

- **10.** Render nodes with `support.state: 'incomplete'`. Show "a note under this changed", and offer correct and forget
  only (§3).
- **11.** After S1, `confirmation: 'confirmed'` means the owner confirmed the wording. App-side "Confirm" calls
  `node.confirm` as today.
- **12.** For gap 9, re-read memory on focus and after a reply whose receipt part has a `memory_stored` or
  `memory_forgotten` item. That works today. The day-projection `memory_revision` (S3) comes later.
- **13.** When S5 lands, group notes and backlog items by the seven life areas, and let the owner change an item's area.
  Show `area` only once the gate has allocated its app.v1 revision.
- **14.** *What Waldo knows* already lists look-up findings with keep, correct and forget (`findings.ts`). Show their
  30-day expiry, and treat a finding the owner keeps from the Close card (S8) the same as one kept in the app.

## 9. Build slices

Each slice is its own PR, red tests first, with one issue each. "DO column" means an additive column in the owner DO's
SQLite via the guarded `ADD COLUMN` pattern. None of these slices needs a Supabase migration, so no migration timestamp is
requested. Every app.v1 revision is **requested from the gate**, never picked here.

| Slice | What | Files | Single writer | Tests (adversarial included) | Migration / ADR / contract |
|---|---|---|---|---|---|
| **S0** (waldoco/waldo-backend#1693) | Relevance evals m07–m13 and the `shown`-ids receipt | `evals/nightly/state-memory-scenarios.ts`, `evals/nightly/catalogue.ts`, `evals/nightly/gate.ts` (`min_scenarios`), `evals/nightly/receipts.ts`, `test/nightly-eval-state-memory.test.ts` (one failing scripted trial per receipt), `docs/evals/STATE_AND_MEMORY_EVALS.md` | none (eval) | receipts can fail; m12 held and forgotten; m13 outside job and health | none |
| **S1** (waldoco/waldo-backend#1694) | Node confirmation by statement claim (§2) | `onboarding/welcome.ts` (`confirmWelcomeNode`, `correctWelcomeNode`), `memory/node-sources.ts`, `memory/claims.ts` (`constellationLines`), `channels/dashboard-memory-actions.ts`, `channels/memory-graph.ts`; docs: D5-b and the welcome note | `ClaimStore` in the owner DO | per-support `spot.confirm` keeps the node out (red at base); `node.confirm` grounds no mail support; a nightly label rewrite drops `confirmed`; owner-only nodes unchanged; forget of the statement removes the node; an outside-content job never gets a health node's `node_statement` by recall or `read_memory({ ids })`; a statement is never promotion evidence; the O7 backfill matches only `node.confirm` markers; owner scoping (another DO's ids refused) | none; ask the gate whether the `confirmation` doc-comment needs a controls revision |
| **S2** (waldoco/waldo-backend#1695) | Incomplete nodes reachable (§3) | `channels/memory-graph.ts`, `channels/dashboard-memory-actions.ts`, `packages/dashboard-app` (console render) | `ClaimStore` (no new writes) | superseded and dismissed supports surface; purging, forgotten and held still dropped; no `node.confirm` offered; the turn block still excludes them; console forget removes and barriers | none (`incomplete` is already in app.v1) |
| **S3** (waldoco/waldo-backend#1696) | `memory_revision` (§4 A) | `memory/claims.ts` (triggers, `revision()`), `channels/app-controls.ts` and the day projection, `packages/contracts/src/app/controls.ts` | the triggers, inside each writer's own transaction | each writer bumps; `seen` does not; old revisions never get the field; owner scoping | DO table plus triggers; **controls revision requested from the gate** |
| **S4** (waldoco/waldo-backend#1697) | `selectMemory` and option B (§1), **behind a flag; S0 decides whether it goes on** | new `memory/select-memory.ts`, `memory/claims.ts` (`turnMemoryPrompt` delegates), `memory/turn-recall.ts`, `channels/owner-turn.ts` (the two call sites, `:386` and `:613`), `tools/live/memory.ts` (`ids`), `packages/contracts` (the `read_memory` schema) | none (read path) | S0 green; m03 and m04 unchanged; held, forgotten and untrusted ids refused by `read_memory({ ids })`; outside turn gets no health by id or stub; budget never exceeds `room`; a fresh remember is on the next turn | additive tool-schema field (valid + invalid pair); no ADR |
| **S5** (waldoco/waldo-backend#1698) | `LIFE_AREAS` and claim `area` (§5). The constant can land at once; #1587's loops adopt it when they are built. | `packages/contracts` (`LIFE_AREAS`), `memory/claims.ts` (column, claim-ops schema), `tools/live/memory.ts` (`remember.area`, `read_memory.area`), #1587's ADR draft | `ClaimStore` | a `body` or `mind` claim labelled `work` stays out of outside turns; forget; the owner's change wins over the nightly; no area without a claim | DO column; tool-schema fields; app.v1 area later (gate) |
| **S6** (waldoco/waldo-backend#1699) | Semantic recall on for the staging cohort (§1.5, O1) | `llm/pricing.ts` and the cost ledger (embedding price, spend ceiling); a short ADR for `claim_vectors` in waldo-brain; one privacy-notice sentence (waldo-landing, with the owner's yes); then `MEMORY_SEMANTIC_RECALL = "1"` in `env.staging.vars` in a deploy the owner names | `semanticRecall.sync()` (unchanged) | a priced embedding call reaches the ledger; the spend ceiling counts it; m08 with the leg on and off (measured, not gating); health redaction, secrets and forget triggers (already tested) | ADR; no migration (`claim_vectors` is a DO table created by the flag) |
| **S7** (waldoco/waldo-backend#1703) | The daytime consolidator (§6.2), with `MEMORY_NIGHTLY_SOURCE_UPDATES` on for the cohort (O8, O9) | a new `memory/consolidator.ts` (debounce, watermark, daily cap); `channels/owner-do.ts` (subscribes to the harness's `observed` event); `channels/owner-turn.ts` (reuses the source pass and claim-ops calls); the cost ledger | `ClaimStore`; the consolidator only runs and retries passes | a 09:00 mail answers a 15:00 question (m14); never an owner-grounded claim from outside content; at most 6 runs a day; a missed event is recovered by the watermark; forget barriers hold; no health reading stored; owner scoping | none (a KV watermark); depends on the harness's event seam (§6.3) |
| **S8** (waldoco/waldo-backend#1704) | Close-card offers: look-up findings and patterns waiting for the owner's yes, at most 3 a day (§6.4, §7.4, O10) | `prompt/day-cards.ts` (Close carry-over, within #1587's `loopsSection`), `onboarding/findings.ts` (read only), the existing keep, correct and forget paths | the existing finding and claim writers | at most 3 offered; never an expired finding; keep only in an owner turn with no outside content; the offer's text is fenced as external data | none; it rides on #1587's carry-over |

**Order:**
- S0, S1, S2, S3, S5 (the constant) and S6 can start in parallel. S1 and S2 share `dashboard-memory-actions.ts`, so they go one after the other.
- S4 ships with S0 measuring it.
- S7 waits on the harness's event seam.
- S8 waits on #1587's carry-over.

**m14** (real time) joins S0: a mail at 09:00, then a question at 15:00 whose answer needs it, with the consolidator on. Outside content reaches the turn live, as data. The consolidator makes it a candidate the owner can confirm; it does not put it in `core`.

## 10. Fixed, and not redesigned

`WaldoCoordinator`, the trusted RunLoop and physical-effect path, the existing `ContextComposer`, one durable writer per
aggregate (`ClaimStore` for claims and nodes, the loop book for loops), memory as correctable context and not permission,
and ADR-0081: no raw health values in DO memory, transcripts or traces. Forget stays topic-only (25 Oct ruling).

## Evidence

- **Observed:**
  - source at `beta-mvp` `7e6bce8a`, at the file:line cited above;
  - the gate review comments on waldoco/waldo-backend#1679;
  - #1587's design note at `070eea7e`;
  - `docs/evals/STATE_AND_MEMORY_EVALS.md`, `M0_BASELINE_2026-10-20.md`, `LIVE_BASELINE_RUNBOOK.md`;
  - the orchestrator's `APP_MEMORY_SYNC_BRIEF_2026-10-30.md` and `WALKTHROUGH_E1_2026-10-28.md`.
- **Observed (added):** the harness-redesign session confirmed the interface terms in §1.6 (its PR waldoco/waldo-backend#1692).
- **Observed (30 Oct, second pass):**
  - Privacy notice v1 at heywaldo.in/privacy names Cloudflare as processor of "conversations, memory, files and service logs" but does not mention embeddings or Workers AI.
  - Cloudflare's Workers AI *Data usage* page says it does not train on customer content and keeps no inputs or outputs for standard inference.
  - `llm/pricing.ts` has no embedding price.
  - `onboarding/findings.ts` and `APP_FINDING_UNCONFIRMED_DAYS_V1 = 30`.
  - The research sources listed in the companion file.
- **Inference:**
  - the latency of the lexical path;
  - that the nightly exposes a usable last-run mark;
  - that no ADR is needed for S1;
  - the embedding cost per owner.
- **Unverified:**
  - any live memory eval score (none exists);
  - the harness's answer on the event seam (§6.3);
  - the staging count of nodes affected by O7.
