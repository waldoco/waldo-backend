# Welcome constellation: design note (25 October 2026)

Status: **proposed, for gate review before any code.** Its ADR is the "First producer" section of [`ADR_DRAFT_MEMORY_V2_2026-10-25.md`](ADR_DRAFT_MEMORY_V2_2026-10-25.md), which can be accepted on its own.
It is the first producer of [Memory v2](MEMORY_V2_2026-10-25.md), and it ships on its own. When v2's *About you* page lands, the
`<owner_constellation>` block in section 3 retires into the page's *Waldo's read* section.

Base: `beta-mvp` `2c4672c9`. Owner rulings of 25 Oct: it ships in the first cohort's deploy (#1530), workstream 1 builds it, the
constellation stays with its nightly growth (M-7 retirement PRs #1491, #1500 and #1502 are closed), the look-up is on once the
notice is published, and the owner-profile ADR (#1534) is a yes.

## The experience, and what "done" means

When app setup ends, Waldo builds a small constellation while the tester takes the 2–3 minute tour. By owner ruling (26 Oct)
it is "a small constellation of your past 30 days of health data": health leads, and other sources add nodes around it only
when connected. That makes 8–15 nodes across health, work, people, routines and interests. It is presented as a welcome gift and fills in as each source finishes. Each node:

- is a short phrase with no digits;
- carries the source it came from: Apple Health, Health Connect, calendar, Gmail or the public web;
- can be confirmed, corrected or forgotten.

**Done:** a fresh app-only tester finishes setup and sees nodes arrive within the tour. Each node names its source. Confirm,
correct and forget work from the app. A chat turn right after can say what the gift showed and where it came from. A forget
removes the node from the app, from chat and from any later rebuild. Nothing numeric about health reaches DO storage.

## What the code does today (verified at `2c4672c9`)

| Fact | Where |
|---|---|
| `constellation_nodes` and `constellation_edges` exist. The nightly `applyPromotion` is their only writer. It admits a node only with two owner-grounded observation or pattern claims from different days. | `memory/claims.ts:434-439`, `:1365-1413` |
| The app projection **drops any node without supporting claims** and marks the whole graph `partial`. A node backed only by a source would never reach the app. | `channels/memory-graph.ts:22-27`, `:31` |
| Chat turns never see nodes: `turnMemoryPrompt` renders only the pinned profile and facts blocks. `memoryPrompt`, which renders nodes, feeds only the nightly passes. | `memory/claims.ts:966-980`, `:1066-1085` |
| `forgetNode` deletes the node and its edges, but sets **no barrier**, so a rebuild could relearn it. | `memory/claims.ts:536-540` |
| Look-up findings live in `owner_findings`. They are grounded on a page read in the same run, expire unconfirmed after 30 days, and have keep, correct and forget actions on `/app/v1/findings/actions`. **They never enter a prompt until the owner keeps one.** | `onboarding/findings.ts` |
| The look-up is switched by `OWNER_LOOKUP` and needs the owner's `owner_lookup` consent, which needs the published notice (`APP_AGREEMENTS`). Both are `0` on staging today. | `onboarding/consent-ledger.ts` |
| The first run's `complete` action exists, but **the app (#138 at `1289f410`) never calls `/app/v1/onboarding`.** At setup close it sends the person Home or to a drafted first message. #1547 (open) adds `POST /app/v1/onboarding/answers`, which the app is about to call at setup close. | `onboarding/first-run.ts:174-184`; waldo-app `app/(onboarding)/chat.tsx:254-275` |
| The app reads `view=constellation` through a **tolerant** reader: undeclared keys are stripped, and new enum values fail the page. The screen is "What Waldo knows". It reads `interpretations`, then `pattern` and `detail` per node. It shows a hardcoded "Unverified" badge and no source tag, and it does not poll. | waldo-app `src/agent/contracts/app-routes-v1.ts:31`, `src/agent/constellationController.ts` |
| M-8 (#1501, open) makes the constellation view take the owner's claim actions (`claim.pin`, `claim.unpin`, `claim.edit`) under `controls=2`. | #1501 `packages/contracts/src/app/controls.ts` |
| `get_health` reads at most 31 days and keeps its numbers in the turn (`turn_only_output`). The series read underneath it, `HealthReadBook.series`, takes any range. | `tools/live/health.ts` |
| Mail and calendar reads take an explicit `account`. `google.state()` lists every connected account. | `tools/live/google.ts:21-24`, `:52-66` |

## 1. Trigger: one welcome build per owner, in that owner's `OwnerDO`

`welcome.start(at)` is the only entry. It is idempotent: one row in a new `welcome_builds` table (`id = 1` check) records that
the build started, and a second call returns that row. Inside the caller's transaction it writes only that row and arms one
scheduler entry (`welcome` job). All reads happen afterwards, in the job, outside any SQLite transaction.

Callers, so that the build starts on whichever setup signal the app sends:

1. the first run's `complete` action (`first-run.ts`);
2. #1547's setup-answers route, on its first accepted write. That is the signal the #138 app actually sends at setup close.

**Ask for Suyash (posted on waldo-app #138, comment 6396896478):** at setup close, send the answers (#1547), or `complete` if the app adopts the first
run. Either one starts the build. Without one of them nothing starts, and the app should not fake a gift.

**Owner-job admission.** `lookupScheduledOwner()` (`owner-do.ts:851`) admits an app-bound owner through `appOwnerLookup`.
But `appBound()` reads the `app_subject` key, which only the first app chat send writes (`bindAppSubject`, `owner-do.ts:1484`).
A tester who finishes setup and has not chatted yet is `dormant`, and the job would throw `ClosedRunError`. Both triggers
arrive on an authenticated app route that carries `x-waldo-do-name`, so they call `bindAppSubject` before `start`, as the chat
send does. **This is the first red test:** a fresh app-only owner, with no chat yet, gets an admitted welcome job.

**Once means once.** A rerun needs a new owner act: "Run setup again" calls `start` with `rerun: true`, which opens a new row
version. Forgotten nodes stay barred through the barrier (section 3), so a rerun cannot bring them back. Deleting the account
erases the row with the DO.

## 2. Sources, health first, each bounded

Health runs first and sets the centre. Calendar and tasks, mail and web then run side by side. Each of them is given the health
nodes already written (their words, never readings) and is asked to build around them. If no health node was written, they
get a line saying the owner shares no health and that the model must say nothing of body, sleep, energy, fitness or
readiness. This is context and instruction only: there is no cap or fixed rule on the other sources. With nothing connected,
every stage settles `skipped` and no model call is made.

Each stage has a 90 s time budget (it includes the wait in the owner's serial queue) and a read budget, and records its own
state: `pending | reading | done | empty | unavailable | revoked | skipped`. Because health runs before the rest, the worst
case is two budgets, 180 s. A stage that fails leaves the others alone. The build is done when every stage has settled. Each stage's model call returns structured nodes (section 2.5). Code admits them, so the
constellation fills in stage by stage.

### 2.1 Health (Apple Health, Health Connect)

- **Read:** `HealthReadBook.consent()`, then `series()` over the last 30 local days (today and the 29 before it) for the eight `get_health` signals. This is
  the same signed read `get_health` uses, cut to the sources whose `storage_compute` and `model_processing` consent is live.
  The app's 90-day backfill (#1472 accepted) lands through ingest. This stage only reads what is there. An owner who keeps
  health out of memory (`health_memory.set` off) gets a `skipped` health stage: no consent read, no series read, no health node.
- **To the model:** daily values per signal, in the health stage's own call only, under live `model_processing` consent.
  The model returns **patterns, not values** ("a late sleeper on weekends", "steady evening walks"). Three constraints, each
  verified in source:
  - **The call must be untainted.** The sanitiser lets owner health values through to the model only at `internal_context`
    with `source_taint === null` (`scribe/sanitiser.ts:1300-1306`). Any other case is denied as `health_value_leak`. So the
    health call never shares a request with mail, calendar or web text, which is one reason each stage gets its own call.
    The reverse direction carries no readings: the later calls get the written health nodes, digit-free phrases already in
    the owner's memory, which every chat turn already reads in `<owner_constellation>`.
  - **Its text must not reach traces.** `complete()` logs a call's input and output text into the Langfuse span whenever
    capture is on, unless the purpose is metadata-only (`owner-turn.ts:303`: `memory*`, `task_source*`, `compaction`).
    Staging has capture on and #1398 is unmerged. Every welcome call therefore uses a `memory_welcome_<stage>` purpose, and
    only token counts are traced.
  - **Nothing from the input is stored.** The raw model output is parsed in memory, and only admitted nodes are written.
- **Admission (hard boundary, code):** no digit in any node string, and `numericHealthIn` finds no value (this catches spelled
  numbers). A failing node is dropped and counted, never rewritten.
- **Source tag:** the reading's source, `apple` → Apple Health and `health_connect` / `samsung` → Health Connect.
- **Empty and revoked:** `consent_required` and `not_linked` give `skipped`. `consent_withdrawn` gives `revoked`. No readings
  gives `empty`, which is kept distinct from `skipped`.
- **Late data:** backfill often lands after setup. If the health stage settled `empty` and new readings arrive within 24 hours
  of the start (`healthChanged`), the stage runs once more. It never runs a third time.
- **ADR-0081:** raw and derived numbers stay in Supabase. DO memory holds digit-free phrases only. Nothing here computes a score.
- **Relation to #1472's `HealthPattern`:** a welcome health node is a digit-free interpretation in DO memory. It is not a
  `health_patterns` row, and it is not computed evidence. When #1472's pattern contract ships, the health stage reads its
  admitted patterns instead of daily values, and passes the model the pattern kinds without numbers. Its nodes are then backed
  by those pattern ids as pointers, so one concept keeps one representation: the computed pattern in Supabase, and Waldo's
  phrasing of it in memory. Until then, the stage is the stopgap the owner ruled for: a first-day gift.

### 2.2 Calendar and Tasks, across every connected Google account

- **Read:** for each account in `google.state()` with `calendar`, `query_calendar` reads the last 60 days and the next 14,
  following pages up to 5 pages per account. The `account` argument is passed explicitly, so this does not wait on the
  multi-account fix in #1449. For each account with `tasks`, one page of open and recently completed tasks.
- **To the model:** titles, recurrence, times and attendee counts. Event descriptions and attendee addresses are not sent.
  Calendar text can be written by other people (invites), so it is outside text (section 4).
- **Pointers kept:** account email plus event ids, in the support claim's `source_ref`. Titles and times are not kept.
- **Empty and revoked:** no Google gives `skipped`. A scope missing or an `invalid_grant` gives `revoked`. No events gives `empty`.

### 2.3 Gmail and Workspace mail: pointers, not contents

- **Read:** for each account with `mail`, `search_communication` over `newer_than:90d -category:promotions -category:social`,
  up to 4 pages of 50. The model sees sender display name and domain, subject, date and thread id. **No bodies, no snippets.**
  That is the boundary rule: the gift is built from who and what, never from what a mail says.
- **Pointers kept:** account plus thread ids in the support claim's `source_ref`. No subjects.
- **Reader jobs:** when the worker layer (#1355 / #1496) ships with its off switch, this stage becomes a reader job with the
  same budget. Until then it is one bounded read in the welcome job. No seam is built ahead for a second adapter.

### 2.4 The public web: through the existing look-up, only when it is live

- **Gate:** `consent.active('owner_lookup')`. That means `OWNER_LOOKUP=1`, the published notice is accepted, and the owner said
  yes. Otherwise the stage is `skipped`.
- **Run:** a machine turn through `responder.prompt` with the tool menu `web_search`, `browse_page` and
  `record_owner_finding` only, wrapped in `observeReads`. Findings are recorded exactly as a chat look-up records them:
  grounded on a page read in this run, unconfirmed, and expiring after 30 days.
- **Web items are findings, not nodes.** The gift shows them through `/app/v1/findings`, with their own keep, correct and forget.
  Web text is never copied into `constellation_nodes` or `claims`. That keeps one representation, and keeps findings' rule
  that external text stays out of prompts until the owner keeps it. A kept finding becomes an owner claim (existing
  behaviour). From then on it can support a node through the nightly pass.

### 2.5 The model call per stage

One structured call per stage on the auxiliary model, the same `ask()` path the nightly promotion uses:
`WELCOME_INSTRUCTION` + `WELCOME_SCHEMA` → `{ nodes: [{ domain, label, summary, observation, pointers[] }] }`, at most 5 nodes
per stage and 15 in all. `domain` is one of `health | work | people | routines | interests`. `label` is at most 40 characters
and `summary` at most 140. The instruction gives the model its judgment: what is a pattern worth showing, what is too private
to show, how to phrase it. Code holds only the hard checks: schema, lengths, digits and health values, barrier hits, the stage
budget and the total cap. No regex decides topic, tone or sensitivity.

## 3. Storage

**No new node columns.** A welcome node is a normal `constellation_nodes` row, backed by one or more support claims. That reuses
support, held-topic suppression, forget cascades and the app projection unchanged.

- **Support claim:** written through `claimStore.add` with these fields.
  - `kind: 'observation'`, `source: 'inferred'`.
  - `origin`: `'agent'` for health (the owner's own device data, read by Waldo); `'untrusted'` for calendar and mail (others
    can write that text). Both values already exist, so the app sees **no new enum value**.
  - `text`: the model's one-line observation, digit-free.
  - `evidence: 'welcome build'`.
  - `source_ref: 'welcome:<source>:<pointer>'`, where source is one of `apple_health | health_connect | calendar | tasks | gmail`
    and the pointer is account-scoped ids.
- **Node:** `saveNode({ id: null, domain, label, summary, strength: 0.5, status: 'active', supporting_spots: [claim ids] })`.
  Status `active`, as today. "Waldo's read until confirmed" is carried by the support claims' `source: 'inferred'`, not by a new
  node status.
- **One new table,** `welcome_builds (id INTEGER PRIMARY KEY CHECK (id = 1), version, started_at, stages_json, finished_at)`. It
  holds stage states and counts only, never text.
- **Nightly pass:** `applyPromotion` admits only nodes with two owner-grounded supports, and saves only nodes it names, so it
  cannot rewrite or drop a welcome node. A test pins this. Once the owner confirms a welcome node, its supports become
  owner-grounded and the nightly pass can grow it, which is the nightly growth the ruling keeps.
- **Forget:** the node forget path stays `forgetNode`. Section 5's app `node.forget` adds what is missing today: a barrier on the
  label and on each support claim's text, and a purge of the support claims through `purge` → `settle`. A rebuild cannot
  relearn a forgotten node, and the cascade in `purge` (`constellation_refs`) already removes nodes whose supports go.

### Chat turns read the nodes, so the gift is honest

`turnMemoryPrompt` gains a third bounded block, `<owner_constellation>`, of up to 1,200 characters inside the existing `maxChars`.

- **What it lists:** active nodes whose supports are all live. Each line reads
  `- [n<id> · <source tags> · waldo's read|confirmed] <label>: <summary>`, fenced like every other memory line.
- **Calendar and mail nodes are included**, labelled as Waldo's read. The text is a model-written, digit-free phrase of at most
  180 characters, built from titles and senders, never bodies. This is the narrow use of untrusted-origin text the gate is asked
  to approve (section 4).
- **Web:** findings are not listed. The block's header says how many unconfirmed look-up findings the gift showed, and that
  `list_owner_findings` reads them. That tool's results are marked `external`, so reading them taints the turn as it does today.
- **Held topics:** the block goes through the same held-topic filter as `promptMemory()`.

## 4. Outside text and the write gate (#1494)

#1494 cards every state change after outside text, with typed exemptions on `TOOL_RECORDS`. The welcome build writes memory
from mail and calendar text, so it needs a defined exception. The exception is narrow because of how the build is made:

1. The health, calendar and mail stages call **no tools**. Code reads the sources and passes text into a structured call
   (`ask()`), and code applies the result. No tool dispatch happens, so there is nothing for the taint gate to card.
2. What code may write from that result is fixed: support claims with `source: 'inferred'` and origin `untrusted` (outside text)
   or `agent` (health), plus nodes backed only by them. **No effects, no pins, no owner-origin rows,** and no update to any
   existing claim or node.
3. Untrusted-origin rows stay out of `recall()` (existing rule). They can never be pinned (`profileEligible` requires owner
   origin). The only way they reach a chat turn is the bounded `<owner_constellation>` block, labelled as Waldo's read.
4. The web stage is a machine turn whose only writing tool is `record_owner_finding`, already exempt as `honest_origin` in #1494.

So the ADR records an **exemption kind, `welcome_read`**: untrusted-origin, inferred-only memory rows, written by the welcome
job's code, with no tool and no action. #1494's law needs no change, because no tool call is involved.

## 5. App contract (additive; posted on waldo-app #138 before merge)

**Read: `GET /app/v1/controls?view=constellation`.**

- `memory_view=summary` gains an optional `welcome` key:
  `{ state: 'not_started' | 'building' | 'done', started_at, finished_at|null, stages: { health, calendar, mail, web } }`. Each
  stage is one of `pending | reading | done | empty | unavailable | revoked | skipped`, and the stage list itself never grows.
  The app polls `summary` every 3 s while `state === 'building'`, up to 3 minutes, then reads `interpretations`.
- Each interpretation node gains an optional `sources` key: an array of `apple_health | health_connect | calendar | tasks | gmail`,
  taken from its supports' `source_ref`. It is empty for a nightly node backed by owner words.
- Each interpretation node gains an optional `confirmation`: `'waldos_read' | 'confirmed'`. It is `confirmed` when every support
  is owner-grounded. The app can replace its hardcoded "Unverified" badge with it.
- An old build drops all three keys (tolerant reader). No existing field changes, and no value is added to an existing enum.

**Act: `POST /app/v1/actions`, constellation view, beside M-8's claim actions.**

- `node.confirm`, `id: memory:node:<n>`: owner-grounds each support claim (#1498's `ownerGround`, with `source_ref`
  `owner, app:node.confirm`).
- `node.correct`, `id`, `value` (1–140 characters): writes an owner-stated claim with the owner's text, replaces the node's
  label and summary with it, re-points the node's support to that claim, and purges the old supports.
- `node.forget`, `id`: barriers the label and each support's text, purges the supports, and calls `forgetNode`.
- **Revision:** if M-8 merges first, these join `controls=2`'s action list as a later revision (`controls=3`). If this merges
  first, they ship under `controls=2` and M-8 rebases. The gate orders it. Receipts use the existing `appControlResultV1Schema`.
- **Step-up:** `node.correct` writes the owner's word, so it follows M-8's app ruling (app session authority, no separate
  step-up). `node.forget` and `node.confirm` are not gated, matching `spot.unpin`.

**Until the app ships `node.*`:** today the app corrects a node by drafting a chat message ("That's not right"). It has no
node actions, and gets none until it re-pins. Chat is therefore the real path for the cohort. A chat ask to forget a welcome node goes through the in-turn `forget_memory` tool (`tools/live/memory.ts:124-175`):
- the tool barriers the topic and the selected support texts, and purges those claims;
- the purge's `constellation_refs` pass then deletes any node left with no live support.

The rerun is the owner's own act. Test 12 checks that a rerun after a chat forget does not bring the node back. If paraphrase
gets past the barrier there, the welcome admission also checks each proposed label against the barriers. That is a hard
check, not judgment. A chat
correction goes through `remember` with `replaces_id` on the support claim. Both are tested (test 12).

**Web items:** the gift reads `/app/v1/findings` as it stands, and keep, correct and forget go through `/app/v1/findings/actions`.

**The gift screen:** the app has none today. "What Waldo knows" is the only constellation screen. The app lane decides where the
gift appears. The contract above is all it needs.

## 6. Privacy: notice delta, consent, deletion

Additions to the privacy notice copy (the notice is still unpublished, P0-3):

- **Welcome build.** When you finish setup, Waldo reads your connected sources once to build a starting picture of you:
  - the last 30 days of health readings, as patterns and never numbers;
  - calendar and task titles across your connected Google accounts;
  - who you have emailed with in the last 90 days, and the subject lines, never message contents;
  - with your separate yes, public web pages about you.

  It stores short phrases and pointers, not copies. You can confirm, correct or forget each item.
- **Look-up.** This is unchanged from notice copy 1. Findings stay unconfirmed and are deleted after 30 days unless you keep
  them, and withdrawing your yes erases them all.
- **Owner profile (#1534).** Kept and corrected items become part of the profile Waldo reads every time it replies.

Consent and deletion:

- **Consent:** no new purpose. Health uses the health plane's live `model_processing` and `storage_compute` grants. Mail and
  calendar use the Google grant. The web uses `owner_lookup`.
- **Deletion:** a forget barriers and purges, as in section 3. Withdrawing `owner_lookup` erases findings (existing behaviour).
  Withdrawing health consent stops the stage. Withdrawal does not need to scrub already-written health nodes, because they
  hold no values. They are deleted with a forget, or with the account (ADR-0055).
- **Model egress:** health values reach the auxiliary model only inside the untainted health call, under live
  `model_processing` consent. Every welcome call uses a metadata-only `memory_welcome_*` purpose, so no input or output text
  reaches a trace (section 2.1). A test checks that no trace entry, and no DO table, holds a welcome call's input or raw
  output.

## Build plan (step 2, after gate approval), red tests first

| # | Test (red first) | Proves |
|---|---|---|
| 1 | A fresh app-only owner with no chat yet: the setup trigger binds the app subject and the welcome job is admitted | the cohort case does not throw `ClosedRunError` |
| 2 | `start` twice, and `complete` plus answers: one `welcome_builds` row and one scheduled job | the trigger runs once per owner |
| 3 | Health: `consent_required`, `withdrawn`, no readings, a read failure, and a late-data rerun (once only) | empty and revoked paths |
| 4 | Calendar and mail: no Google, a missing scope, `invalid_grant`, two accounts each read with an explicit `account` | empty, revoked and multi-account paths |
| 5 | Web: lookup off, not offered, or consent missing gives `skipped`; on, findings are recorded and no node row is written | the web gate, and one representation |
| 6 | A model node with a digit, or with a spelled-out health value, is dropped and counted. No DO table and no trace entry (with capture on) holds the health input or the raw model output. The health call carries `source_taint: null` and no other source's text. | no digits; ADR-0081; trace egress |
| 7 | Nodes from mail and calendar: support origin `untrusted`, never in `recall()`, never pinnable; no tool dispatch in the job | tainted-text handling |
| 8 | `node.forget` barriers the label; a rerun with the same model output writes nothing; the node is gone from app, chat block and nightly input | forget |
| 9 | Nightly `applyPromotion` leaves a welcome node untouched | nightly coexistence |
| 10 | Contract: valid and invalid pairs for `welcome`, `sources`, `confirmation` and the `node.*` actions; an old schema parses the new response with keys stripped | app projection |
| 11 | A chat turn after the build carries `<owner_constellation>` within budget, and no web finding text | chat honesty |
| 12 | The owner says "forget X" in chat about a welcome node: it is gone from the app and the chat block, and a rerun does not bring it back | the chat path the app uses today |

Files: a new `packages/runtime/src/onboarding/welcome.ts` (the deep module: `start`, `run`, `progress`, admission); small hunks in
`memory/claims.ts` (the chat block), `channels/memory-graph.ts` (`sources` and `confirmation`), `channels/app-controls.ts`
(`node.*`), `contracts/src/app/controls.ts`, `first-run.ts` (one call), plus one `welcome` responder method in `owner-turn.ts` and
the wiring in `owner-do.ts`. Both hot files get small hunks only.

## Open questions for the gate

1. **Trigger:** this note proposes building on top of #1547's answers route. Merge #1547 first, or wire only `complete` now and
   the answers hook in a follow-up?
2. **Action revision order** against M-8 (#1501).
3. **App binding at setup (section 1):** binding the app subject on the setup route, before any chat. Is that acceptable, given
   that it also makes the owner's other scheduled jobs (Brief, nightly) admissible from setup on?
4. **The `<owner_constellation>` block:** is 1,200 characters on every turn acceptable, or should it be recall-only?
5. **Look-up in the cohort:** P0-3 is unpublished, so the web stage ships `skipped` until the notice and `OWNER_LOOKUP=1` land.
