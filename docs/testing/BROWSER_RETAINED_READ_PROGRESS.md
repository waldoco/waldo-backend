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

The common serving host now issues the same progress receipt after an observed native action in the matching session. A repeated same-URL read observes the retained document instead of reloading it. Read, inspect, screenshot and switch_tab are observation-only; they do not unlock a repeat. An explicit owner-local session_handle can resume a later admitted turn under the original grant. Document state lasts while the disposable CDP context remains connected; eviction/disconnect loses it and requires explicit fresh-document recovery. See [serving lifecycle and acceptance](BROWSER_NATIVE_UPLOAD_PREPARATION.md).

Adversarial regression checklist:

- [x] Handle alone refuses an identical call and spends no new provider allowance.
- [x] A completed matching-session action unlocks exactly one fresh read.
- [x] Another-session action, held action, read and wait do not count as progress.
- [x] Redispatched read rechecks owner authority; its settled rejection is cached.
- [x] Actual task-host action receipts omit the private provider ID.
- [x] Normal two-argument owner journey keeps one Cloudflare allocation, delivers
  useful A/B evidence, supplies PNGs and cleans the exact session despite refusal.
- [x] Existing shared/local tool budgets and ordinary loop tests remain intact.
