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
