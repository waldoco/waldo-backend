# Real-time Google change capture and triage (design, 3 November 2026)

Status: **built behind `GOOGLE_REALTIME_TRIAGE` (default `0`), for review**. Paths are under `packages/runtime/src/` unless
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
| Gmail cursor (`historyId`) per account | `watch_state` key `cursor:mail:<account>` (existing key/value table) | update sweep, in the record's transaction, compare-and-set |
| Calendar `syncToken` per account and calendar | `watch_state` key `cursor:cal:<account>:<calendarId>` | same |
| Last read and waiting push per source | `watch_state` keys `read:<source>` and `pending:<source>` | the sweep (read time; clears a push only if it is the one the read began with); push admission (marks a source) |
| Delta dedupe (`msg:<id>`; `evt:<id>` with the digest of the version last shown) | `google_delta_shown`, created by the update book like `observed_mail` (no DO migration), pruned after 14 days | same |
| Calendar channel per account and calendar | `calendar_channels_v1` KV book on the owner's object, entries by account then calendar | watch upkeep (start, renew, stop); push admission (message number) |
| Gmail watch per mail account | `gmail_watches_v1` KV book, entries by account (connection id) | watch upkeep; push admission (history id) |
| Calendars read per account | `realtime_calendars_v1` KV, entries by account | watch upkeep (from each account's calendar list) |
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
  More added messages than the open cap (20): the newest are opened and the batch says how many were left out (a cost
  bound beyond the accepted four, listed in §7). More history than the page cap: every page carries the mailbox's
  current `historyId`, not the last record's, so moving there would skip what was not read; the read is `capped`
  instead: the cursor moves to the current id and the gap is read once the older way, like a re-baseline.
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
- **Dedupe:** by message id, and by event id plus a digest of what the owner is shown of the event (status, times,
  title, location, description, attendees, series), in `google_delta_shown`. Each event keeps only the version last
  shown, so a re-baseline overlap, a gap read, a redelivered push, and the same meeting on two accounts' calendars (each
  copy has its own etag and link) never produce the same change twice, while a change back to an earlier version (moved
  back, or restored after a cancel) is news again. A new etag that changes nothing the owner is shown is no longer
  news. Within one tick, when one account's copy is an invite still to answer, that copy is the one read; across
  ticks, an invite copy read after another copy of an unchanged meeting is deduped [known limit].
- **Fallback:** a delta read that throws (an older proxy without the method, a provider error) leaves that cursor where
  it was and reads that source the older way this tick. Dedupe makes the later overlap exact. One calendar that cannot
  be read at all (gone, unsubscribed, no access) keeps its cursor and holds no other calendar back; only when every
  calendar fails does the tick fail as before, with nothing moved.
- **Owner actions on mail** (read, archived, starred), for a mail already seen, ride along as context in the batch and
  the next main card. They never start a judgment on their own: the owner already acted.
- **Proxy:** the reads are two new `GoogleClient` methods (`mailDelta`, `calendarDelta`) in `GOOGLE_METHODS`, so a
  Vault-backed grant reaches them through `connector-proxy` (which also checks the calendar scope for `calendarDelta`).

### 2.3 Every connected account, every calendar the owner reads [proposed]

- **Accounts (owner ruling, 3 November):** every connected account that holds the grant, up to `MAX_ACCOUNTS_PER_READ`
  (5), in connect order. Each account is read through its own client, and every cursor, read time and waiting push is
  kept per source (`mail:<account>`, `cal:<account>:<calendar>`). An account whose grant is failing waits for its probe;
  one whose read fails keeps its cursors and its watermark (the shared one moves on with the others), and is due again
  at the next tick. The tick fails only when every source due fails. Each change names the account it came from, for
  the model only (never logs): the triage prompt asks the model to pass it as the card tool's `account`, which
  `send_email`, `draft_email` and `propose_calendar_change` already route by. Only mail from the account a follow-up
  reads through can open a source follow-up, since `source_ref` carries no account.
- **When a source is read:** when a push marked it, or when its last read is 9 minutes old (so the 10-minute sweep reads
  every source, and a push-woken sweep reads only what the push named).
- The calendar set is the same one lane A's Weight read uses (`health/calendar-demand.ts`): `calendarList` items that are
  `selected && !hidden`, with role `reader`, `writer` or `owner` (`freeBusyReader` cannot list events). At most 20
  calendars are read across all accounts: each account's primary first, then the others in account order.
- Each gets its own channel (`events/watch` on that calendar id), renewal a day before expiry, and its own 6-hour
  backoff after a failed start. A calendar Google will not watch (the push guide does not say which refuse [verified: not
  documented]) just keeps failing alone and is read on the 10-minute poll from its sync token; it never blocks the others.
- On the first upkeep with the switch on, the older primary channel moves into the per-calendar book under the account
  it was started on, and the older book is left empty, so primary is never watched twice and a rollback starts a fresh
  primary channel at the next upkeep.
- **Routing.** A Calendar channel's token still names only the owner; its stored row names the account and calendar,
  so a push marks just that source. A Gmail push is routed by its `emailAddress` through the connections table to
  `(owner, connection)` as today; the owner's object marks that account's mailbox, and drops a connection no connected
  account holds with code `unknown_account`. One Gmail watch per mail account; an account held the older way (a raw
  token here) has no connection row, cannot be watched, and is read on the poll.
- **Disconnect** stops that account's calendar channels while its grant can still stop them, forgets its Gmail watch
  (Gmail lets it lapse) and drops only its cursors, read times and waiting pushes. A reconnect clears that account's
  failed watches at once; one that comes back under a new connection forgets the old connection's books and cursors.
- **Host fact:** the watch status line names each account not being watched (by address, in the owner's turn only).
- The proxy gets a new op, `events_watch`, taking a calendar id. An older proxy answers `unknown operation`, which the
  upkeep records as a failed start, so no calendar is ever watched as `primary` by mistake.
- A calendar the owner unselects or loses is stopped at the next upkeep, its cursor and channel row dropped.

### 2.4 The triage turn [proposed]

One turn per batch, which is the existing update-sweep apply turn (5-minute debounce, one job open at a time). With the
switch on it gets:

- **Context:** the delta (tainted external, fenced as data), the ledger, today's day cards and plan, today's calendar,
  the owner's goal and people claims (owner memory, as the turn already reads), and the health log lines the turn
  already receives (zones and words only, never numbers).
- **One choice**, as typed JSON: `act` (raise a card), `tell` (say, or revise a day card, with an optional push),
  `brief` (keep it for the next main card, today's default), or `silent` (noted; the next card does not carry it). The
  model decides; there is no importance rule in code.
- **Act is what the turn did.** A card is raised by a tool call mid-turn, so code counts the approval rows the turn
  created: any card makes the outcome `act`, whatever the JSON said, and a message beside it is not sent (the card is the
  notification). `act` with no card is left for the next main card. The card tools are `send_email` and
  `propose_calendar_change` (each raises its own card) and `propose_action` for any other tool: in a job that read
  outside text the first two are refused through `propose_action`, so `act` needs them in the manifest directly.
- **What code enforces, and only this:**
  1. dedupe (§2.2);
  2. quiet hours: `tell` becomes `brief`, `act` waits as `brief` (the existing quiet rule; a revision still lands);
  3. a per-day interrupt budget and cooldown, counted per owner-local day: **2 a day, 60 min apart** (#1823 §9
     decision 1 proposes "+2 event offers a day"); over budget, `tell` and `act` become `brief`. This is a small book
     beside the update cards, not an ADR-0068 push class: `push_class` is part of the public DTO and the app's
     notification contract, so a new class is a cross-repo contract change. #1823 P6 ("everything through the gate")
     is where update cards move onto ADR-0068, and this budget folds into it there;
  4. one notification per batch: at most one push, and `act` and `tell` never both notify;
  5. the turn sees how much budget is left, and the card tools are in its manifest only while quiet hours, the budget and
     the cooldown all admit an interrupt (smallest per-turn capability manifest), so a card can never outrun the budget.
     A revision in place is no interrupt and still lands silently when an interrupt is held.
- **Taint:** the turn stays `external`. Mail text never becomes an owner fact, a standing permission or an instruction;
  `act` is only ever a card the owner approves. The push line stays code-written (`updatePushLine`).

### 2.5 Evals [proposed]

`evals/nightly/triage-scenarios.ts`: eight labelled synthetic batches, two each `interrupt` (= `tell`), `act`, `brief`
and `silent`, every person, address and event synthetic, run through the production triage prompt by a new `triage`
trial step (tainted external, card tools offered). The trial records the decision as the owner object derives it, and
receipts check the label and the card count (one for `act`, none otherwise); an unreadable reply is recorded `invalid`
and never stops a trial. No wording is pinned; the judge grades the words. In the nightly catalogue under the unused
`g` prefix; `GOOGLE_REALTIME_TRIAGE` is listed as a staging-profile gap for the sweep itself.

## 3. Privacy and egress

- **New egress:** `gmail.googleapis.com` history and message *metadata* (format `metadata`, the headers already read
  today), and `www.googleapis.com/calendar` event lists for each read calendar. Same scopes as today (`gmail.readonly`
  or narrower is not added; existing mail and calendar grants). No body is fetched by the sweep.
- **Model egress:** the same update turn, the same provider route and taint as today. More calendars means more event
  titles and attendees reach the turn, within the owner's grant (CLAUDE.md: full context within the owner's boundary).
- **Stored:** cursors, channel ids, connection ids, message ids and event ids with a content digest. No subjects, titles or bodies are added to storage
  beyond today's `update_cards` record; each change in it now names the owner's own account address it came from, so the
  turn can act from that account. Logs carry codes and counts only: never an address, a connection id or a calendar id.
- **Health:** unchanged. The turn gets zone words; no reading is persisted or logged by this path.

## 4. Cost per owner per day [inference]

Assumptions: an active owner, 60 inbox mails and 15 calendar changes a day across 5 calendars.

| Item | Volume | Cost |
|---|---|---|
| Google API calls | the 10-minute poll reads each source once: (mailboxes + calendars) × 144. One account with 5 calendars ≈ 860 a day; at the caps (5 mailboxes + 20 calendars across accounts) ≈ 3,600, plus one read per push, metadata reads for new mail (~60 per mailbox) and renewals | free within default quota; each account has its own per-user rate limit, so spreading calendars over accounts does not concentrate load |
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
| A calendar refuses a watch | That calendar backs off 6 h and is polled; others unaffected. |
| One account's grant fails | Its sources keep their cursors and watermark and are read again next tick; other accounts proceed; its watches back off and the host fact names it. |
| A push for an account no longer connected | Dropped with `unknown_account` (Gmail) or ignored (a forgotten calendar channel). |
| Old connector-proxy deployed | New methods/op rejected → time-watermark read and failed watch start; logged. |
| Provider down mid-read | No transaction runs; cursors unmoved; the next tick reads the same window. |
| Model returns invalid JSON | `brief`: the changes stay for the next card (`effects_invalid` logged). |
| Owner over budget / quiet hours | `tell` and `act` become `brief`; logged as `downgraded:<reason>`. |
| Forget in flight (held topic) | The existing `held_topic` rollback keeps cursors unmoved too. |

## 6. Rollback

Set `GOOGLE_REALTIME_TRIAGE=0`. The sweep returns to the time-watermark read and today's effects prompt; the new tables
and KV books are left in place and ignored (no migration, all `CREATE TABLE IF NOT EXISTS`). With the switch off the
per-account channels and Gmail watches wake nothing and mark nothing, and lapse within 7 days; upkeep re-arms the older
`primary` channel and the first account's Gmail watch. No contract field is removed and none is added.

## 7. Decisions that depend on the owner's #1823 §9 answers

- **§9.1 budget:** the interrupt budget (2/day, 60 min cooldown) is two constants, changed in one place.
- **§9.2 the Close may ask:** not needed here.
- **§9.7 Waldo's own calendar:** if approved, `act` on a scheduling change could write a block there without a card;
  this build keeps every `act` a card.
- **Not in §9, raised here: deterministic filters beyond the five the brief allows** (dedupe, quiet hours, budget,
  one notification, cooldown). Each is a read-scope parity or cost bound, not an importance rule; the gate rules on each:
  1. mail outside the inbox's primary tab (and sent, drafts, spam, trash) never reaches triage: today's `newMail` scope;
  2. delta events outside the read window (a day back to two weeks ahead), and cancellations of events never shown,
     are not news: today's window and last-seen rule, since Google's deltas carry no window;
  3. a batch of only owner actions on mail (read, archived, starred) starts no turn: the owner already acted;
  4. at most 20 calendars are read and watched: a cost and rate-limit bound.
  5. raised by the gate review: more than 20 new mails in one mailbox read are opened newest first, and the rest become a
     count (`more`): a cost bound.
- **Accounts:** ruled 3 November: every connected account with the grant, up to 5 (§2.3). The gate accepted the four
  filters above as scope and cost bounds, and the 20-calendar cap counts across accounts.

## 8. Deploy order (not done by this PR)

1. Deploy `connector-proxy` (new methods and the `events_watch` op).
2. Deploy the Worker with `GOOGLE_REALTIME_TRIAGE=0`.
3. Set `GOOGLE_REALTIME_TRIAGE=1` on staging for one owner; watch `google_delta`, `update_triage` and `watch_upkeep` logs.
