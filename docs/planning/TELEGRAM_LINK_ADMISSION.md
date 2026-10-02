# Unknown sender / link-command ACK admission

Base: reviewed Gmail merge 0da0ab9. Plan only; no implementation or live redemption yet.

## Source failure

`channels/telegram-webhook.ts` unknown sender path returns 200 immediately while waitUntil redeems a one-time code and sends a reply. A process loss can drop both. Known `/start` and `/link` are also ACKed without owner-inbox evidence. `identity/owner-directory.ts` performs signed redeem_link RPC then a separate presence read. SQL redemption is one transaction, but a committed RPC can lose its response. Replaying the code cannot recover its prior result. No SQL/config changes are in scope.

## Narrow contract

Supported private `/start CODE` and `/link CODE` get durable admission+alarm before 200, including known senders. Unknown ordinary text and setup commands without a code remain explicitly ignored, outside this contract. No model input, no owner-data sharing, no new relink semantics. Existing active presence gets a truthful already-linked response without spending another code. Groups, mismatched chat/sender, malformed update IDs, overlarge bodies and internal-auth mismatches cannot admit.

Use the existing Telegram owner DO namespace with a separate routing-only object name `telegram-link:<bot ID>:<subject>`. Do not write owner binding or initialize owner runtime in that object. A secret-authenticated /enqueue-link endpoint verifies its exact object ID. The routing object stores update ID, digest, immutable bot/subject binding and link code hash, never code plaintext or logs. Extend directory redemption with hashed input without changing RPC signature. Duplicate same payload ACKs only after existing durable evidence; conflicting replay rejects. Storage/alarm/capacity failure returns retryable non-200. Reuse existing owner-inbox capacity/retention parameters rather than invent values.

## Non-idempotent redemption boundary

Persist an attempting state before issuing the RPC. Never retry a possibly-issued redemption after interruption, RPC exception or response loss. Reconcile only through live presence read. If currently linked, say the chat is currently linked and to check console; never assert which code/owner succeeded. If no route or route read is unavailable, freeze an uncertainty response: linking could not be confirmed; check console before trying a fresh code. A crash between attempt persistence and issue is also uncertain. This trades automatic recovery for honesty because no-SQL means no idempotency receipt at the authoritative transaction boundary.

For a normal authoritative redeem success + route read, freeze 'Linked. This chat now talks to your Waldo.' For authoritative null response, freeze invalid-code text. A later failed route read must not convert committed redemption into invalid-code wording. Preserve safe current-presence wording for known sender. No cross-object owner effect or borrowed metadata.

## Response delivery and scheduling

Persist frozen routing response+due state before delivery. Sender/bot binding is checked before every send. The existing shared alarm seam owns the sole raw alarm; add routing due time to arbitration and have routing-only alarm handling skip normal owner setup entirely. Registration failures remain visible. Retry known send failures with the existing final-outbox delivery policy, expire with its existing limits, and represent ambiguous delivery as uncertain; no exactly-once claim. Never rerun redemption while retrying response delivery. A bot change quarantines old responses. Terminal records clear code hash; retain dedupe metadata within existing retention.

## Red-first proof and exclusions

Webhook held admission/no ACK until durable wake, storage/alarm failure, unknown ignored messages, exact replay/conflicting replay, known-link routing, invalid command/group/sender rejection. Actual DO storage/recreation before issue, after attempting marker, after committed RPC lost response, before frozen response and after send interruption. Prove no second redeem, no false invalid-code/success after uncertainty, no owner runtime initialization in routing object, routing alarm not overwritten by scheduler rearm, bot change prevents send, blocked first row does not strand later updates, eventual frozen reply delivery within existing bounds. Exact-head CI and independent source review before merge/stage. Live test only synthetic invalid code unless explicit permission covers issuing/redeeming a real code; no account effect under a smoke-test label.

This closes premature ACK for supported link commands, not the authoritative RPC idempotency gap. With no SQL change, uncertain redemption must remain explicit and cannot be advertised as fully recoverable. No relink, SQL, deployment config, production or spend.

## Review amendments (implementation gates)

- Public abuse admission uses the already-bound RESPONSIBILITY_RATE_LIMITER before routing DO allocation: per-sender key and aggregate bot/backend key, fail-closed on missing binding/error. Existing 120-per-minute policy is the binding's configured policy, not a new constant; Cloudflare rate limits are location-local, not a global authoritative budget. Duplicate evidence resides in the DO, so duplicate-before-edge-limit and rate-before-allocation cannot both be satisfied without a new store. Parent13:13 accepted tradeoff: edge guard first; DO duplicate then precedes its capacity/internal admission checks. Never claim 512 capacity is a rate limiter.
- The actual issuer produces 10 characters using console-auth.ts LINK_ALPHABET, not invite-code.ts's 20-character format. Validate exact issuer alphabet/length before hashing; normalize trim+uppercase once. Match issuer format, do not invent entropy or accept arbitrary 64KB tokens.
- Hash is a redeemable credential. Persist no raw update body, raw code, signed RPC body or payload logs. Keep separate irreversible full-update digest for dedupe. Scrub hash immediately when freezing an outcome, on uncertain-attempt recovery and before any long-lived tombstone. A failed freeze after RPC needs an independent scrub step and a conservative recovery state, not retention of credentials.
- Change directory interface to typed authoritative redeemed/rejected/uncertain result separate from presence lookup. Null RPC is rejection; exception/timeout is uncertainty. A successful RPC plus null/throw presence lookup is NOT invalid. Current presence after uncertainty proves only currently-linked, never this attempt/code succeeded. No automatic redeem retry anywhere.
- Preflight current presence immediately before attempting marker/RPC, including known senders. Already-linked between webhook and RPC must not spend code. Database presences are provider+subject, not bot-scoped. Runtime bot binding guards both RPC and send, but cannot claim cross-bot DB isolation.
- Persist routing-only mode/binding in the same admission transaction before alarm/ACK. Fetch/alarm dispatch this mode before bindIdentity/setup/setWebhook. Routing objects expose no console/grant/routes or owner setup. No Scheduler initialization solely for rearm; all error paths retain a minimum future wake through the existing alarm seam. Response retries never reenter redemption.
- Workflow retention preserves dedupe through provider redelivery while scrubbing credentials promptly. Determine documented Telegram redelivery window before selecting retention; do not infer it from owner's 25-hour inbox retention. Response TTL and issuer's SQL10-minute code expiry are separate. Crash-before-RPC remains uncertain. Storage failure after RPC before freeze uses presence reconciliation and conservative text; absence proves neither rejected nor redeemed.
- Generic replies only: no owner/DO/context disclosure or new code-validity distinctions. Known presence can say currently linked. Conservative uncertainty says linking could not be confirmed and to check console before using another code.

Proof additionally covers duplicate ACK vs edge-limit tradeoff, concurrent different update IDs with same code (not per-code exactly-once), presence linked between webhook and RPC, linked then unlinked before route read, success RPC+null/throw route lookup, bot replacement before redeem, hash scrub at uncertainty/freeze faults, routing mode reconstructed on alarm, malformed internal route never reaches owner setup, rate checks before allocation.

Honest final claim: durable receipt for supported coded private setup commands, frozen response transport, at-most-one deliberate redemption attempt per admitted update. NOT per-code exactly-once across updates, authoritative idempotency receipt, guaranteed linking/delivery or cross-bot database scoping.

Retention source verified: https://core.telegram.org/bots/api states incoming updates are not kept longer than24hours and unsuccessful webhook requests are retried before giving up after a reasonable amount of attempts. Use existing25hourdedupe retention (covers documented24hourupdate lifetime); do not claim documented exact retry cadence or delivery guarantee. Code credential10minexpiry and frozen response TTL remain separate.
