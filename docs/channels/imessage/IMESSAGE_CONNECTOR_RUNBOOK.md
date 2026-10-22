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
| `IMESSAGE_BRIDGE_DO`, `OWNER_DO` | Durable Object bindings (wrangler migration `v7`; `v6` is beta-mvp's TelegramOwnerDO -> OwnerDO rename). |

The proposed local test policy (signature 60s, heartbeat/capability 90s, request 128 KiB, 16 MiB /
4096 records per bridge, pull wait 0, delivery 20s, mutation 30s, commitment 30s, setup 10 min,
reply handoff 10 min) is a **proposal**, not provider capacity and not a live default.

## Owner setup (console)

1. Console **Connections -> iMessage** (`/console/imessage` opens it) -> **Pair a Mac host**: one-use
   invitation (`wim_…`), shown once in that reply only (`private, no-store`); receipts never keep it.
2. The host calls `/pair/redeem` and receives its credential once. The bridge is *pending*: it may send
   heartbeats, capabilities and the setup challenge only.
3. **Get a challenge**: enter the Apple sender and its `iMessage;-;…` direct chat. A one-use challenge
   (`wic_…`) is shown once. Send it from that sender to the Mac's Messages account.
4. When the host row shows the observation (press **Refresh**), **Confirm**. Activation uses the sender the
   challenge recorded and creates the canonical presence/binding.

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
- Each reply goes to the bridge before the owner's next turn starts. A reply that finds the slot busy waits up to 4 s for
  it, then is retried in 1 s; any other reply that could not be handed over is retried in 5 s. A retry runs in the
  owner's queue, so a reply still waiting after those 4 s goes after the turn that runs next.
- There is no reconciliation or quarantine-clear API. Recovery requires a reviewed design (history/GUID
  reconciliation on the host); until then revoke and re-pair.
- An owner turn interrupted by restart is closed as `interrupted` with effects unconfirmed and is not
  rerun.

## Progress notes on long turns

iMessage shows no typing dots, so a long owner turn sends at most two short notes
(`src/channels/progress-pacer.ts`).

- **When.** The wait counts from the later of two moments: the owner's message, or Waldo's last message on that chat.
  Note 1 goes once the wait passes 20 s and note 2 once it passes 75 s. A turn that answers sooner sends none and makes no
  extra model call.
- **What.** The auxiliary model writes each line from the owner's message and the names of the tools the turn has
  finished. It never sees tool outputs or arguments, and it never states an outcome. If the model cannot write note 1, a
  fixed line goes instead; note 2 is skipped, or declined by the model when it has nothing new to say.
- **Delivery.** A note uses the reply outbox under `progress:<turn>:<n>` and is handed to the bridge once, from inside the
  turn:
  - It is never retried and wakes nothing.
  - A bridge that answers without taking it settles it `not_started`. A handoff that threw, or a note dropped while
    frozen, settles `unknown/may_have_completed`, because its handoff had already started.
  - The reply closes the pacer before it freezes, so a note still being written is dropped.
- **Notes come last in the one-slot mailbox.** All matches are within the note's own owner, since turn ids repeat
  across owners.
  - The bridge refuses a note once its own owner's reply for that turn is in the mailbox (`progress_superseded`).
  - Any other message, from any owner (a reply, a proactive copy or a system reply), withdraws a note the host has not
    pulled (`progress_preempted`).
  - A note never waits for the slot (`progress_busy`), and while a reply waits, no note takes it (`progress_yields`).
  - A reply that finds the slot busy waits for it as above, and the slot is read before any directory lookup.
- **Messages during a long turn.** iMessage has no steer or stop path. A message the owner sends meanwhile waits and runs
  as the next turn, after the current reply has gone to the bridge.
- **Off switch:** `WALDO_IMESSAGE_PROGRESS=0`.
- **Typing dots** are a host change, proposed in `waldoco/waldo-imessage-host`: the host types from an owner message
  until its next send to that chat. The backend sends no typing commands, since they would take the single mailbox slot.

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
