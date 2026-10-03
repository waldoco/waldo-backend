# Source-linked mail follow-up: bounded first slice

## Why build this

The owner requested thoughtful cross-service proactivity, beginning with mail, calendar and meetings. The existing update/card/loop lane already supplies model judgment, quiet settings, owner context and delivery. Its concrete gaps were discarded mail identity, no distinction between a source request and an owner commitment, and no durable verification path when a deadline approaches without new mail.

**Decision:** adapt that lane, not add another planner, scheduler, database, model provider or dependency. This slice covers one source-thread-linked follow-up hypothesis. Calendar enumeration, event briefs, ordinary owner loops and their existing scheduler remain in place. Value is fewer stale or invented obligations and a useful, neutral completion check. Actual supervision/time savings and production-model usefulness are not yet measured.

## Contract and ownership

- Observed thread/message IDs are owner-DO-local pointers. A source hypothesis is never an owner fact, promise or permission
- `open_loop.source_ref` is optional for existing owner calls. Restricted mail-background creation requires an observed reference. Completed/dropped source loops do not reopen automatically
- The source projection remains in existing `update_cards`; `observed_mail` contains only pointers, provider message time, current message ID and lifecycle markers. It does not duplicate subject/snippet/body storage
- Unattached observation pointers expire after seven days. Active loops retain their needed pointer until owner closure, then become eligible for cleanup. Existing update-card retention is unchanged; this is not a general health/sensitive-inbox readiness claim
- Stable provider message ID, deadline and timezone identify an occurrence. Duplicate polling of the same message does not regenerate source work. Newer thread evidence invalidates frozen older text
- Mail held during quiet hours, before the Brief or at low volume remains available for later judgment. The existing periodic update lane revisits due unknown-completion loops even without new mail
- One candidate is judged per eligible periodic check; a skipped candidate gets a 30-minute judgment backoff so it cannot starve other work. The existing responder's tool/round ceiling remains in force
- Restricted background tools intersect existing admission and trigger checks. They cannot send mail, make provider changes, draft externally, or invoke the OTP-relaying `read_thread` tool. Owner turns retain their existing behavior

## Delivery and closure

Mail follow-up text is frozen in the existing final outbox with a source receipt. Before transport it rechecks current owner binding, source message, loop state, due time, timezone and volume. Quiet/low-volume holds defer the pending intent rather than falsely mark it delivered. Confirmed ACK settles delivery; ambiguous sends stay quarantined. Known pre-send denials may re-arm the same frozen payload, not regenerate its wording or retry uncertainty. No exactly-once claim is made.

Completion remains unknown unless owner evidence establishes it. The useful check asks neutrally, such as “Have you handled the deck review? Pat requested it by 10.” Owner `done` uses existing `close_loop`; subsequent periodic checks remain silent for that loop. Changed deadlines/timezones and owner cancellation are checked again at delivery.

## Primary references inspected

- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): distinguish durable application state from thread checkpoints. Adapted to existing owner SQLite/outbox; no LangGraph dependency
- [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts): durable pending state and validation when resuming. Owner-bound delivery revalidation uses Waldo's existing machinery
- [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync): retain message/history identity and treat partial-sync gaps explicitly. Full Gmail history synchronization is deferred; current bounded primary-inbox collection is not a complete mailbox scan
- [Google Calendar synchronization](https://developers.google.com/workspace/calendar/api/guides/sync) and [Microsoft message delta](https://learn.microsoft.com/en-us/graph/delta-query-messages): identity-preserving updates/deletions. Calendar behavior is preserved; cross-service normalization and source cancellation handling require their own slice
- [OpenHands design](https://docs.openhands.dev/sdk/arch/design) and [security](https://docs.openhands.dev/sdk/guides/security): reuse typed state/tool boundaries, separate model judgment from permission enforcement

These are implementation references, not performance benchmarks or evidence about private OpenAI infrastructure. No upstream implementation was copied and no package/license dependency was added.

## Acceptance layers

Synthetic deterministic fixtures cover pointer isolation/retention, source identity, deduplication, changed evidence/deadlines/timezones, quiet/volume holds, owner closure, skipped-candidate fairness and frozen pre-send recovery versus uncertain send quarantine. A scripted gateway exercises the real responder/tool loop, including denied source-less background creation. A default owner-DO ingress fixture covers held mail → after-wake extraction with no new delta → periodic nudge → low-volume hold → one ACKed send → owner `done` → later silence.

No real mailbox, live model, live owner delivery or deployment is covered by these fixtures. The serving-base SHA, final candidate and exact commands/results belong in the release receipt. Serving-base preparation and later integration/release evidence must remain separate.
