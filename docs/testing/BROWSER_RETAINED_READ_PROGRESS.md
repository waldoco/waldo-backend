# Retained browser read progress

An identical `browse_page` call may run again only when its prior successful result
contains a host-local `session_handle` and a completed browser action in that same
session occurred after that read. The normal round, owner authority, egress and
spend checks still apply on redispatch.

`browserTaskContinuity` issues the local action-session handle after a successful
fill, type, click, goto or scroll and the following observation. Read, inspect,
wait, held/approval-pending commands and uncertain/failed actions issue no receipt.
The browser task handler projects this as `browser_action_session_handle`; the
loop never treats page text or model arguments as action evidence. Provider session
IDs remain private. A receipt records action progress, not task completion or an
external effect receipt.

The current common public-read host has no action path in its retained session.
Reading A, reading B, then making the identical A call therefore yields two useful
reads and `repeat_refusal` for the third. A different read request can still use
that retained session. A mutation in another browser session or another tool does
not reopen the identical retained read. Ordinary non-retained read/mutation cache
behavior and cached settled failures remain as before.

Adversarial regression checklist:

- [x] Handle alone refuses an identical call and spends no new provider allowance.
- [x] A completed matching-session action unlocks exactly one fresh read.
- [x] Another-session action, held action, read and wait do not count as progress.
- [x] Redispatched read rechecks owner authority; its settled rejection is cached.
- [x] Actual task-host action receipts omit the private provider ID.
- [x] Normal two-argument owner journey keeps one Cloudflare allocation, delivers
  useful A/B evidence, supplies PNGs and cleans the exact session despite refusal.
- [x] Existing shared/local tool budgets and ordinary loop tests remain intact.
