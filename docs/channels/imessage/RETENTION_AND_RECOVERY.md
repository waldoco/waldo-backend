# iMessage connector: retention, backpressure and recovery

Owner-approved follow-up to the #1017 review (rev3, 2026-10-13). Values are PROPOSED local values in code
(`bridge-store.ts`, `final-outbox.ts`), not policy fields; the host contract packet is unchanged.

## Bridge Durable Object (`IMessageBridgeDO`, per environment/bridge/account)

| Rows | Pruned when | Never pruned |
| --- | --- | --- |
| `events` handed/acknowledged (identity + digest only) | created more than 7 days ago (`BRIDGE_TERMINAL_RETENTION_MS`) | `pending` |
| `events` held (body kept as evidence: media, revoked scope) | created more than 30 days ago (`BRIDGE_HELD_RETENTION_MS`) | |
| `deliveries` | settled (`resulted`/`withdrawn`), reported to the owner, result not `unknown`, created more than 7 days ago | `queued`, `delivered`, unreported, `unknown` |
| `sent_messages`, `result_conflicts` | with their delivery | |
| `nonces` | expired (unchanged) | |

Pruning runs inside every bounded step. **Backpressure recovery:** if a step would exceed `maxRecords` or
`maxRetainedBytes`, terminal rows are pruned early down to a 24-hour floor (`BRIDGE_PRESSURE_FLOOR_MS`, which
covers host ACK-loss and result-retry windows); only if live or uncertain work alone exceeds the bounds is the step
refused (`503 backpressure`). That remaining state (pending events the owner has not drained, held evidence, an
outstanding or unknown command) is cleared only by the owner flow below.

Steps that add no rows are never refused for space: settling an event, withdrawing, the deadline sweep (so a
`mutation_deadline` quarantine always lands), marking a result reported, and **revoke**. A revoked or expired
bridge always answers `401` (it used to surface as `503` when the store was full).

## Quarantine recovery: revoke + re-pair

A lane quarantines on a host-reported `unknown` or a pulled command with no terminal result by
`mutationDeadlineMs`. Quarantine is permanent for that bridge by design (no reconcile API). **Recovery:** the owner
revokes the bridge in the console and pairs again; the fresh invitation mints a new bridge/account identity, i.e. a
new Durable Object with an empty lane. The old Durable Object keeps its evidence (subject to the retention above).
Proved by `imessage-e2e.test.ts` "quarantine recovery is revoke + re-pair".

## Owner Durable Object KV

- `imessage:outbox-record:*` (frozen replies): at most 256 records; only settled records are evicted, oldest
  first; a full outbox of live replies refuses the new freeze instead of dropping one. Settling clears the reply
  text (identity and result stay).
- `imessage:inbox-record:*`: unchanged bounds (4,096 rows, 256 open, finished rows deleted after 30 days, text
  cleared on close).
- **Literal owner forget** (not only account deletion) now reaches both: an admitted, not yet started turn is
  redacted; a frozen reply is cancelled as `not_started / owner_forget`; a queued reply's owner copy is redacted;
  the running turn (usually the forget request itself) is left and cleared when it closes. The bridge's own copy of
  a queued command and held evidence remain that custody's documented gap.

## Host routes before the Durable Object

- `bridgeId`/`accountId` must match `imb_`/`ima_` + 32 hex (minted ids) or the request is `401` with no directory
  lookup and no Durable Object.
- An unknown minted tuple gets the directory lookup but opens no storage (`store()` runs after authority).
- `RESPONSIBILITY_RATE_LIMITER` (120 per 60 s per key) limits each source IP per route class
  (`imessage-redeem-ip:*`, `imessage-host-ip:*`) before any directory or Durable Object work; a paired host polls
  about 35 times a minute. Missing binding fails closed (`503`), as in the app API.
