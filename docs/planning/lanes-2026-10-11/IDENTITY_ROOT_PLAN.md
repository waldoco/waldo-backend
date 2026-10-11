# One owner, every surface: plan for the identity root, Google connect, and the work split

Read-only analysis of `beta-mvp` @ `ce80802f`, 11 Oct 2026. A planning document: it authorizes nothing by itself.

Line references below are to that snapshot. `do.ts` is `packages/runtime/src/channels/telegram-owner-do.ts`.

## 1. Is identity bound to Telegram? Half right

### What is already rooted on the user id [verified]

**The account root.** Each sign-in creates one owner, and every surface resolves to that owner and one runtime:
- The chain is `auth.users.id` → `waldo.owners.id` (uuid, primary key) → `do_name`. The `do_name` is minted at account creation as `'owner-' || gen_random_uuid()` (`20260928190000_*.sql:51-52`).
- App sign-in (`app-api.ts:126`) and console sign-in both resolve through `owner_for_auth`, so they land on the same `do_name`, the same Durable Object and the same data.
- Telegram, WhatsApp and console are `presences(provider, subject)` rows pointing at that owner (`20260924120000:14-23`).

**The Google grant.** It is keyed on that owner, not on Telegram:
- It is stored in Vault plus `waldo.connections(owner_id)`, with `owner_id = owner_id_for(do_name)` (`20260924170000:2-21`).
- Tools find it by `(do_name, connection id)` (`tools/live/google.ts:47`, `connections.ts:58`).

So **Google connected in the console is already usable in the app**. That is a source trace; it has not been run on staging.

### What is Telegram-shaped: the owner principal inside the runtime [verified]

Once a turn or a scheduled job is running, the DO treats "the owner" as a Telegram chat:

| Where | What happens for an owner with no Telegram link |
|---|---|
| `do.ts:1175-1185` alarm gate | Returns before `scheduler.dispatchDue`: no reminders, Brief, Close, heartbeat, nightly memory or standing orders. #1034 opens this for reminders only |
| `do.ts:1458` `setup(channel = 'telegram')`; the owner resolves to a chat id | The owner is 0, and egress refuses with `owner_unbound` (`:1540`) |
| `do.ts:1213-1220`, `telegram-final-outbox.ts` | Proactive deliveries are keyed by Telegram `chat_id`; there is no app lane |
| `do.ts:651` vs `:1961` | **Two transcripts in one runtime:** the app writes `owner:prn_<owner id>`, Telegram writes `telegram-<chat id>`. Something said on one surface is not in the other's history |
| `do.ts:2255-2320` Calendar Prep; `:1984` skills; `:1352-1385` ratings | Telegram branch only |
| `owner-browser-runtime.ts:49-69`; browser binding (`20261008000000:17`); task custody key `telegram:<doId>:<owner>` (`do.ts:1786`) | No browser; task custody fails |
| `do.ts:798-833` `/event` | Owner 0, so `notification_blocked` |

There are also four in-code representations of the same owner:
- `prn_<owners.id>`;
- `owner_<sha256(auth uid)>` (used by `RunLoopDO`);
- `acct_<sha256(do_name)>`;
- the Telegram chat id.

**Conclusion.** Re-keying accounts or Durable Objects would be expensive, would risk DO continuity, and fixes a layer that is already right. The fix is inside the runtime:
1. one owner principal (`owners.id`);
2. a delivery router that chooses the surface;
3. one main conversation across surfaces.

### Why Google really does break across surfaces, for other reasons [verified]

1. The app has its own legacy connect path, and the backend never reads its store:
   - the path is `waldo-app/src/agent/agentClient.ts:143` → `waldo-app/supabase/functions/oauth-google`;
   - it keys by Supabase `auth.users.id` into `public.connector_accounts` and a Vault secret `connector:<user>:<provider>`.
   - It reads `GOOGLE_OAUTH_CLIENT_ID` where the backend reads `GOOGLE_CLIENT_ID`. If those name different OAuth clients, tokens cannot move between them [inference].
2. There is no `/app/v1` route that starts a connect.
   - The DB check constraint allows only the connect channels `telegram` and `console` (`20260925000000:7`).
   - An `app` consent surface and the `waldo://oauth/complete` deep link exist but are never set (`google.ts:57`, `google-oauth.ts:12,26-27`).
3. In app chat, the connect and reconnect buttons are silently dropped.
   - `appSinkCaller` returns a fake `message_id` (`app-api.ts:203-206`), so the offer is marked sent.
   - That suppresses the reconnect notice on every surface (`do.ts:1600,1626-1628`).
4. The "connected" confirmation is sent to Telegram `chat_id: owner` (`do.ts:1160`); an app-only owner never sees it.

## 2. Target state

| Concept | One representation | Notes |
|---|---|---|
| Owner | `waldo.owners.id`, carried in the DO as an `OwnerPrincipal { ownerId, doName, presences[] }` | The other three ids become derived views; the trace and RunLoop digests stay as one-way derivations of `ownerId` |
| Runtime | One `TelegramOwnerDO` per `do_name` (renaming the class is cosmetic and comes later) | No DO renames. `RunLoopDO` is the trusted effect path that CLAUDE.md keeps; L2 states what it owns before changing anything |
| Surface | A value on the turn and on each delivery, never the owner | app, console, telegram, whatsapp, imessage, email |
| Proactive delivery | A router: **the owner's chosen surface, otherwise the app** (owner ruling, 11 Oct) | A surface-aware final record with a real acknowledgement per surface; on the app, a transcript row plus a push once S7 lands |
| Conversation | One main conversation per owner, shared by every surface; threads stay app and console only | **Owner decision needed:** merging existing Telegram and app histories |
| Connectors | Connect from any signed-in surface into the one backend store | Retire the app's legacy `oauth-google` path |

## 3. Ordered slices (owned by us, lane L2; L3 owns the contract changes)

Rule throughout: **no job emits a Telegram-addressed delivery for an app-only owner until delivery is surface-aware.** No Durable Object or account is renamed.

| # | Slice | Main files | Risk and falsifier |
|---|---|---|---|
| 0 | **#1034 (in flight, live on staging):** alarm admission through the app binding plus `owner_runtime_authority`; reminders written to the app transcript | `do.ts` alarm, `app-api.ts` | Change its routing to the 11 Oct ruling (chosen surface, otherwise app) before it merges. A duplicate row is possible after a crash (disclosed) |
| 1 | **Owner principal.** `setup(surface)` takes the surface separately; the owner is `owners.id`; `resolveOwnerTelegramId` and `appSubjectFor` are replaced | `do.ts` `setup`, `app-api.ts:190-194` | Trace and conversation ids change. Falsifier: an existing Telegram-linked owner keeps their history and receipts (dual-read test) |
| 2 | **Delivery router and surface-aware finals.** Additive `surface` on final records (default telegram for existing rows); the router; app delivery with a real acknowledgement (replaces the fake `message_id`); connect, reconnect and "connected" notices routed per surface | `telegram-final-outbox.ts`, `do.ts` outbox, `app-api.ts:203-206` | Additive to app.v1: the app lane must hear before shipping. Falsifier: an app-only owner's Brief lands in the app, and a Telegram-preferring owner's on Telegram |
| 3 | **All scheduled jobs for every owner**: Brief, Close, heartbeat, nightly, standing orders, Calendar Prep through the router; skills and ratings at owner level | `do.ts` alarm and scheduler setup, `skills/curated-host.ts` | Falsifier: the S2 trace shows a Brief model call and an app delivery for an owner with no Telegram link |
| 4 | **One main conversation** (after the owner's decision) | `conversation-store.ts`, `do.ts:651,1961` | Merges histories; needs a dual-read and window test |
| 5 | **Custody re-key**: browser and task custody on `owners.id` with a dual-read period; browser `assertOwner` through `owner_runtime_authority`; browser binding not limited to Telegram | `owner-browser-runtime.ts`, `browser-production-factory.ts`, migration `20261008000000` follow-up | Unblocks browser errands from the app. Needs a migration (reserve a number) |
| 6 | **`/event`, WhatsApp, iMessage**: events resolve the owner through the directory; add the `imessage` presence provider; the seam Ashish plugs into | `event-ingress.ts`, `do.ts:798-833`, presences migration | Migration ordering: #1017's `20261010120000` must be renumbered |
| 7 | **Clean-up**: retire the `deployOwner` fallback and the legacy console route; settle what `RunLoopDO` owns | `owner-directory.ts:38-45`, `index.ts:127-133,197-204` | Check that no live owner has a numeric `do_name` |

Unverified, for L2 to check first: `do.ts:601-602` writes `do_name` from a header. The source does not show an `idFromName` check next to it [unverified].

**Google connect from any surface** (L3 contract, L2/L1 backend, L4 app):
- **G1.** A connect route (`/app/v1` action or route) issuing the same `/c/<ticket>` with surface `app` and the existing deep link, plus a migration allowing connect channel `app`.
- **G2.** The app drops the legacy `oauth-google` path and uses G1.
- **G3.** The "connected" notice and reconnect prompts render on the surface where the owner is (this is slice 2).
- **G4.** Owner config check: confirm one OAuth client (`GOOGLE_CLIENT_ID` vs `GOOGLE_OAUTH_CLIENT_ID`).

## 4. Who builds what

**We own** the work that ties app and backend together, because it touches hot files, contracts or migrations:
- **L2 (event-route session):** slices 0–7.
- **L3 (new session):** app contracts, including the routing preference control; piece A (approvals from any surface); G1; threads; keeps ledger §12 current.
- **L1 (new session):** H3 deploy; H4 producer plumbing (per-day read migration, a trigger on ingest commit, `health_context_write`); health purge gap; the only staging deployer.
- **L4 (#16 app session):** a TestFlight build for Suyash's iPhone and Apple Watch, with every promised feature working at a basic level on a basic design system.
  - The app's dependencies on the backend are the items above.
  - Signing and TestFlight upload are your actions.

The console uses the same owner and the same contracts. Approvals, connections and schedule must work there too, as the ledger already requires.

**Instinct takes disjoint slices** under `docs/app/codex-handover/OWNERSHIP_BOUNDARY.md`: disjoint files, a written acceptance bar, its own branch, our review before merge. Briefs are in [`instinct/`](instinct/README.md):
1. `01-health-score-calculations.md`: the pure Recovery, sleep debt, Form and Weight module that H4 calls.
2. `02-weather-daylight-tool.md`: the Open-Meteo weather and daylight tool.
3. `03-connector-read-depth.md`: Calendar across all calendars, and Gmail full bodies and long threads. It starts with a gap audit, because some reads landed after the ledger was written.

Not delegated: `update_memory`. It has no handler on purpose: the owner's 27 Sep single-write-path decision keeps chat memory writes on the post-reply claim path, and this tool is for nightly dreaming only.

Next candidates once these land:
- Gmail triage and Drive writes, after piece A.
- The S0 re-cut from #908.

## 5. Decisions

**Decided (11 Oct, ~01:30 IST):**
1. **One main conversation per owner** across app, console, Telegram, WhatsApp and iMessage. Threads stay app and console only.
2. **L2 (the event-route session) owns slices 0–7.** The rulings were posted on #1034 ([comment](https://github.com/waldoco/waldo-backend/pull/1034#issuecomment-6106243246)). A direct message to that session did not start within 20 s and may still arrive.
3. **Default delivery is the app, Telegram-linked owners included,** until a "deliver to" setting exists in the app and the console. L3 builds that setting.

**Still open:**
5. **Hand the three briefs to Instinct.** You hand them over; this session cannot message Instinct.
6. **Same permission mode for all Waldo sessions**, so peer messages stop expiring.
