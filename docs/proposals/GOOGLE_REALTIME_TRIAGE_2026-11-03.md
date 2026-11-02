# Real-time Google change capture and triage (design, 3 November 2026)

Status: **proposed, building behind `GOOGLE_REALTIME_TRIAGE` (default `0`)**. Paths are under `packages/runtime/src/` unless
they say otherwise. Tags: [verified] read in source at `beta-mvp` `76fe6509` or in Google's reference docs on 3 Nov;
[inference] my reading; [proposed] this change.

This is the sensing layer of the proactive concierge loop ([#1823](https://github.com/waldoco/waldo-backend/pull/1823),
§4.4 "Act: event-driven offers", slice P5). It does not add a second brain: it sharpens what the existing update sweep
reads, and gives the existing update turn a wider, typed choice.

## 1. What is there today [verified]

| Piece | Where | Behaviour |
|---|---|---|
| Gmail watch | `connectors/google-push.ts`, `channels/gmail-push.ts` | `users/me/watch` on `INBOX` via Pub/Sub. A push stores its `historyId` only as a replay fence (`admit`), then pulls the sweep forward. |
| Calendar watch | `channels/calendar-push.ts` | One `events/watch` on `primary`. A push pulls the sweep forward (`wakeBriefSweep`, 60 s gap). |
| Upkeep | `channels/watch-upkeep.ts` | Hourly; renews a day before expiry, retries 6 h after a miss. |
| Change read | `channels/update-cards.ts` `readChanges` | Time watermarks: Calendar `updatedMin` on `primary` only, Gmail `in:inbox category:primary after:` (10 messages). |
| Judgment | `channels/update-sweep.ts` | Changes recorded in `update_cards`; a reader job; an apply turn that chooses `revise` / `say` / `push` / nothing (with `WALDO_DAY_STATE`). Unchosen changes stay for the next main card (`unfolded`). |
| Gates | `owner-do.ts` `sweepGate` | Owner preference, volume, quiet hours, WhatsApp window; 5-min judge debounce. No daily interrupt budget for update cards. |

Gaps: no Gmail `history.list`, no Calendar `syncToken`, only `primary` is watched or read, label changes (read, archived)
are never seen, and the update turn cannot raise an action card when mail follow-ups are on (#1823 §1).

## 2. Design

### 2.1 State owner

OwnerDO stays the only writer. Everything new lives in its SQLite, written by the update sweep inside the transaction
that already commits the change record and watermarks (`updateSweepCheck` → `transaction`). No new service, no Supabase
table, no new store of record.

| State | Where (DO SQLite) | Writer |
|---|---|---|
| Gmail cursor (`historyId`) | `watch_state` key `cursor:mail` (existing key/value table) | update sweep, in the record's transaction, compare-and-set |
| Calendar `syncToken` per calendar | `watch_state` key `cursor:cal:<calendarId>` | same |
| Delta dedupe (`msg:<id>`, `evt:<id>:<etag>`) | `google_delta_seen`, created by the update book like `observed_mail` (no DO migration), pruned after 14 days | same |
| Calendar channel per calendar | `calendar_channels` KV book on the owner's object | watch upkeep (start, renew, stop); push admission (message number) |
| Interrupt budget and cooldown | `watch_state` keys per owner-local day | the triage apply's delivery transaction |

A cursor moves only if it still holds the value the read started from (`CursorMovedError` rolls the whole write back,
code `held_cursor_moved`), so a slow read can never overwrite a newer cursor. The time watermarks (`mail_since`,
`calendar_since`) keep moving every tick: they bound the older-way gap read.

The push `historyId` stays a fence only: the cursor that `history.list` starts from is the one the sweep last
committed, so a lost or reordered push costs latency, never data. Pushes are hints; the 10-minute poll keeps running.

### 2.2 Exact deltas [proposed]

- **Gmail:** `users.history.list(startHistoryId, historyTypes=messageAdded,labelAdded,labelRemoved, maxResults=100)`,
  at most 5 pages. Added messages in `INBOX` (not `SPAM`/`TRASH`/`DRAFT`/`SENT`, and `category:primary` as today, for
  cost parity) are fetched as metadata (`mailPromptProjection`: from, subject, snippet, time). Label changes on
  `UNREAD`, `INBOX`, `STARRED`, `IMPORTANT` become `read` / `archived` / `starred` changes on messages already seen.
  More than the cap: the cursor still moves to the response's `historyId` and the batch says how many were left out.
- **Calendar:** `events.list(calendarId, syncToken, showDeleted, singleEvents=false, maxResults=250)`, at most 8 pages,
  per calendar the owner reads (§2.3). `singleEvents=false` keeps a baseline finite: an endless daily series is one
  master, not unbounded instances. So a series change is one change flagged `series` (it counts as touching today for
  the Weight recompute and re-plan); an edited or cancelled instance is its own change with its own times, as today.
  An invite is a change flagged `invite` (the owner is an attendee with `needsAction` and not the organizer).
  Google lists changes in no time window, so only events in the read window, events the owner was shown before
  (last-seen), and series are news; a far-off event or the cancellation of one never shown is not. The existing
  last-seen table still supplies `before`.
- **Expiry and resync (bounded):** Google documents `404` for an out-of-date `startHistoryId` and `410` for an invalid
  `syncToken` [verified, reference docs]. Either one re-baselines silently: Gmail takes the current `historyId` from
  `users.getProfile`; Calendar re-lists from `timeMin = now − 1 day` (allowed on the initial list, not with a token
  [verified]) within the same page cap, and emits nothing from the baseline. The gap is then read **once** with the
  existing time-watermark read for that source, so nothing is lost and nothing is replayed. A calendar whose baseline
  exceeds the cap stays on the time-watermark read and is logged `sync_capped`.
- **Dedupe:** by message id and by event id + etag, in `google_delta_seen`, so a re-baseline overlap, a gap read and a
  redelivered push never produce the same change twice. Within one batch an event seen on two calendars is one change.
- **Fallback:** a delta read that throws (an older proxy without the method, a provider error) leaves that cursor where
  it was and reads that source the older way this tick. Dedupe makes the later overlap exact. One calendar that cannot
  be read at all (gone, unsubscribed, no access) keeps its cursor and holds no other calendar back; only when every
  calendar fails does the tick fail as before, with nothing moved.
- **Owner actions on mail** (read, archived, starred), for a mail already seen, ride along as context in the batch and
  the next main card. They never start a judgment on their own: the owner already acted.
- **Proxy:** the reads are two new `GoogleClient` methods (`mailDelta`, `calendarDelta`) in `GOOGLE_METHODS`, so a
  Vault-backed grant reaches them through `connector-proxy` (which also checks the calendar scope for `calendarDelta`).

### 2.3 Every calendar the owner reads [proposed]

- The set is the same one lane A's Weight read uses (`health/calendar-demand.ts`): `calendarList` items that are
  `selected && !hidden`, with role `reader`, `writer` or `owner` (`freeBusyReader` cannot list events), capped at 20.
- Each gets its own channel (`events/watch` on that calendar id), renewal and failure backoff. A calendar Google will
  not watch (subscribed and holiday calendars may refuse; the push guide does not say which [verified: not documented])
  is marked `unwatchable` and kept on the 10-minute poll with its `syncToken`; it never blocks the others.
- The proxy gets a new op, `events_watch`, taking a calendar id. An older proxy answers `unknown operation`, which the
  upkeep records as a failed start, so no calendar is ever watched as `primary` by mistake.
- A calendar the owner unselects or loses is stopped at the next upkeep, its cursor and channel row dropped.

### 2.4 The triage turn [proposed]

One turn per batch, which is the existing update-sweep apply turn (5-minute debounce, one job open at a time). With the
switch on it gets:

- **Context:** the delta (tainted external, fenced as data), the ledger, today's day cards and plan, today's calendar,
  the owner's goal and people claims (owner memory, as the turn already reads), and the health log lines the turn
  already receives (zones and words only, never numbers).
- **One choice**, as typed JSON: `act` (raise a card through `propose_action`), `tell` (say, or revise a day card, with
  an optional push), `brief` (keep it for the next main card, today's default), or `silent` (noted; the next card does
  not carry it). The model decides; there is no importance rule in code.
- **What code enforces, and only this:**
  1. dedupe (§2.2);
  2. quiet hours: `tell` becomes `brief`, `act` waits as `brief` (the existing quiet rule; a revision still lands);
  3. a per-day interrupt budget and cooldown, counted per owner-local day: **2 a day, 60 min apart** (#1823 §9
     decision 1 proposes "+2 event offers a day"); over budget, `tell` and `act` become `brief`. This is a small book
     beside the update cards, not an ADR-0068 push class: `push_class` is part of the public DTO and the app's
     notification contract, so a new class is a cross-repo contract change. #1823 P6 ("everything through the gate")
     is where update cards move onto ADR-0068, and this budget folds into it there;
  4. one notification per batch: at most one push, and `act` and `tell` never both notify;
  5. the turn sees how much budget is left, and `propose_action` is in its tool manifest only while budget admits an
     interrupt (smallest per-turn capability manifest), so a card can never outrun the budget.
- **Taint:** the turn stays `external`. Mail text never becomes an owner fact, a standing permission or an instruction;
  `act` is only ever a card the owner approves. The push line stays code-written (`updatePushLine`).

### 2.5 Evals [proposed]

`evals/nightly/triage-scenarios.ts`: labelled synthetic deltas (`interrupt`, `brief`, `silent`, `act`), every person,
address and event synthetic, run through the production triage prompt. Receipts check the chosen decision and that
`act` raised exactly one card and `silent` / `brief` raised none. No wording is pinned. Wired into the nightly catalogue.

## 3. Privacy and egress

- **New egress:** `gmail.googleapis.com` history and message *metadata* (format `metadata`, the headers already read
  today), and `www.googleapis.com/calendar` event lists for each read calendar. Same scopes as today (`gmail.readonly`
  or narrower is not added; existing mail and calendar grants). No body is fetched by the sweep.
- **Model egress:** the same update turn, the same provider route and taint as today. More calendars means more event
  titles and attendees reach the turn, within the owner's grant (CLAUDE.md: full context within the owner's boundary).
- **Stored:** cursors, channel ids, message and event ids with etags. No subjects, titles or bodies are added to storage
  beyond today's `update_cards` record. Logs carry codes and counts only.
- **Health:** unchanged. The turn gets zone words; no reading is persisted or logged by this path.

## 4. Cost per owner per day [inference]

Assumptions: an active owner, 60 inbox mails and 15 calendar changes a day across 5 calendars.

| Item | Volume | Cost |
|---|---|---|
| Google API calls | ~300 history/list + metadata calls, ~150 calendar delta pages, ~5 channel renewals | free within default quota (Gmail 1B units/day project-wide; history.list 2 units, messages.get 5 units) |
| Triage turns | bounded by the 5-min debounce (≤ 288), realistically 20–40 batches | ~8k input + 300 output tokens each, mostly cached prefix |
| Model spend | 30 turns × ~$0.01–0.03 (Sonnet-class, cache reads) | **~$0.30–0.90/day**; worst case (288 turns) ~$5 |
| Reader job | today's sweep already runs one per batch | unchanged |
| DO storage | < 50 KB of cursors and dedupe keys | negligible |

The debounce, not the push rate, bounds model cost: a burst of 50 pushes in 5 minutes is one turn.

## 5. Failure modes

| Failure | Behaviour |
|---|---|
| Push lost, late or out of order | The 10-minute poll reads the same cursor; nothing lost. |
| `historyId` too old (404) / `syncToken` invalid (410) | Silent re-baseline + one bounded time-watermark gap read (§2.2). |
| Baseline over the page cap | That calendar stays on the time-watermark read, logged `sync_capped`. |
| A calendar refuses a watch | `unwatchable`, polled; others unaffected. |
| Old connector-proxy deployed | New methods/op rejected → time-watermark read and failed watch start; logged. |
| Provider down mid-read | No transaction runs; cursors unmoved; the next tick reads the same window. |
| Model returns invalid JSON | `brief`: the changes stay for the next card (`effects_invalid` logged). |
| Owner over budget / quiet hours | `tell` and `act` become `brief`; logged as `downgraded:<reason>`. |
| Forget in flight (held topic) | The existing `held_topic` rollback keeps cursors unmoved too. |

## 6. Rollback

Set `GOOGLE_REALTIME_TRIAGE=0`. The sweep returns to the time-watermark read and today's effects prompt; the new tables
are left in place and ignored (no migration, all `CREATE TABLE IF NOT EXISTS`). Per-calendar channels lapse within 7 days
and their pushes are ignored by the `primary` book; upkeep re-arms the `primary` channel. No contract field is removed
and none is added.

## 7. Decisions that depend on the owner's #1823 §9 answers

- **§9.1 budget:** the interrupt budget (2/day, 60 min cooldown) is two constants, changed in one place.
- **§9.2 the Close may ask:** not needed here.
- **§9.7 Waldo's own calendar:** if approved, `act` on a scheduling change could write a block there without a card;
  this build keeps every `act` a card.
- **Not in §9, raised here:** whether promotions/social mail should reach triage at all (kept at today's
  `category:primary` scope for cost parity).

## 8. Deploy order (not done by this PR)

1. Deploy `connector-proxy` (new methods and the `events_watch` op).
2. Deploy the Worker with `GOOGLE_REALTIME_TRIAGE=0`.
3. Set `GOOGLE_REALTIME_TRIAGE=1` on staging for one owner; watch `google_delta`, `update_triage` and `watch_upkeep` logs.
