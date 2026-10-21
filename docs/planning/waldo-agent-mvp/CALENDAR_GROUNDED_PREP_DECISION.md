# Calendar-grounded meeting preparation

Status: bounded candidate, default-off; no live acceptance or release claim. Original base: 4485c64492854b42db2a4e552dc5fe1f598c3758. Integrated serving base: 4620da911f896b8f43eea7fa4aebd6dd18bff8fc (curated skills). This does not revive the parked contextual-event-prep worktree or amend canonical Brain records.

## Why build this

The owner requested useful mail/calendar/meeting proactivity. Current event briefs ask who is there while exposing only attendee count and directly send without a frozen receipt or source recheck. The useful outcome is arriving prepared with a current local time, supported preparation step and honest missing details.

Reuse the existing ten-minute sweep, forty-minute horizon, ten-event bound, owner responder/model/safety, bounded owner context, delivery gate and Telegram final outbox. Only Calendar-returned facts and existing bounded owner-origin non-health memory enter this slice. No new mail/document fetch, OTP relay, calendar write, task model, policy ledger or inferred meeting completion is admitted.

Primary patterns checked on 3 October 2026:
- Google event resources provide status, revision, recurring original occurrence and source URL; cancelled resources can lack ordinary details: https://developers.google.com/workspace/calendar/api/v3/reference/events
- Google synchronization distinguishes bounded observations from complete paginated sync; this slice does not claim complete calendar coverage: https://developers.google.com/workspace/calendar/api/guides/sync
- Hermes distinguishes queued output from evidenced delivery; Waldo reuses its own final outbox and validated same-chat ACK: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md
- Kuo et al.'s fifteen-developer study supports testing timing/restraint, not a claim of meeting-agent efficacy: https://arxiv.org/abs/2601.10253

## Interface and trust boundary

Calendar projection preserves actually fetched status/revision/recurring instance, safe Google Calendar URL and known display names. Host-selected account identity is supplied on local and Vault clients. A cancellation without dates is represented without throwing or guessing.

An additive transient structured-decision option uses the existing responder/model/safety implementation, no tools, no reduced-context dispatch and a 32-KiB request ceiling. Decision prompts/JSON do not enter conversation, episodes, publication cache or memory. Transient traces contain counts/usage only. Model judgment chooses notify/no-op; schema validation bounds output.

Normal owner physical retries retain curated-procedure currentness checks before and after every provider call. Transient preparation neither loads skill metadata/procedures nor inherits a previously selected or revoked owner procedure; it uses its separate host currentness guard.

The owner DO owns account/grant/subject/actual-DO/bot/timezone currentness, quiet/volume settings, source re-read, gate admission and frozen output. A distinct calendarPrep final receipt is rechecked before transport. Source changes, cancellation, revocation, account replacement, timezone changes and expiry prevent stale delivery. Pending is not delivered; invalid ACK and interrupted attempts remain uncertain. Meeting end never closes a loop.

Dedup/start/cooldown keys are hashes. Literal owner-forget cleanup covers payload and receipt metadata, cancels matching unsent intents, preserves uncertain transport and cannot rearm delivery. Source text and model rationale are not added to another retained ledger.

## Shared delivery-policy disposition

The public legacy policy currently labels daily scope utc_day; existing journal callers retain UTC compatibility. The approved calendar caller explicitly supplies one trusted owner timezone to every store/gate read and write. Local-day cap holds reuse the existing scheduler helper, including midnight DST gaps and skipped dates. Lifetime counters, absolute cooldowns and historical aggregates are preserved. This caller-specific disposition requires normal review before merge and is not a canonical ADR amendment.

TelegramOwnerDO has no other legacy delivery-gate writer. Initial adoption treats absent marker provenance as legacy UTC; an existing-KV timezone marker identifies adopted semantics. A marker matching the trusted timezone is immediately usable. Changing semantics requires every retained class/subkind/budget date and every non-null class/subkind send to precede both current old/new civil days. This permits finite adoption of ordinary historical state without rebucketing or deleting any rows, and protects budget-only/subkind-only state on later zone changes. Current-day state waits for both rollovers; malformed/future state or invalid timezone provenance holds explicitly for inspection. The marker alone changes atomically in the owning storage transaction. A held Calendar transition still runs the existing independent update check.

Quiet holds reuse the frozen final and shared alarm. Expiry is checked before deferral and held wakes are clamped to expiry. There is no separate cohort mechanism. Telegram-only output does not charge an APNs reservation. Wider channel fanout and canonical quiet-cohort architecture remain outside this candidate.

## Acceptance and limits

Actual default-owner DO fixtures cover IST source facts, no-op, frozen delivery, quiet hold/expiry, restart dedup, cancellation/revision/model-time source changes, account/scope/subject/bot revocation, timezone changes, wrong ACK, uncertain restart, owner topic-forget and daily caps. Independent regressions cover stale cached decisions, unsent nightly evidence and metadata-only forgetting. Shared tests cover legacy UTC, IST rollover, NY 23/25-hour days, São Paulo midnight gap, Apia skipped day and lifetime/cooldown preservation.

UPDATE 2026-10-04 (S2a): calendar prep is on by default; `CALENDAR_GROUNDED_PREP=0` is a kill switch and the owner opt-out is `followups:false`. Earlier text: CALENDAR_GROUNDED_PREP is absent/off by default. Controlled real-model/provider usefulness, current-base CI and live owner acceptance remain required. Scripted gateways prove wiring/safety, not helpful model behavior or successful real-provider reads. No publication, deployment, new grant or external database mutation occurred.
