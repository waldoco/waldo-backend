# Memory redesign: selection by the model, honest node confirmation, reachable nodes, life areas (30 October 2026)

Status: **design proposal, docs only.** No runtime code, flag, migration or contract changes in this PR. The owner approves it
before any slice is built. The orchestrator gate reviews it.

- Base: `beta-mvp` `7e6bce8a` (the QoL merge train, staging Worker at the same SHA).
- Every claim is tagged **[verified]** (read at that SHA, with file:line), **[inference]** or **[proposed]**.
- No health value appears in this document. The evals below use synthetic patterns only.

This doc builds on the designs before it. It does not replace them:

| Earlier design | Status at `7e6bce8a` | How this doc relates |
|---|---|---|
| [`MEMORY_V2_2026-10-25.md`](MEMORY_V2_2026-10-25.md) and its ADR draft | Proposed. Not accepted, not built: `notebook_sections` and `journal_days` have no runtime hit [verified: grep of `packages/runtime/src`]. Its six open questions are unanswered. | **Extends.** *About you* stays the target for the stable page. This doc gives the interface it would sit behind and the eval that decides whether to build it. |
| [`docs/planning/semantic-recall.md`](../planning/semantic-recall.md) | Built as a tracer behind `MEMORY_SEMANTIC_RECALL`, off everywhere. A candidate design, not an ADR. | **Keeps it off** and names what turning it on needs (§1.5). |
| [`WELCOME_CONSTELLATION_2026-10-25.md`](WELCOME_CONSTELLATION_2026-10-25.md), [`CROSS_DOMAIN_CONSTELLATION_2026-10-28.md`](CROSS_DOMAIN_CONSTELLATION_2026-10-28.md) | Merged designs. D5-b is open. | **Generalises** D5-b option A ("confirm grounds the node's own claim") to every node (§2). |
| Draft waldoco/waldo-backend#1587, `OWNER_BACKLOG_2026-10-26.md` at `070eea7e` | Draft. It waits on owner questions Q1–Q3. | **Extends.** The same `area` vocabulary goes onto claims (§5). Q1–Q3 are listed, not decided. |

## Owner decisions

These are open. None is decided here. Each recommendation's reasoning is in the section named.

| # | Decision | Recommendation |
|---|---|---|
| **O1** | Semantic recall (meaning search over memory) stays off until: the relevance eval (S0) shows lexical misses; an ADR covers `claim_vectors` and Workers AI egress; and the privacy notice names embeddings. Or turn it on now? This is MEMORY_V2's Q5 too. | Keep it off (§1.5). |
| **O2** | The every-turn memory block stops filling with the **newest** facts. It shows the model's picks (pins), a short *not yet reviewed* tail, and a count by area that points the model at `read_memory`. Only if eval S0 shows the change helps. | Yes, gated on S0 (§1). MEMORY_V2's *About you* compiler stays the later step for the stable page. Its Q1 (replace or sit beside the pinned blocks) is still yours. |
| **O3** | "Confirmed" on a pattern means **you confirmed its wording**. Confirming the single notes under it one by one no longer counts. Confirming a pattern also stops turning the mail notes under it into your own words. | Yes (§2). This is D5-b option A, applied to every pattern. |
| **O4** | A pattern left resting on a note that was replaced or dismissed is shown again in the app and console, marked *incomplete*, so you can correct or forget it. The alternative is deleting such patterns automatically. | Show it, with correct and forget only (§3). |
| **O5** | The life-area list: #1587's **work, personal, health**, plus unsorted, shared by backlog items and notes. Or a longer list, such as people, home, money? | #1587's three, extended only when a real item will not fit (§5). |
| **O6** | An area Waldo sets on a note is a **label you can change**. It is not a fact that waits for your yes. | A label (§5). The note it sits on keeps its own confirmation state. |
| **O7** | Patterns you already confirmed before the fix in O3: keep those you confirmed with the pattern's own Confirm, or ask you to confirm them all again? Patterns confirmed only note by note go back to "Waldo's read" either way. | Keep the ones confirmed with the pattern's Confirm (§2.4). |
| — | #1587's own questions. They are not answered here. **Q1** cohort scope: (a) backlog with chat and mail capture, app fields, console Backlog, Close carry-over; (b) Google Tasks link and completion; (c) calendar and meeting capture. **Q2** weekly review, yes or no. **Q3** which capture sources need your confirmation. | See #1587. |

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

The selection redesign in §1 is therefore **gated on its own eval (slice S0)**. What *is* verified is a shape defect: a fixed
rule, newest first, decides which owner facts the model sees on every turn once they outgrow 4,000 characters. CLAUDE.md
says such a rule is moved "to model reasoning with scenario tests" or filed under `post-mvp-cleanup`. S0 is those scenario
tests.

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

None observed (see the re-baseline). The shape defect is at `claims.ts:1139`. The failure it predicts, which S0 must
reproduce before S4 is built [proposed]: an owner with more than about 40 short facts asks something whose answer rests on
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

**B now, gated on S0, behind the interface in §1.6. C stays the later step for the stable page.**

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
- S0 shows no difference between recency and B on m07–m10. Then file the fill under `post-mvp-cleanup` and build nothing.
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

### 1.5 Semantic recall (O1)

- **Stays off.** Turning it on is not a flag flip. It creates live persistence (`claim_vectors`, created only when the
  flag is on) and a new egress of claim and message text to Workers AI. Numbers are redacted first, but health-pattern
  words still go out.
- **Before any switch-on:**
  - an ADR (MEMORY_V2's ADR draft is the natural home);
  - the privacy notice names embeddings under Cloudflare's processing;
  - Workers AI's training terms are confirmed;
  - embedding cost joins the cost ledger and the owner spend ceiling;
  - m08 (paraphrase) is red on lexical and green with the leg on;
  - the 0.5 floor is set from m08's data.
- **B is ready for it:** semantic matches join recall as candidates through `ClaimStore.recall`'s existing `near` input
  (`claims.ts:461`), unchanged.

### 1.6 The memory-selection interface [proposed]

This doc owns the interface. The harness redesign consumes it. The terms below were sent to the harness-redesign session
on 30 Oct and are **unconfirmed**. They stay open here. The gate reconciles them with the harness design doc, and S4 does
not start until both docs agree.

```ts
selectMemory(input: {
  view: ClaimStore;            // already filtered by the caller (barrierMemory / outsideView / owner-only). Never widened here.
  text: string;                // the owner's message, or the machine turn's prompt
  previous?: string;           // the previous owner message, joined when text is short (today's RECALL_MIN_TERMS rule)
  turn: 'owner' | 'machine' | 'outside';  // episodes join only 'owner' (today's rule); 'outside' implies view = outsideView
  room: number;                // characters the harness grants memory this turn
  deadlineMs: number;          // wall-clock cap for the optional semantic leg; the lexical path is synchronous
  episodes?: RecallEpisodes;   // the owner turn's search_episodes adapter, as today
}): Promise<{
  core: string;                // pins + not-yet-reviewed tail + area counts + constellation; stable while `revision` is unchanged
  recalled: string;            // per-message candidates: full lines, then stubs
  shown: { claims: number[]; nodes: number[] };  // ids only, for the turn trace and the S0 receipt; never text
  failed: ('claims' | 'episodes' | 'semantic')[];  // fail-open legs, as today
  revision: number;            // the owner's memory revision (§4); a cache and freeze key for core
}>
```

**Contract terms**
- **Budget.** `core` is at most min(`room`, 4,000 + 1,200) characters. `recalled` is at most min(`room` − `core`,
  3,000). These are today's numbers. The harness may lower `room`; selection never exceeds it.
- **Ranking.** `core` follows the model's pin order, then the tail's arrival order. `recalled` follows retrieval rank (bm25,
  or RRF once vectors are on). No code-scored "importance", no keyword rules, no area weighting.
- **Latency.** The lexical path is synchronous SQLite: milliseconds [inference; measure in S4]. The semantic leg, when on,
  is one embedding call capped at `deadlineMs` (1.5 s today) and fails open.
- **Placement.** Both strings are data in the current message, as today (`turn-prompt.ts:60`), not system text. Per-turn
  variation therefore costs no cross-turn cache. Within a turn the harness freezes them, as `reuseSuffix` does today.
- **Trust.** Every line keeps its `c<id>` / `n<id>` tag and its origin label, so the model can correct what it reads with
  `remember(replaces_id)`.

**Asked of the harness session (open):**
1. the per-turn memory budget;
2. the p95 allowance before the first model call;
3. whether memory stays in the per-message suffix;
4. the slice-0 eval format.

### 1.7 Evals that show whether relevance beats recency (S0)

The new scenarios join `evals/nightly/state-memory-scenarios.ts` and the harness's slice-0 eval-parity suite. Each runs in
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

**Metrics.** Receipt pass rate by mode, judge pass rate, `read_memory` rounds per turn, and memory characters per turn.
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

## 5. Life areas on the one backlog aggregate

### 5.1 Current state

[verified at `070eea7e` on draft #1587]
- `loops` gains `area` (`'work' | 'personal' | 'health'`, nullable = unsorted), set by the model, which the owner can
  change (§3 of that note).
- Candidates are a loop status, set by the harness from taint and trigger. Owner confirmation is an owner-turn-only
  transition (§5).

[verified at `7e6bce8a`]
- Claims have **no** area. Their only grouping is `kind` (`claims.ts:11`) and `read_memory`'s `hall`.
- Nodes have a free-text `domain` chosen by the promotion model ("sleep, energy, work rhythm, …", `claims.ts:1503`).

### 5.2 Cited failure

The owner ruling of 26 Oct folds loops, responsibilities and the backlog into one aggregate, and asks for it across work,
personal life and health (#1587 §1). Today the owner's facts cannot be viewed or recalled by life area beside their open
items. "What's going on with my health stuff" has no area handle, only words for bm25 [verified: no `area` column].

### 5.3 Options

| Option | Mechanism | Verdict |
|---|---|---|
| **A. One coarse `area` on loops and claims** (recommended) | #1587's enum, as one exported constant in `packages/contracts`. Claims gain a nullable `area`, set by the model in `remember` and the nightly claim ops, and changeable by the owner. Nodes keep their free-text `domain` as the model's finer label. A node's area, where a view needs one, is the area its supports share; mixed means none. Nothing new is stored on nodes. | One vocabulary, the least new state |
| B. `area` on nodes too | The promotion model sets it | A third writer of the same label, which can drift from its supports |
| C. Replace node `domain` with `area` | — | Contract drift on an existing app.v1 field. Rejected. |

### 5.4 Recommendation [proposed]: A

**The backlog is the cross-cutting view:**
- #1587's console Backlog, grouped by area;
- `read_memory({ area })` for claims;
- the area count line in `core` (§1.4), "work: 14 notes, 3 open items · …", which points the model at
  `read_memory({ area })` and the loop tools.

Hard rules [proposed]:
- **`area` never drives a safety fence.** `outsideView`, the health filters, `statedReading` and taint stay on `kind`,
  `source_ref` and the numeric checks (`memory/outside-view.ts`, `claims.ts:1097`). A health claim the model files under
  `work` must still be excluded from an outside-content turn. That is a test in S5.
- **No keyword rules pick an area.** The model sets it; the owner corrects it (O6).
- **What is inferred stays a candidate.** An inferred claim stays `inferred` until the owner confirms it. An inferred loop
  is a `candidate` (#1587 §5). Area is a label on either and changes neither's confirmation state.
- Forget redacts claim text as today. `area` is an enum, so it carries no free text.

**Falsifiers.** The design fails if any of these happens:
- a health-kind claim labelled `work` reaches an outside-content turn;
- the owner reports a wrong area more than about one time in five over a week [proposed threshold];
- area grouping changes which loops become candidates.

**ADR, migration and contract.**
- An additive DO column on `claims`, using the same guarded `ADD COLUMN` (`claims.ts:365-372`). No Supabase migration.
- Additive tool-schema fields: `remember.area` and `read_memory.area`.
- `area` in app.v1, on claims and loops, is a later additive revision for the gate to allocate. #1587 already lists it as
  later.
- #1587's ADR draft gains one line: claims carry the same area.

**Rollback.** Old code ignores the column.

## 6. App brief additions (for Suyash's lane, not code here)

Added to `APP_MEMORY_SYNC_BRIEF_2026-10-30.md` items 1–9:

- **10.** Render nodes with `support.state: 'incomplete'`. Show "a note under this changed", and offer correct and forget
  only (§3).
- **11.** After S1, `confirmation: 'confirmed'` means the owner confirmed the wording. App-side "Confirm" calls
  `node.confirm` as today.
- **12.** For gap 9, re-read memory on focus and after a reply whose receipt part has a `memory_stored` or
  `memory_forgotten` item. That works today. The day-projection `memory_revision` (S3) comes later.

## 7. Build slices

Each slice is its own PR, red tests first, with one issue each. "DO column" means an additive column in the owner DO's
SQLite via the guarded `ADD COLUMN` pattern. None of these slices needs a Supabase migration, so no migration timestamp is
requested. Every app.v1 revision is **requested from the gate**, never picked here.

| Slice | What | Files | Single writer | Tests (adversarial included) | Migration / ADR / contract |
|---|---|---|---|---|---|
| **S0** (waldoco/waldo-backend#1693) | Relevance evals m07–m13 and the `shown`-ids receipt | `evals/nightly/state-memory-scenarios.ts`, `evals/nightly/receipts.ts`, `test/nightly-eval-state-memory.test.ts` (one failing scripted trial per receipt), `docs/evals/STATE_AND_MEMORY_EVALS.md` | none (eval) | receipts can fail; m12 held and forgotten; m13 outside job and health | none |
| **S1** (waldoco/waldo-backend#1694) | Node confirmation by statement claim (§2) | `onboarding/welcome.ts` (`confirmWelcomeNode`, `correctWelcomeNode`), `memory/node-sources.ts`, `memory/claims.ts` (`constellationLines`), `channels/dashboard-memory-actions.ts`, `channels/memory-graph.ts`; docs: D5-b and the welcome note | `ClaimStore` in the owner DO | per-support `spot.confirm` keeps the node out (red at base); `node.confirm` grounds no mail support; a nightly label rewrite drops `confirmed`; owner-only nodes unchanged; forget of the statement removes the node; an outside-content job never gets a health node's `node_statement` by recall or `read_memory({ ids })`; a statement is never promotion evidence; the O7 backfill matches only `node.confirm` markers; owner scoping (another DO's ids refused) | none; ask the gate whether the `confirmation` doc-comment needs a controls revision |
| **S2** (waldoco/waldo-backend#1695) | Incomplete nodes reachable (§3) | `channels/memory-graph.ts`, `channels/dashboard-memory-actions.ts`, `packages/dashboard-app` (console render) | `ClaimStore` (no new writes) | superseded and dismissed supports surface; purging, forgotten and held still dropped; no `node.confirm` offered; the turn block still excludes them; console forget removes and barriers | none (`incomplete` is already in app.v1) |
| **S3** (waldoco/waldo-backend#1696) | `memory_revision` (§4 A) | `memory/claims.ts` (triggers, `revision()`), `channels/app-controls.ts` and the day projection, `packages/contracts/src/app/controls.ts` | the triggers, inside each writer's own transaction | each writer bumps; `seen` does not; old revisions never get the field; owner scoping | DO table plus triggers; **controls revision requested from the gate** |
| **S4** (waldoco/waldo-backend#1697) | `selectMemory` and option B (§1), **only if S0 is red for recency** | new `memory/select-memory.ts`, `memory/claims.ts` (`turnMemoryPrompt` delegates), `memory/turn-recall.ts`, `channels/owner-turn.ts` (the two call sites, `:386` and `:613`), `tools/live/memory.ts` (`ids`), `packages/contracts` (the `read_memory` schema) | none (read path) | S0 green; m03 and m04 unchanged; held, forgotten and untrusted ids refused by `read_memory({ ids })`; outside turn gets no health by id or stub; budget never exceeds `room`; a fresh remember is on the next turn | additive tool-schema field (valid + invalid pair); no ADR |
| **S5** (waldoco/waldo-backend#1698) | Claim `area` (§5), **after #1587's owner answers and its loops build** | `memory/claims.ts` (column, claim-ops schema), `tools/live/memory.ts` (`remember.area`, `read_memory.area`), `packages/contracts` (enum shared with loops), #1587's ADR draft | `ClaimStore` | a health claim labelled `work` stays out of outside turns; forget; owner change wins over the nightly; no area without a claim | DO column; tool-schema fields; app.v1 area later (gate) |
| **S6** (waldoco/waldo-backend#1699) | Semantic recall decision (§1.5), **only if S0's m08 is red after S4** | ADR (MEMORY_V2's draft), privacy notice (waldo-landing), cost ledger | — | m08 with the leg on; health redaction; forget triggers (already tested) | ADR; no code here |

Order: S0, S1 and S2 can run in parallel (disjoint files except `dashboard-memory-actions.ts`, so S1 and S2 go one after
the other). S3 is independent. S4 waits on S0. S5 waits on #1587. S6 waits on S4.

## 8. Fixed, and not redesigned

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
- **Inference:** the latency of the lexical path; that the nightly exposes a usable last-run mark; that no ADR is needed
  for S1.
- **Unverified:**
  - the harness session's answer on the interface terms;
  - whether the live privacy notice already names embeddings;
  - Workers AI's current training terms;
  - any live memory eval score (none exists).
