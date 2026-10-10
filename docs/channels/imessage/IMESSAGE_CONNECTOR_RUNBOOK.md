# iMessage connector runbook (local proof; live use not approved)

The connector is **off** everywhere except local test configurations. Nothing in this document
authorizes deployment, a real Apple account, native sends, hosted migrations or real credentials.

## Composition (all required; any missing piece = routes return 404)

| Setting | Meaning |
| --- | --- |
| `IMESSAGE_CONNECTOR_ENABLED=1` | Feature gate. Hosted configs ship `0`. |
| `IMESSAGE_CONNECTOR_POLICY` | Strict JSON policy (`src/channels/imessage/policy.ts`). No defaults. |
| `IMESSAGE_CREDENTIAL_WRAPPING_KEY` | 64-hex AES-256 key that wraps host credentials. Secret store only, never chat or a repo. |
| `WALDO_ENVIRONMENT` | Bound into credential associated data and DO names. |
| `SUPABASE_PROJECT_URL`, `SUPABASE_PUBLISHABLE_KEY`, `WALDO_ROUTER_HMAC_SECRET` | Router-signed RPC boundary; no service-role key. |
| `IMESSAGE_BRIDGE_DO`, `TELEGRAM_OWNER_DO` | Durable Object bindings (wrangler migration `v6`). |

The proposed local test policy (signature 60s, heartbeat/capability 90s, request 128 KiB, 16 MiB /
4096 records per bridge, pull wait 0, delivery 20s, mutation 30s, commitment 30s, setup 10 min,
reply handoff 10 min) is a **proposal**, not provider capacity and not a live default.

## Owner setup (console)

1. `/console/imessage` -> **Pair a Mac host**: one-use invitation (`wim_…`), shown once, no-store.
2. The host calls `/pair/redeem` and receives its credential once. The bridge is *pending*: it may send
   heartbeats, capabilities and the setup challenge only.
3. **Set exact sender**: enter the Apple sender and its `iMessage;-;…` direct chat. A one-use challenge
   (`wic_…`) is shown. Send it from that sender to the Mac's Messages account.
4. When the page shows the observation, **Confirm**. Activation creates the canonical presence/binding.

## Safe status

The console shows state, online/offline, whether text sending is verified and whether sending is
paused by an uncertain send. It never shows keys, invitations, challenges, bodies or GUIDs.

## Stop, revoke, rotation

- **Revoke** commits canonical state + revision first, unlinks the presence, closes queued/running
  owner turns for that bridge (running turns stop at their next scope check; their effects are marked
  unconfirmed), withdraws never-delivered replies as `not_started` and rejects all further host requests.
  Delivered/started/uncertain evidence and quarantine are retained.
- **Rotation/replacement**: revoke, then pair again (fresh invitation, challenge and confirmation).
  There is no in-place key rotation in this build.
- Owner suspension or deletion invalidates authority immediately (deletion cascades bridge rows).

## Backpressure and uncertainty

- A bridge DO refuses new events/commands (HTTP 503, no ACK) when its retained records/bytes reach the
  policy bound. Nothing pending or uncertain is evicted; retained-capacity archival is not implemented.
- One outstanding reply per bridge/account. A reply the host does not pull within the delivery deadline
  is `not_started` (`host_not_pulled`). A pulled reply without a terminal result within the mutation
  deadline becomes `unknown/still_in_flight` and **permanently** pauses sending for that account.
- There is no reconciliation or quarantine-clear API. Recovery requires a reviewed design (history/GUID
  reconciliation on the host); until then revoke and re-pair.
- An owner turn interrupted by restart is closed as `interrupted` with effects unconfirmed and is not
  rerun.

## Local proof commands

```sh
pnpm --filter @waldo/runtime exec vitest run --config vitest.imessage.config.ts
node packages/runtime/scripts/imessage-local-trace.mjs --dry-run
node packages/runtime/scripts/imessage-local-trace.mjs     # needs a local Docker context
```

The trace uses disposable PostgreSQL 15 + PostgREST containers (database on an internal network,
PostgREST on a loopback-only port), the production bundle in workerd, a scripted model and a simulated
host, and fails on any other outbound request.

## Proof limits

Local simulated host proof only. Suyash's real host, the AppleScript/Messages dictionary, Apple sends,
recipient-device readback, sleep/wake, real credentials, hosted migrations and deployment are
**UNVERIFIED**. No real credential or staging execution was performed in this build.
