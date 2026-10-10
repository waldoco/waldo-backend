# Owner proactivity integration

This module uses the existing owner Durable Object, model path, connector custody,
responsibility ledger, scheduler, and final outbox. It has no connector credentials,
effect authorization engine, source-body store, or independent agent process.

Construct `createProactivityBook(storage.sql, { ownerKey, now, newId,
transaction: work => storage.transactionSync(work) })` from the authenticated owner
DO. The owner key comes from host identity. Expose `policy`, `sourcePolicy`, `watches`,
and `deliveries` as owner-authenticated projections; never accept a caller-selected
owner. Policy and watch controls require their current revisions. Owner correction
updates the existing responsibility revision and then calls `reviseWatch`; cancelling
or explicit evidenced completion calls `controlWatch`. Delivery does not close a goal.

`runProactivityCycle(book, ports, sources)` is one bounded alarm pass. Sources must be
the actual connected accounts and allowed collections, including Gmail-only accounts
and each allowed Calendar/Tasks list. Supplying only the default Calendar account
does not establish multi-account discovery. Default work bounds are four pages per
source, twenty wakes and twenty delivery candidates. Incomplete pages are resumed
from persisted tokens. Cursor expiry must raise `SourceCursorExpired`, which removes
the invalid cursor and makes the next pass rebuild the selected source baseline.

The host ports supply:

- `admit(source, purpose)`: recheck current authenticated owner, connector grant,
  source/account and permitted purpose. Return the connection's current epoch,
  `connected`, and `available`. A temporary expired access token uses
  `connected: true, available: false`; an actual disconnect uses a new epoch and
  `connected: false`. A disconnected epoch cannot reconnect itself. This local
  access record never grants OAuth or an effect.
- `fetchPage(sweep)`: use the account-pinned Google/client or existing source port.
  Preserve the exact query, collection and coverage bounds across every page.
  Return actual source object/revision/observation/deletion references and a
  continuation. Underlying relevant bodies remain retrievable through their
  existing source custody. A reference or snippet is not full source context.
- `discovered(coverage, observations)`: feed the accepted general sweep to the
  existing model/responsibility path without naming each target obligation. Read
  full relevant threads/documents, retrieve distinctive terms after a miss, and
  create or reuse responsibility-linked watches. Source requests never create
  owner commitments or standing grants.
- `checkCurrent(watch)`: reread the latest provider threads, receipts, task/calendar
  state and owner responsibility revision. Return full/partial coverage, open/
  handled/unknown status, exact source revisions, audience and evidenced references.
  Return unknown for absence that was not established by authoritative access. This
  receipt must be made by the host source/checking path, not accepted as a model
  authorization claim.
- `decide(watch, check)`: run the existing responder with full relevant current
  context plus `PROACTIVITY_DECISION_INSTRUCTION` and
  `PROACTIVITY_DECISION_SCHEMA`; decode with `parseProactiveDecision`. Notify,
  batch and silent are judgment outcomes. No tools for consequential effects are
  implied by this call.
- `enqueue(delivery)`: freeze the selected text in the existing owner result/outbox
  using `delivery.id` as its stable operation identity. Select its single explicit
  audience/surface. Return queued when durable outbox custody is accepted. Return
  delivered only after a usable app projection or an actual adapter ACK with an
  exact receipt reference. Outbound text still passes the existing sanitizer and
  audience gate; notification hints remain neutral device-policy presets.

At the actual final-outbox send boundary call
`proactivityDeliveryEligible(book, ports, deliveryId)`. It rereads current source,
responsibility and audience state before sending the frozen result. Settling the
outbox calls `settleDelivery(deliveryId, { state, receiptRef, reason })`; unknown
outcomes belong to the existing outbox/provider reconciler and never reenter a new
send. On restart call `recover()` only after the prior executor is no longer active;
checking wakes are readmitted while interrupted sends become unknown. Event sources
call `wake(watchId, stableEventKey, observedAt)` after their existing authenticated
admission. Source pages automatically detect matching resource changes. Renewal is
enumerated through `subscriptionsDue` and recorded with `renewSubscription`; time
fallback continues when a subscription expires or an event is lost.

The existing periodic collector is also repaired. Construct
`updateBook(storage.sql, work => storage.transactionSync(work))`. Its unchanged
`collectChanges(book, client, now, sourceFollowups)` call supports additive options
`{ accountId, calendarId, calendar, mail, maxPages }`. Use actual per-account scopes:
Gmail-only accounts set `calendar: false`; per-calendar calls keep `mail: false` after
the account's mail pass. `changedEventsPage` and `mailPage` retain continuation and
frozen time bounds. Completed changes enter an existing durable update card before
watermarks advance. The caller's `record(day, now, changes, null)` reuses that card.
Legacy capped readers refuse to claim completeness at the cap.

Local evidence commands:

```sh
pnpm --filter @waldo/runtime exec vitest run --config vitest.proactivity.config.ts
pnpm --filter @waldo/runtime exec vitest run test/update-cards-do.test.ts test/mail-follow-up.test.ts test/card-prompt-projection.test.ts test/proactivity-windows.test.ts
pnpm --filter @waldo/runtime typecheck:worker
```

The node configuration exercises real isolated SQLite state and synthetic provider
ports. Its isolated SQLite and Deno-edge `*-node.test.ts` files must be excluded from the Workers pool, and the
configuration included in the node CI gate. Real provider access, model quality,
source subscription renewal, app/native/channel delivery, staging deployment and
multi-day acceptance are separate evidence, not claimed by these local tests.

`channels/owner-proactivity.ts` now supplies these ports from actual Google clients.
Construct `createOwnerProactivity({ sql, book, updates, loops, responsibilities,
google, accounts, assertOwnerCurrent, audience, timezone, now, transaction, prompt,
enqueue })` in the owner DO. `accounts()` returns only `{ id, email, revision,
connected, available, features, calendarIds?, taskListIds? }`: the revision covers
current grants/resource policy and changes on disconnect/regrant. It must exclude
credentials and temporary token availability. `google` is the existing GoogleAccess;
all client acquisition and I/O are account-pinned and rechecked.

The adapter enumerates permitted Calendar and Tasks collections with durable page
continuation. Calendar grants lacking CalendarList scope use their existing explicit
primary read, and never claim other-calendar discovery. One unavailable account or
inventory remains a reported failure while independent accounts continue. Source
access changes invalidate dependent observations/watches, including collections with
no existing watch. Invoke `tick()` from the shared alarm, merge `nextWakeAt()` with
the existing alarm arbiter, and call `recover()` once after eviction. Keep the owner
DO as the only writer. Do not place this behind a Telegram-presence prerequisite.

`prompt(instruction, input, schema)` uses the existing responder, current composed
owner context, external-source taint and disabled text capture. Its discovery call
reads actual full source material, then produces bounded source-backed checking
hypotheses. They are adopted into existing loop/responsibility identities, preserving
why without creating owner facts or effect permission. Current companion Calendar
windows and Tasks collections are frozen with mail hypotheses and reread before
delivery; new completion/slot/source revisions fence the old result. Incomplete,
failed or omitted query coverage never proves absence. Large queries explicitly
remain partial after their per-invocation read budget; source baseline pagination
continues independently across alarms. The model remains responsible for relevance,
urgency, inference and notify/batch/silent judgment.

`enqueue` freezes a stable delivery ID in the existing outbox or usable app journal.
Its exact send/readback boundary calls `deliveryEligible(id)`; final receipt custody
calls `settle(id, receipt)`. Queued means custody, not delivery. Unknown attempts never
become a new send. Close only through the existing explicit-evidence responsibility
rules. Legacy source-loop nudges exclude adapter-managed loops so the same source
does not get two retry/delivery owners. Bridge existing `set_proactivity` preferences
into the book's owner/source policies at the controlling host: processing windows
are separate from quiet/notification windows, and the old followups/volume switches
must not be bypassed by this new serving seam.

The adapter's `owner-proactivity-node.test.ts` uses isolated real SQLite and synthetic
model/provider/outbox ports. It proves full scenario material reaches the model,
multi-account source correctness, fresh companion checks, withdrawal/correction,
restart, unchanged suppression and uncertain delivery custody. It does not establish
the quality of a real model discovery, a live Gmail/Calendar watch, push, a native
device, deployed admission or long-running acceptance. Include this Node test in the
Node CI gate and exclude it from the Workers pool.

## Fresh-session policy and lifecycle integration

The adapter now synchronizes the actual `loops.proactivity()` quiet hours, volume,
and follow-up opt-out before discovery, every provider guard, and final delivery.
It preserves the book's processing and notification windows. Follow-ups off stops
background source reads without deleting responsibilities; volume low retains
prepared work and suppresses unrequested sends. Explicit owner-set reminders use
the existing scheduler and do not inherit this source-follow-up switch.

`accountPolicy(accountId)` and `updateAccountPolicy(accountId, expectedRevision,
next)` define per-account policy. `sourcePolicy(source)` and
`updatePolicy(expectedRevision, next, source)` refine an exact collection. Owner,
account and collection restrictions all apply. Inventory reads use the owner and
account processing window before acquisition and before/after each page. A changed
processing regime fences in-flight page and model output even if the new window
also permits the current time. Notification changes hold delivery, never grant
source-body access. Versioned owner controls must actually consume these operations
before per-account controls can be claimed as available to a user.

A watch keeps the same existing responsibility while it is open, waiting or
uncertain. An exact revised responsibility or owner-edited loop fences prepared
output and readmits checking under the new revision. Evidenced closure satisfies
and cleans up its watch; absent or legacy closed-loop evidence cancels checking
without claiming completion. Regrant discovery never overwrites an owner-corrected
loop title or due date. Revoked source hypotheses are excluded from subsequent
background personalization while essential recovery identity remains retained.
The adapter's own continuation keys are now namespaced by canonical owner key.

Temporary source unavailability after a wake is claimed now defers that wake and
its next check. It no longer remains checking until eviction. Interrupted physical
sends still become unknown and remain under the existing outbox reconciliation
owner, with no new send. These are synthetic provider/transport proofs, not actual
WhatsApp or iMessage integrations.

Current source evidence is superseded by the fresh-session receipts below. Prior `vitest.proactivity.config.ts` receipt: 53 tests in 4 Node suites;
focused update-card, mail-follow-up, prompt, responsibility, heartbeat and window
Workers suites 60 tests in 6 suites. The root install, shared neutral alarm key,
actual authenticated background context, versioned policy controls, app/native
projection, subscription renewals and live providers remain separate integration
and acceptance evidence. The source adapter uses 20-page full-query reads and
16 related collections per discovery model pass; incomplete or omitted coverage
is explicit and cannot prove absence. These limits are not complete acceptance of
arbitrarily large relevant source material.


## Native personal day and manual source purpose

`channels/owner-day-plan.ts` uses the same authenticated Google source supplier and
actual calendar/task pages. `personal.v1` (`contracts/src/app/personal.ts`) defines
GET `/app/v1/personal/day`, optionally selecting a strict local date. It contains
calendar events, multi-account tasks, proposed buffers, exact source references,
coverage and six authored experiences: Brief, Window, Prep, Heads-Up, Close and
Adjustment. The legacy three chat cards remain separate. A read has no model spend:
it returns `source_only` until the authenticated producer actually authors the day.
`produce()` uses the existing responder judgment port and checks source revisions
again before durable publication. Model-selected references must exist in the
current source snapshot. An unchanged digest reuses the existing authored result.
Buffers are proposals, never booked or protected calendar time.

Install the manual day supplier with `sources: adapter.interactiveSources`,
`admit: adapter.interactiveAdmit`, and
`inventoryCoverage: adapter.inventoryCoverage`. These ports enforce current owner,
account grant, allowed collection and source epoch without using background follow-up
opt-out, processing windows or notification windows. A factory `purpose:
'interactive'` also selects this default read purpose and refuses `tick()`; it cannot
grant new background effects. Normal `ports.admit` always remains the background
policy port. A partial collection inventory exposes known authorized collections
and a separate unknown-collection receipt (`collection_ref: null`), while unavailable
accounts and inventories remain explicit unavailable receipts. Bounded manual
inventory snapshots remain stable for ten minutes during model/source rechecks;
background or subsequent refresh resumes the same persisted provider continuation.

`deliverMoment()` requires a prepared, current source-backed authored body, current
notification policy, and the host's usable journal/outbox receipt. Its stable
operation identity is persisted before dispatch. Interrupted delivery remains
unknown after restart and cannot become a new send. The final host boundary must
invoke the supplied `current()` before publication. A source-only projection is not
an authored Brief, and fake journal custody is not a native app delivery proof.

## Canonical background admission

`identity/owner-scheduler-admission.ts` admits `run_patrol` or `evaluate_fetch` from a
private verified owner/directory/scheduler lookup and a live `RunEffectScope` bounded
to at most fifteen minutes. Its binding contains owner UUID, canonical owner DO name,
physical DO ID, owner revision, source-retention revision, schedule identity/revision
and enablement. Each input read rechecks that exact tuple. The trusted scheduler
input is `runtime_metadata`, not an owner message, memory assertion, or effect grant.
`createOwnerTurnContext` consumes the resulting admission through its existing
composer. No Telegram identity or native health source participates in this helper.

## Configured Google subscriptions and real activation

Actual Google wire methods are `watchMail(topic)` and
`watchCalendarEvents(calendarId, channel)`. Server configuration must supply exact
`WALDO_GOOGLE_GMAIL_PUBSUB_TOPIC` and `WALDO_GOOGLE_CALENDAR_PUSH_URL` destinations;
missing configuration reports `source_push_unavailable`. Destinations cannot be
selected by a model or request. Existing router HMAC signs opaque Calendar witnesses
bound to owner, connection, collection, channel and source epoch. The edge rereads
current owner/connection grants immediately before provider watch registration,
including after token refresh, and after the receipt. A lost/invalidated registration
receipt remains unknown until expiry. No credentials or opaque channel tokens enter
adapter SQL; only subscription identity/resource/history/epoch/expiry custody does.

The host must independently verify the Calendar opaque token before
`calendarPush(witness, headers)`, then the adapter checks exact current channel,
resource, expiry, source epoch and numeric message sequence. Gmail caller admission
must verify Pub/Sub OIDC audience, service account and subscription before calling
`gmailPush({connectionId,email,historyId,eventId})`. Gmail notices are wake hints,
never source content. Renewal is bounded and persisted; polling/source recovery
continues when push is unavailable.

No approved Pub/Sub topic/publisher IAM/authenticated subscriber or trusted Calendar
HTTPS receiver was verified during this takeover. Real registration/renewal/event
activation is therefore unavailable until existing authority/configuration is
verified; this work does not provision credentials or expand access. Primary Google
requirements: [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push)
and [Calendar push](https://developers.google.com/workspace/calendar/api/guides/push).

## Full body completeness and local receipts

Gmail thread messages now report inline-body completeness, total character count,
omitted attachments and a source-bound body cursor. `messageBodyPage()` uses the
actual [messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
full MIME response and binds continuation to account, thread, message and current
provider payload. `read_thread` accepts `message_id` and `body_cursor`, separately
from thread-page continuation, and distinguishes current-page exhaustion from full
source completeness. Recognized verification artifacts remain within a single
page using metadata-only boundaries from the existing quarantine detector; actual
owner relay and model markers preserve their existing behavior. Oversized artifacts
that cannot fit a safe page report unavailable body coverage rather than fragments.
Proactivity consumes at most twenty body continuation pages per thread. Truncated,
unavailable, omitted attachment or other incomplete source material cannot establish
absence or produce a complete checking hypothesis. This is bounded recovery, not a
claim that every arbitrary-size thread or attachment is fully consumed.

Fresh local source receipts (2026-10-10, before root publication/review):

- Isolated SQLite proactivity/personal configuration: 78/78 in six Node files.
- Canonical scheduler admission and actual composer: 5/5 focused Node tests.
- Actual Gmail body wire/tool continuation and safe verification boundary: 5/5.
- Configured watch wire/edge scope and refresh-time revoke: 6/6 focused Node tests.
- Applicable Google wire/tool/collection/quarantine Workers tests: 91/91 in four files.
- Reads contract checks: 58/58. `git diff --check` passes.

These receipts include synthetic model, provider, transport and Deno authority ports;
they do not establish live model relevance, native app delivery, WhatsApp/iMessage
integration, deployed background admission, live push activation or multi-day
acceptance. Root owns the actual DO install, neutral alarm, current source callbacks,
app routes and final physical/journal delivery boundaries. Independent exact-head
review, aggregate checks, CI, staged release and real-user acceptance remain required.
Autonomous native-health planning is not wired: automatic approval review blocked
that new model action pending direct owner approval. Existing explicitly requested
health behavior stays in its separate reviewed serving path; raw health and private
health rationale are excluded from these durable projections and proactive sources.
