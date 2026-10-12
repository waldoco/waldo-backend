# A. What the model can do by natural language, per surface, at `889efa27`

> **Later updates (03:49Z), superseding what follows:**
> - #1080 was merged as `cdd906dd` at 03:36Z.
> - L1 deployed it to staging at 03:46Z as Worker `b72928f0`.
> - The owner's store held one old row [reported by L1 and L2], so the overwrite stopped after the first send.
> - This replaces the "#1080 is a draft" status and the advice below to keep the account quiet.

Read-only research for the overnight orchestrator, 12 Oct 2026 (pillar assessment, slice A: surfaces).

**Pins**
- Backend `waldoco/waldo-backend` `origin/beta-mvp` = `889efa27c55a1c6a1ae945d906f791e222778a0b`. Staging Worker `3f059c04` serves it (per the task; not probed).
- App `waldoco/waldo-app` `origin/main` = `6dcba63b8f52c3bc892bbfd13ed6f9e386682719`. This is app #80's merge commit [verified: `gh pr view 80`].
- Source was read from `git archive` copies in the scratchpad. Nothing was built, run, tested, deployed or probed. The only network reads were `gh pr view`, `gh pr diff` and `gh pr list`.

**Labels**
- **[verified]**: I read it at the pinned SHA. Read, not executed.
- **[inference]**: my conclusion from what I read, not observed.
- **[unverified]**: not checked, or not knowable from source (secrets, staging state).
- **[reported]**: a lane, PR or lead claim I did not re-read in source. A kind of unverified.

**Paths**
- `DO` = `packages/runtime/src/channels/telegram-owner-do.ts`
- `rt/` = `packages/runtime/src/`
- `ct/` = `packages/contracts/src/`

No health values, owner identifiers or staging URLs appear in this report.

---

## 1. Re-pin: `4bb040f5` → `889efa27`

```
$ git diff --stat 4bb040f5 889efa27 -- packages supabase
 packages/runtime/src/channels/telegram-owner-do.ts |  21 +-
 .../src/conversation/canonical-owner-store.ts      |  79 +++++--
 .../runtime/test/app-read-failure-code.test.ts     |   6 +-
 .../runtime/test/app-turn-skipped-history.test.ts  | 232 +++++++++++++++++++++
 4 files changed, 306 insertions(+), 32 deletions(-)
```

### What #1075 changed [verified, from the diff]

- **`load()` now skips bad rows.** It is now `read(true)` (`rt/conversation/canonical-owner-store.ts:76`, `:130-134`).
  - A shape-faulted row, whether its witness matches or it has none, is left out and tallied.
  - A loaded row whose stored parent was left out is re-linked, in memory only, to the nearest loaded ancestor (`:103-121`).
  - A skipped leaf resolves to that ancestor.
  - `onSkipped` logs content-free `history_rows_skipped` lines with `orphans` and `leaf` (`:50-54`; `DO:569`).
- **`readForDisplay()`** is now `read(false)`. It keeps each row's stored parent (`:135`).
- **`save()` has two new guards.**
  - It refuses an id that the last read left out, raising `canonical history input conflict` (`:139`).
  - It writes re-linked rows back as stored (`asStored`, `:122-125`).
- **App sends log a fault code.** `drainApp` now logs `{hop:'app_turn', ok:false, code}` for canonical-history faults (`DO:760`).
- **Both strict-load callers move to the skipping load:**
  - app turns (`DO:2137`);
  - scheduled app delivery (`DO:586`).

### New at this pin: a live overwrite hazard [verified]

`commit()` still writes new rows at `count ?? 0` (`canonical-owner-store.ts:150-175`).

- On a store that an older build wrote without a `count` key, a send overwrites an existing `conv:` slot.
- #1080 (draft) fixes this. See §8.
- The owner's staging account lost one row this way at about 02:41Z [reported: overnight log 03:00Z, #1080 body].

### Stale statements in leads 04, 05 and 06

**Lead 04** (`04-harness-context.md`, pinned at `35b7c21b` = `4bb040f5` + docs)
- **Line numbers.** `DO` line numbers are off by −3 after about line 570, and by −4 between 214 and 569. Examples:
  - `:2137` → `2134` (health source)
  - `:2140` → `2137` (canonical history factory)
  - `:2042` → `2039`
  - `:2051` → `2048`
  - `:2080` → `2077`
  - `:2027` → `2024`
  - `:2654` → `2651`
  - `:749-760` → `746-757`

  `canonical-owner-store.ts:59-90` is now `:76-135`.
- **§1.2 step 3 is partly stale.** "Restore … appends all rows" is no longer accurate. Shape-faulted rows are now skipped, and orphans are re-linked in memory.
- **Unchanged.** Findings G1–G12 rest on files the diff does not touch (`owner-turn.ts`, `joined-path.ts`, `context-composer/*`, `tool-loop.ts`, `episodes.ts`), so they stand. I re-verified G1 in §5.

**Lead 05** (`05-backend-capability.md`)
- **§B's central claim is STALE.** It said "App sends and scheduled app deliveries still call the strict canonical `load()` … a send then fails silently". At `889efa27`, both use the skipping, re-linking load. Main chat was verified live on `889efa27` at 02:41–02:42Z [reported].
- **§B "the only code logged is `unknown`" is partly stale.** `drainApp` adds an `app_turn` fault-code line (`DO:760`). I did not re-check the listener's `turnFailureCode`.
- **§B "No test covers a send … over a shape-invalid row" is stale.** `test/app-turn-skipped-history.test.ts` now exists (232 lines) [verified it exists; not run].
- **The other §B items are superseded:**
  - §F gap 1;
  - the §G row "Main-chat history returned 503 … sends … still fail";
  - §J's "the send failure is `load()`".

  The failure class is now `commit()` overwriting a row (#1080), not a strict load.
- **§C quotes a stale head for #1066.** It names `e1ab2881`; #1066 is now at `c8d3190c`, still a draft [verified: `gh pr view 1066`].
- **`DO` line numbers** shift as in lead 04. Examples:
  - `DO:1281-1282` → `1278-1279`
  - `DO:1335-1348` → `1332-1345`
  - `DO:2420` → `2417`
  - `DO:1658` → `1655`
  - `DO:2043/2051/2076/2080` → `2040/2048/2073/2077`
- **§C, §D and §E** (arming, two transcripts, promise rows) are substantively unchanged at `889efa27` [verified for the cited arming and transcript wiring].

**Lead 06** (`06-app-capability.md`, app pin `c2ccd5d0`)
- **§2.4 and §2.6 are STALE.** They say "sends fail for an account with a bad stored row until L2's follow-up" and "scheduled app delivery uses the strict `load()`". #1075 fixed both.
- **§7 C4 is stale.** It says "Staging serves `4bb040f5`"; it now serves `889efa27` [per task pin].
- **§2.7 is stale for the app.** It says "Auto-write at sign-in: not implemented".
  - App #78 implemented the write at `src/agent/controlsController.ts:49-53` [verified at `6dcba63`].
  - The write is still inert: backend `889efa27` has no `timezone_confirmed` producer [verified: grep of `rt/` finds none].
- **§3.5's pin table is stale.** App #80 pinned `core.ts`, `threads.ts` and `devices.ts` from `21a70277` [verified: PR body and files].
  - Message `created_at` is still never emitted by `appTranscriptPage` (`rt/channels/app-api.ts:191-206`) [verified]. So the app still cannot show message times.
- **§2.10 is stale.** It says "every history row shows `message.channel`". After app #79, only rows from other channels carry a label [reported: PR body].

---

## 2. The turn pipeline, per surface [verified unless tagged]

Every talking surface ends in the same `createOwnerResponder` (`rt/channels/owner-turn.ts:75`). It is reached through `createTelegramResponder` (`rt/channels/telegram-turn.ts:23`) and built in `setup(channel)` (`DO:1573`, `DO:2038-2137`). What differs per surface is the inputs.

| | S1 app Main chat | S3 Telegram DM | S6 WhatsApp (code path only) |
|---|---|---|---|
| **Ingress** | `POST /app/v1/chat/main/messages` → `handleApp` (`app-api.ts:165-179`) → DO `appSend` (`DO:736-745`, 202) → `drainApp` (`DO:746-764`) → `this.turn(…,'app',true,scope)` (`DO:758`) | webhook → DO `/enqueue` (`DO:333-409`) → alarm → `drainInbox` (`DO:411-470`) → `this.turn(raw,'telegram',true,scope)` (`DO:460`) | webhook (`whatsapp-webhook.ts:61-113`) → DO `/whatsapp-admit` (`DO:829-862`) → `this.turn(update,'whatsapp')` with **no run scope** (`DO:805`) |
| **Durable run scope** | yes | yes | no |
| **Responder** | fresh scoped responder per turn (`owner-turn.ts:609-616`) | fresh scoped responder per turn | the base responder |
| **History store** | canonical `canonicalOwnerConversationStore` (`DO:2137`) | legacy KV wrapped by the episodes index (`DO:2039`) | legacy KV + episodes |
| **Composer whose prompt reaches the reply** | app composer, sources `{health}` only (`DO:2134`; `DO:595-600`) | trusted-brief composer; only its `healthPrompt` is read (`owner-turn.ts:466`) | as Telegram |
| **Skill host** | none (`DO:2077`: Telegram only) | yes | none |
| **Approval presentation** | app approval parts in history (`app-api.ts:197-205`) | native buttons (`telegram-turn.ts:15`) | `a/s/e/u:<id>` text callbacks |
| **Steering, /stop, slash commands** | none (`DO:1442-1468`) | yes | `/stop` only |

---

## 3. The registered handler set and its gates [verified]

**The list.** The handlers are passed at `DO:2040-2073`. `owner-turn.ts:159` adds:
- `get_context`;
- `read_owner_context`;
- `read_tool_output` (when offload is on);
- skill handlers, when a skill capability exists.

`delegate_task` is added per owner turn (`owner-turn.ts:372-404`).

**Eligibility.** It is computed once per turn (`owner-turn.ts:307`) by `eligibleHandlers` (`rt/tools/eligibility.ts:8-23`). A handler whose `eligible()` returns `not_connected` or `not_configured` is not offered.

**Staging flags.** Read from `packages/runtime/wrangler.jsonc:84`, the committed `env.staging.vars`:

| Flag | Staging value |
|---|---|
| `CALENDAR_GROUNDED_PREP` | `1` |
| `MAIL_SOURCE_FOLLOWUPS` | `1` |
| `DRIVE_READS` | `1` |
| `MCP_READ_INTENTS` | `0` |
| `LANGFUSE_CAPTURE_TEXT` | `true` |
| `WALDO_EGRESS_ALLOWLIST` | `*` |

- No `BROWSER` binding, on purpose (`:78`).
- `ARTIFACTS` R2 is bound (`:95-97`).
- Not in vars: `WALDO_TOOL_OFFLOAD`, so offload is on (`DO:2073`, `!== '0'`), and `WALDO_MCP_SERVERS`.
- Secrets cannot be known from source: Brave, Browserbase, the transcriber, Google, WhatsApp and Telegram.

| Tool(s) | Pillar | Gate | On staging |
|---|---|---|---|
| `get_context` | P4 (clock) | none | offered |
| `read_owner_context`, `read_memory`, `remember`, `forget_memory` | P3 | `remember` and `forget_memory` only on owner turns with memory writes allowed (`owner-turn.ts:307`). Memory tools also require the turn's `conversationRef` to equal `${channel}-${owner}` (`rt/tools/live/memory.ts:41-44`). | offered; owner refs match on the app (`DO:739`, `DO:757`, `DO:2049`) |
| `search_episodes` | P3 | none | offered; searches the legacy episodes index only (`DO:2048`, `DO:1960`) |
| `read_tool_output` | P3 (in-turn only) | `WALDO_TOOL_OFFLOAD !== '0'` | offered; the store is per responder, so ids die with the turn [inference] |
| `delegate_task` | P1 | owner turns only (`withDelegation`, `owner-turn.ts:404`) | offered |
| `open_loop`, `close_loop`, `set_proactivity` | P1, P4 | none | offered |
| `set_reminder`, `list_reminders`, `cancel_reminder` | P4 | none | offered |
| `set_standing_order`, `list_standing_orders`, `cancel_standing_order` | P4 | none | offered |
| `set_schedule_preference` | P4 | none | offered; arms the named kind immediately (`rt/channels/schedule-preferences.ts:57-67`, `:104-111`) |
| `workspace_list/read/search/write/render` | P3 (owner files) | needs a run scope, else it throws `ClosedRunError`, which becomes `handler_failed` (`DO:2032-2037`; `rt/tools/dispatcher.ts:285-296`) | works on S1 and S3; fails on S6 |
| `create_artifact`, `revise_artifact`, `list_artifacts`, `read_artifact`, `export_artifact` | P3 (owner files) | `export_artifact` only with `ARTIFACTS` (`DO:1975`) | offered |
| `query_calendar`, `query_availability`, `propose_calendar_change` | P5 | `granted(calendar)` (`rt/tools/live/google.ts:73-80`) | offered once Google calendar is granted |
| `get_communication`, `search_communication`, `read_thread`, `draft_email`, `send_email` | P5 (send is W2) | `granted(mail)` | offered once mail is granted |
| `get_tasks` | P5 | `granted(tasks)` | offered once tasks is granted |
| `propose_google_task_change` | P5, W2 | none | offered |
| `read_drive` | P5 | `DRIVE_READS === '1'` (`DO:2048`; `drive.ts:30`) | offered |
| `connect_service` | P5 | none | offered; on the app its connect button is dropped (§7, P5) |
| `call_mcp_tool` | P5, W2 | needs a `WALDO_MCP_SERVERS` entry (`mcp.ts:122`) | [unverified]: the var is not committed |
| `read_mcp_tool` | P5 | `MCP_READ_INTENTS === '1'` plus servers (`mcp.ts:182`) | **not offered** (`0`) |
| `web_search` | P5 | none; it fails `auth_failed` without the Brave key (`web-search.ts:20-21`) | offered; key [unverified] |
| `browse_page`, `browse_act` | P2 | eligible on staging regardless (`owner-browser-runtime.ts:47-48`) | offered; see §7, P2 |
| `send_message` | P6, W2 | proposes only (approval desk) | offered |
| `log_meal`, `log_workout`, `list_health_logs` | W1 | none; the RPCs check the router signature only, no consent (`supabase/migrations/20260927000000_waldo_health_logs.sql:23-50`) | offered |
| `skills_list`, `skills_load`, `skills_install`, `skills_disable` | P3 | skill capability (Telegram durable turns only; `DO:2077`, `DO:2112-2113`; `rt/skills/curated-host.ts:40-49`) | S3 only |

**ACL tools with no handler.** These are in `TOOL_PERMISSIONS.user_message` (72 names, `ct/tools/permissions.ts:194-266`) but have no owner-chat handler at `889efa27` [verified by set difference against the registrations above]. There are 19:

`get_crs`, `get_health`, `get_master_metrics`, `search_connector`, `read_document`, `draft_document`, `write_task`, `update_task`, `propose_schedule`, `write_sheet_cell`, `propose_action`, `execute_action`, `create_thread`, `delete_message`, `restore_message`, `archive_thread`, `update_thread_topics`, `search_tools`, `track_responsibility`.

- `track_responsibility`'s handler factory exists but is never registered.
- `RUN_LOOP_DO` is reachable only through the responsibility public API, which needs `RESPONSIBILITY_PUBLIC_API_ENABLED === 'true'` (`rt/index.ts:224-247`, `:274`). It is not reachable from chat.

---

## 4. Per-surface manifests

### S1: app Main chat [verified]

**Route to the model call.** `handleApp` checks the bearer and the rate limit, then forwards to the owner DO (`app-api.ts:139-179`). From there:
1. `appSend` binds `app_subject` and admits the inbox record (`DO:736-745`).
2. `drainApp` claims it, builds a `RunEffectScope`, and calls `turn('app', durable, scope)` (`DO:746-764`).
3. `listener.handle` calls `respond`, which builds a scoped responder with:
   - a context host, `appContext` with `{health}` (`DO:2129-2136`);
   - canonical history (`DO:2137`).
4. `restored()` runs the skipping `load()` (`owner-turn.ts:556-557`).
5. The owner input is persisted (`:581`).
6. `JoinedConversationPath.submit` composes, windows and calls the model (`joined-path.ts:64-78`).
7. The tool loop runs (`owner-turn.ts:405-511`) and calls `OpenAIResponsesAdapter` (`:186`).
8. The reply and receipt line are saved to `appPayload` (`:593-597`). The app reads them back by polling the receipt and the history.

**Manifest.** These 49 names are registered:

`get_context`, `read_owner_context`, `read_tool_output`, `delegate_task`, `remember`, `read_memory`, `forget_memory`, `search_episodes`, `workspace_list`, `workspace_read`, `workspace_search`, `workspace_write`, `workspace_render`, `create_artifact`, `revise_artifact`, `list_artifacts`, `read_artifact`, `export_artifact`, `set_reminder`, `list_reminders`, `cancel_reminder`, `set_standing_order`, `list_standing_orders`, `cancel_standing_order`, `set_schedule_preference`, `set_proactivity`, `open_loop`, `close_loop`, `log_meal`, `log_workout`, `list_health_logs`, `query_calendar`, `query_availability`, `propose_calendar_change`, `get_communication`, `search_communication`, `read_thread`, `draft_email`, `send_email`, `get_tasks`, `propose_google_task_change`, `read_drive`, `connect_service`, `web_search`, `browse_page`, `browse_act`, `send_message`, `call_mcp_tool`, `read_mcp_tool`.

On staging, the turn offers fewer:
- `read_mcp_tool` is off;
- `call_mcp_tool` only if servers are configured [unverified];
- the 9 Google tools only once granted.

**How S1 differs from S3:**
- no `skills_*`;
- no workspace-receipt task context;
- the app composer's REASONS reaches the reply, but tool outputs are empty (§5);
- `search_episodes` never sees app chat;
- no reactions or steering;
- text only: the app runtime's media download throws `app chat has no attachments` (`DO:1988-1989`), and the send contract is strict `{client_message_id, text}` (`ct/app/core.ts:34-36`).

**The result depends on the owner type:**

| Owner type | Who | What differs |
|---|---|---|
| Telegram-linked | The owner's account, the only verified-live one | Browsing passes the owner check. Every scheduled job except reminders delivers on Telegram (`DO:1270-1279`, `DO:1332-1345`). |
| App-only | An invited tester | Every `browse_*` call is rejected (`owner-browser-runtime.ts:56-60`). Proactive jobs are not armed at sign-in (`DO:2024`). |

### S2: app UI with no model [verified]

**Served routes** (`app-api.ts:102-185`; `app-controls.ts:28-91`; `app-approvals.ts`):

| Area | Routes and actions |
|---|---|
| Identity | `auth/code`, `auth/verify`, `session`, `auth/signout` |
| Health | `health/consents` (GET, POST), `health/consents/withdraw`, `health/ingest`, `health/scores` |
| Chat | `chat/main` (GET), `chat/main/messages/{id}` (GET receipt) |
| Views | `controls?view=day\|connections\|activity\|account\|constellation` |
| Actions | `timezone.set`, `proactivity.set`, `google.connect`, `account.delete`. `channel.unlink` is in the contract but refused (`app-controls.ts:83`). |
| Receipts | `actions/{id}` (GET) |
| Approvals | `approvals` (GET), `approvals/decisions` (POST). `defer` is refused with 409 (`app-approvals.ts:45-46`). |

**App screens that use them at `6dcba63`:**
- Wired: sign-in (email code + invite), Home, Main chat, Schedule, Connections, Health agreements, Body/scores, Approvals, Account.
- The app's controllers request only the `day`, `connections` and `account` views (`src/agent/*Controller.ts`). `activity` and `constellation` are served but never requested.
- Stubs (`UnavailableFeature`): Brief, Constellations, Patrol, Spots, health detail (`app/(app)/*.tsx`).

### S3: Telegram owner DM [verified]

- **Manifest:** the S1 set plus `skills_list`, `skills_load`, `skills_install` and `skills_disable`. That is 53 registered names.
- **History:** legacy KV, indexed for episodes, so the Telegram transcript feeds `search_episodes` and nightly.
- **All four scheduled jobs are armed** at runtime `ready` (`DO:2024`): nightly, the brief sweep, day cards and heartbeat.
- **Prep and update cards run only here.** On staging, Prep (grounded) and update cards run only on this channel (`DO:2417`).
- **Commands answered without the model** (`DO:1462-1513`; `rt/channels/harness.ts:12-28`): `/stop`, `/ledger`, `/trace`, `/e2e`, `/usage`, `/langfuse`, `/fire`, `/heldrows`, `/console`.
- **Owner ruling:** Telegram is a dev surface.

### S4: iMessage. **Absent.** [verified]

- `rt/channels/imessage/{admission,ingress,media,relay-ingest}.ts` exist, but nothing in `rt/` imports them.
- No route, binding or wrangler entry.
- No migration: the presence provider CHECK is `('telegram','console','ios','whatsapp')` (`supabase/migrations/20260925110000_waldo_whatsapp_presence.sql:4`). The candidate migration lives in `docs/channels/imessage/migration-proposal/` and is only dry-run tested.

### S5: inbound email. **Absent.** [verified]

- The Worker default export has `fetch` and `scheduled` only, with no `email()` handler (`rt/index.ts:165-252`).
- No email route or email presence provider exists (grep of `rt/`, `ct/` and the migrations).
- Email reaches Waldo only through the Gmail connector tools and the mail follow-up sweep. On the app channel, that sweep is skipped (`DO:2417`).

### S6: WhatsApp. **Code path exists; no owner can link it.** [verified]

- **What exists:**
  - the webhook (`rt/index.ts:179-181`; `whatsapp-webhook.ts:61-113`);
  - the DO admission (`DO:829-862`);
  - `setup('whatsapp')` (`DO:1588`, which throws without its secrets);
  - the `whatsappTelegramShim` caller (`DO:1648`).
- **Why no owner can link:**
  - Routing needs a `whatsapp` presence (`whatsapp-webhook.ts:90`).
  - A presence comes only from redeeming a `whatsapp` link code. Redemption matches on provider (`supabase/migrations/20260924120000_waldo_owners.sql:85`).
  - The only issuer, `waldo.issue_link_code`, hard-codes `'telegram'` (`20260924130000_waldo_console_auth.sql:47`). No later migration redefines it.
- **What the manifest would be, if a presence existed:**
  - the S3 set minus `skills_*`;
  - turns are not durable (`DO:805`, no scope), so `workspace_*` fail as `handler_failed` and `browse_*` are rejected (`owner-browser-runtime.ts:56-60`) [inference from the code paths];
  - audio in is supported.

---

## 5. G1 re-verified at `889efa27` (both paths) [verified by reading; not executed]

- **The ledger is written each turn.** Tool outputs go to the ledger at turn end (`owner-turn.ts:508`, `:598`).
- **The ledger is read only by the trusted-brief composer.** Its `toolOutputs` source feeds that composer (`owner-turn.ts:140-142` → `rt/run-loop/adapters.ts:153`, `:362`).
- **App path: the section is always empty.**
  - The context host's composer is `createOwnerTurnContext` with `{health}` only (`DO:2134`).
  - So `tool_outputs` is `[]` (`rt/context-composer/owner-turn.ts:70-71`).
  - REASONS reaches the reply as `reasons` (`owner-turn.ts:458`, `:463`), and `<recent-tool-results>` renders "No recent tool results." (`rt/context-composer/prompt.ts:190-198`).
- **Telegram path: the section is discarded.**
  - `JoinedConversationPath` passes the trusted-brief composition as `request.system` (`joined-path.ts:64`, `:73`).
  - The reply callback never reads `request.system`. Its only reads of `request.*` are `skillPrompt` (`:462`) and `composition.healthPrompt` (`:466`) [verified by grep]. It builds its own system prompt (`:461-489`).
- **Inside a turn, results do reach the reply.** Tool turns are replayed to every round (`rt/conversation/tool-loop.ts:91`, `:180`; `owner-turn.ts:492-499`).
- **Across turns, only reply prose carries a result:**
  - History holds user and assistant text.
  - Receipt lines go only into the app row's `appPayload`, never `modelPayload` (`owner-turn.ts:593-597`).
  - No tool lists approvals or receipts.
- **Corroboration:** #1079 (draft, test only) reports the same result with one seeded ledger row and real DO turns on both paths [reported].

---

## 6. The natural-language matrix

### How to read it

**The tests:**
- **t1:** the tool or route is in that surface's per-turn manifest on staging config.
- **t2:** its handler does the real thing on staging: not a fake, stub, local-only path or flagged-off feature.
- **t3:** the result reaches that turn's reply, and a later turn can recover it from a durable store, through a re-read tool or a prompt section re-read every turn. Under G1, this fails only where nothing can re-read the result: one-shot web or page reads, sub-agent reports, and approval or receipt state.

**The cell values:**
- `yes`: all three tests pass.
- `partial(<test>)`: names the failing test.
- `UI-only`: the capability exists only as app screens and routes.
- `no`: none of it works on that surface.
- `n/a`: the surface is absent, or no owner can link it.
- `—`: not applicable.

**Notes:**
- **P7 and P8 are not natural-language capabilities** in this codebase. No tool reads identity, payments, traces or evals. Their S1 and S3 cells say `no` for natural language; §7 says what exists instead.
- **A split cell** reads "app-only owner / Telegram-linked owner".

| | S1 app Main chat | S2 app UI | S3 Telegram DM | S4 iMessage | S5 inbound email | S6 WhatsApp |
|---|---|---|---|---|---|---|
| **P1** Durable workflows | partial(t2, t3) | no | partial(t2, t3) | n/a | n/a | n/a (unlinkable) |
| **P2** Computer use | no / partial(t2, t3) | no | partial(t2, t3) | n/a | n/a | n/a (unlinkable) |
| **P3** Memory and skills | partial(t1, t2) | no (route only; stub screen) | **yes** | n/a | n/a | n/a (unlinkable) |
| **P4** Triggers and scheduled jobs | partial(t2) | UI-only | **yes** | n/a | n/a | n/a (unlinkable) |
| **P5** Connectors and auth | partial(t2) | UI-only | **yes** | n/a | n/a | n/a (unlinkable) |
| **P6** Text and voice | partial(t2) | — | partial(t2) | n/a | n/a | n/a (unlinkable) |
| **P7** Payments and identity | no | UI-only (identity only) | no | n/a | n/a | n/a (unlinkable) |
| **P8** Evals and observability | no (traced; no eval covers this path) | no (route only) | no (slash commands, no model) | n/a | n/a | n/a (unlinkable) |
| **W1** Health plane and consent | partial(t2) | UI-only | partial(t2) | n/a | n/a | n/a (unlinkable) |
| **W2** Approvals and authority | partial(t2, t3) | UI-only (defer refused) | partial(t2, t3) | n/a | n/a | n/a (unlinkable) |

**Counts (strict, all three tests):**
- **S1, the product surface: 0 of 8 pillars, and 0 of 10 rows.** P5 is the nearest miss: for an owner already connected from the Connections screen, it is yes except connecting or reconnecting from chat, which fails silently.
- **S3, the dev surface: 3 of 8** (P3, P4, P5), and 3 of 10 rows.
- S2 carries P4, P5, P7 (identity), W1 and W2 as screens.

If G1 were fixed:
- S1's P1 would still fail t2, because no durable job runner is reachable from chat.
- W2 would still fail t2.

So G1 alone flips no S1 cell.

---

## 7. Why each cell is what it is

### P1 Durable workflows

**Tools:** `delegate_task`, `open_loop`, `close_loop`.

**S1 and S3: partial(t2, t3).**
- **t1 passes.**
- **t2 fails.**
  - `delegate_task` runs a read-only child loop inside the same turn, sharing its 25-round budget (`owner-turn.ts:371-404`). It does not outlive the turn.
  - Open loops are records. The heartbeat lists past-due loops with no model call and no effect, and on S1 it is unarmed for app-only owners (`DO:2024`).
  - No model-startable durable job exists:
    - `track_responsibility` is unregistered;
    - `RunLoopDO` sits only behind the responsibility public API (§3);
    - Kennel is a fake executor [reported, lead 05 CN-9].
  - The durable pieces that do exist are not workflows the model starts: turn admission and run scopes, and approval-desk continuations.
- **t3 is mixed.** Loops pass, because their section is re-read into the head every round (`owner-turn.ts:424-427`, `:470`). Sub-agent reports are one-shot and fail.

**S2: no.** `view=activity` would show runs, but the app never requests it.

### P2 Computer use

**Tools:** `browse_page`, `browse_act`.

**S1, app-only owner: no (t2).**
- Both tools are offered on staging regardless of providers (`owner-browser-runtime.ts:47-48`).
- But `current()` throws without a `telegram_subject` (`:56-60`), so every call returns `rejected`.
- #1032's audit reports the same [reported].

**S1 (Telegram-linked owner) and S3: partial(t2, t3).**
- **What I verified is narrow.** The default path fails, and app-only owners are always rejected. Browsing works only if the model explicitly picks Browserbase and its secrets are set. The owner's 10 Oct latency note says `browse_page` dominated turn latency, which suggests it did run on staging then, likely on Browserbase [reported].
- **The default is Cloudflare,** and it fails. On staging the default provider is `cloudflare_playwright` (`browser-public-read-configuration.ts:20-27`). The fresh-read path returns `auth_failed` without `env.BROWSER` (`owner-browser-runtime.ts:153`), and staging deliberately has no binding (`wrangler.jsonc:78`).
  - Browserbase runs only when the model explicitly picks it (`:138`). Its secrets are [unverified].
  - Native `browse_act` commands need the Cloudflare host.
  - Submits always go to the approval desk.
- **No desktop operation exists:**
  - The device bridge handles only `machine_state_query` and `notify_local` [reported, lead 05].
  - Kennel is a fake executor [reported].
- **t3 fails.** Page reads are one-shot.

**S2: no.**

### P3 Memory and skills

**S1: partial(t1, t2).**
- **t1:** no `skills_*` on the app.
- **t2:**
  - `search_episodes` searches the legacy index. It holds Telegram and WhatsApp turns and scheduled machine turns, but never app chat (`DO:2039` vs `DO:2137`; `DO:2048`).
  - Nightly consolidation reads only that index (`episodes.since`, `DO:2314`) [verified]. Its owner side counts only `tg-` ids as owner (`rt/channels/episodes.ts:21`) [verified].
  - `remember`, `read_memory` and `forget_memory` work: owner refs match on the app (`memory.ts:41-44`; `DO:739`, `DO:2049`).
- **t3 passes.** The memory profile is re-read into every turn's prompt (`owner-turn.ts:474`).

**S3: yes.**
- Memory tools, curated skills (`curated-host.ts:40-49`), episode search over Telegram history and nightly all work.
- Caveats, on both paths:
  - The profile is chosen by recency (lead 04 G8).
  - `remember` grounds only on the current message, because every durable turn builds a fresh responder (`owner-turn.ts:160-166`, `:609-616`).

**S2: no.** The constellation route is served (`app-controls.ts:51-58`), but the app screen is a stub at `6dcba63`. No memory actions exist in the app enum (`ct/app/controls.ts:26`).

### P4 Triggers and scheduled jobs

**S1: partial(t2).**

| Owner type | What works | What doesn't |
|---|---|---|
| App-only | Reminders fire into app chat (alarm on the app channel, `DO:1278-1279`; tested for reminders) | Standing orders on the app are untested [inference: they fire]. Nothing is armed at sign-in (`DO:2024`). `timezone.set` arms nightly only (`DO:2647-2651`). Asking "turn my daily brief on" through `set_schedule_preference` would arm cards or heartbeat in the fallback zone [inference from `schedule-preferences.ts:57-67`]. Prep, update cards and mail follow-ups never run on the app channel on staging (`DO:2417`). |
| Telegram-linked | Reminders, including ones set in app chat, deliver to the app (`DO:1332-1345`) | The Brief, day cards, heartbeat and Prep deliver on Telegram, not S1 |

- **t3 passes.** Reminders are re-listable, and delivered rows land in canonical history (`DO:571-593`).

**S2: UI-only.**
- The Schedule screen offers `timezone.set` and `proactivity.set`, read-only schedule switches, and today's cards.
- `latest` and `timezone_confirmed` are unproduced.

**S3: yes.** Every job is armed at `ready` (`DO:2024`), and grounded Prep and mail follow-ups are on (`wrangler.jsonc:84`).
- **Caveat.** On an app-bound account like the owner's, a reminder set in Telegram delivers to the app, not Telegram (`DO:1332-1345`). The cell stays yes.

### P5 Connectors and auth

**S1: partial(t2).**
- **Reads and writes work.** Google reads and writes are offered once granted, and they are real.
- **Connecting from chat fails silently:**
  1. `connect_service` returns `auth_required`.
  2. The tool loop calls `offerConnect`, which calls `deliverConnectLink` and sends a URL button (`DO:1672-1683`).
  3. `appCaller` returns `{message_id:1}` for any send without a callback button when no scheduled delivery is set (`surfaces/app.ts:17-24`). So the button goes nowhere, and the offer is logged as sent.
  4. The model is told "A connect button is in the chat (or was just sent)" (`google.ts:38`).
  5. A reauth offer also writes `google:reauth-noticed`, which suppresses later reconnect offers (`DO:1694-1709`).
- **Other tool states:**
  - `read_mcp_tool` is off;
  - `call_mcp_tool` and `web_search` depend on unknown secrets.
- **t3:** Google re-reads pass. `web_search` is one-shot.

**S2: UI-only.**
- Connections offers `google.connect`, which leads to `/c/<ticket>`.
- It is unproven end to end on staging [reported, L3 batch item 4].
- There is no disconnect.

**S3: yes.**
- Connecting goes through a Telegram URL button.
- The tools are the same as S1.
- Caveats [reported, lead 05]:
  - calendar writes go to the primary calendar only;
  - there is no Gmail triage and no attachments.

### P6 Text and voice

**S1: partial(t2).**
- The app chat is text only (`ct/app/core.ts:34-36`; `DO:1988-1989`).
- There is no speech in or out.
- Replies appear only through receipt polling or a history refresh.
- There is no push: `/devices*` answers 404 (`app-api.ts:180`).

**S3: partial(t2).**
- Telegram supports text, voice and audio in (transcriber secret [unverified]), and photos and documents.
- There is no speech out.

### P7 Payments and identity

**S1 and S3: no.**
- There is no payments code: a grep for stripe, payment and checkout finds only the browser's irreversible-action guard (`rt/tools/live/browser.ts:173`).
- There are no identity tools.

**S2: UI-only.**
- Identity runs on the screens: email code plus invite, session, sign-out and account deletion.
- The session lasts 12 h with no refresh [reported, lead 05].
- There is no Google sign-in.

### P8 Evals and observability

**S1: no.**
- App turns are traced: `log` writes `trace_log`, the console and Langfuse OTLP, with text capture on in staging (`DO:1591-1623`).
- No eval or scenario drives the app path:
  - `rt/../evals/run.ts:86` and `scenarios/run-l1.ts:118` both use `createTelegramResponder` without a context integration;
  - live evals are in no package script (`package.json:21`; `packages/runtime/package.json:17`).

**S2: no.** The `activity` view is served but never requested.

**S3: no.** Telegram has slash commands answered without the model. The L1 scenarios (scripted gateway) run in `pnpm verify` against this legacy path.

### W1 Health plane and consent

**S1 and S3: partial(t2).**
- **What works.** When both grants are live, the composer admits the health material (`health_context_read` needs `model_processing`, `health_plane.sql:541`, `:548`), rendered as zone, trend, freshness and descriptors only, no scores (`prompt.ts:169-188`). That passes t3, because it is re-read every turn.
- **What fails:**
  - There is no health read tool: `get_health` and `get_crs` have no handler.
  - `log_*` writes go to `waldo.health_logs`. The score producer never reads that table [reported, lead 05], and its RPCs check no consent [verified].
  - On the owner's staging account, `model_processing` is reportedly off [reported, ledger].

**S2: UI-only.** The app offers consents, ingest and scores. The iOS permission is not linked into the flow [reported, lead 06 C1].

### W2 Approvals and authority

**S1: partial(t2, t3).**
- **t1 passes.** Proposals by chat are in the manifest: `send_email`, `propose_calendar_change`, `propose_google_task_change`, `send_message`, `call_mcp_tool`, and `browse_act` submits.
- **The basic flow works.** Approval cards render in app chat (`app-api.ts:197-205`), and decisions go through `/approvals/decisions`.
- **t2 fails:**
  - **"Not now" is refused** with 409 (`app-approvals.ts:45-46`).
  - **Expired proposals still show as open.** They project as `open` with approve actions, because expiry is written only inside a decision (`approvals.ts:324-334`, `:399-402`). L4 observed two such 9 Oct requests on staging [reported, L3 batch 1b].
  - **There are no standing grants:** all loop policies are L0 [reported, lead 05].
- **t3 fails.** Receipts never reach `modelPayload`, and no tool lists approvals, so "did you send it?" depends on reply prose.

**S3: partial(t2, t3).**
- Telegram's "Not now" means skip.
- A proposal whose review exceeds 3,800 characters cannot be approved on Telegram (`approvals.ts:120`).
- t3 fails the same way as on S1.

**S2: UI-only.** The Approvals screen offers approve, skip, edit and undo; defer gets a 409.

---

## 8. Pending changes, and which cells each would move

### Backend PRs [verified state via `gh`; effects from the diff file lists and bodies, inferred]

| PR | State | Effect on cells |
|---|---|---|
| **#1066** | draft, `c8d3190c` | **P4 × S1 for app-only owners.** `timezone.set` confirms the zone and arms nightly, heartbeat and day cards. The app channel holds jobs until the zone is confirmed. Event briefs are never armed on the app. The day view emits `timezone_confirmed`, which makes app #78's auto-write live.<br>• P4 × S1 moves toward `yes` for reminders, cards and heartbeat. It stays partial for Prep, update cards and mail follow-ups.<br>• It doesn't change Telegram-linked owners' routing or the `appBound` gate.<br>• It carries a W1 HOLD: health-log lines in the day-card machine prompt go to `conv:*` and episodes. |
| **#1072** | draft | Test only. None. |
| **#1076** | draft, held for an ALTER plus owner questions | **W2 × S1 and S2.** "Not now" is recorded as a defer instead of a 409. Telegram is unchanged, and nothing re-presents a deferred item. W2 stays partial (t3, expiry). |
| **#1077** | docs | None. |
| **#1078** | draft | **P8 × S1 and S3**, observability only. It counts history cuts on `llm_reply`. No natural-language change. |
| **#1079** | draft, test only | None. It pins t3's G1 failure on both paths, and a fix must flip it. |
| **#1080** | draft, `f17be611` | **S1 integrity.** New rows go after the last stored slot, which stops the history overwrite. No pillar cell flips. |
| **#1032** | draft, docs | None. It is the plan for P2 on any surface (B0–B10). |

### App

| PR | State | Effect on cells |
|---|---|---|
| #78 | merged | P4 × S1 and S2. It writes the zone once when the server reports it unconfirmed and on UTC. Inert until #1066 deploys. |
| #79 | merged | Cosmetic: channel labels. None. |
| #80 | merged | Pins C1: threads, devices, cancel, ratings, `created_at`. Nothing calls them and the backend serves none, so no cell changes. |
| #29 (open) | | Dev-only Simulator health seeder. None. |
| #27 (open) | | Docs. None. |
| #16 (open draft) | | Stale checkpoint. None. |

### L3's local branches [reported, `L3_MORNING_BATCH_2026-10-12.md`]

| Branch | Effect on cells |
|---|---|
| `l3/reminder-push-contract` `a8882b36` | Contract only (a `reminder` push class; `set_reminder.urgent` refused until stored). No cell flips until an APNs sender exists. It touches P4 and P6 later. |
| `l3/approval-expiry-on-read` `93de9d5d` | **W2 × S1, S2 and S3.** It closes expired approvals on read, so "2 waiting" stops being stale. Its wall was pending. |
| `adr/0068-…` (brain) and the approvals proposal (A/B/C) | Contract and docs. W2 later. |
| Google connect readiness (item 4) | P5 × S2 is wired but not proven. Unchanged. |
| `l3/brief-latest-reader` `49008f8b` | P4 × S2: the day card's `latest` excerpt. It waits on L2's PR and #1066. |

---

## 9. Top 10 findings, ranked by how much they change the answer

1. **On the app, no pillar passes all three tests.** [verified wiring] S1 scores 0 of 8. Telegram, the dev surface, scores 3 of 8 (memory and skills, triggers, connectors). The agent is more complete on the surface the owner ruled a dev surface than on the product surface.
   - The nearest miss is P5. For an owner who already connected Google from the Connections screen, P5 on S1 passes everything except connecting or reconnecting from chat, which fails silently. The owner's own account may be in that state.
2. **G1 holds on both paths at `889efa27`.** [verified by reading; #1079 reported]
   - Earlier tool results never reach the reply.
   - Approval and receipt state is invisible to the model on later turns.
   - So W2 fails t3 everywhere, and follow-ups ("that one", "did you send it?") ride reply prose.
3. **Browsing on staging works only if the model explicitly picks Browserbase and its secrets are set.**
   - A 10 Oct note suggests it ran then [reported].
   - The default Cloudflare path fails: staging has no binding by design [verified].
   - App-only owners are always rejected, for lack of a Telegram link [verified].
   - No desktop operation exists.
4. **Proactivity splits by owner type, and the app loses either way.** [verified]
   - App-only owners get reminders only, unless they ask or visit the console.
   - Telegram-linked owners (the verified-live account) get the Brief, cards, heartbeat and Prep on Telegram, and only reminders in the app.
   - #1066 plus app #78 fix arming for app-only owners only.
5. **Connecting Google from app chat fails silently.** [verified]
   - The button is dropped.
   - The model is told it was sent.
   - A reauth attempt suppresses later offers.
   - Connecting works only from the Connections screen.
6. **Only two talk surfaces exist.** [verified]
   - iMessage has no importer, route or migration.
   - Inbound email has no handler.
   - WhatsApp is coded but unlinkable: the link-code issuer hard-codes `'telegram'`.
7. **App chat is a second-class transcript.** [verified]
   - `search_episodes` and nightly consolidation never see it.
   - Skills are Telegram-only.
   - App and Telegram histories don't meet.
8. **A live data-loss hazard is on S1.** [verified code; incident reported] `commit()` writes at `count ?? 0`, and #1080 is pending. The leads' "sends fail on a bad row" is stale: #1075 fixed it.
9. **The approval loop on the app is incomplete.** [verified]
   - "Not now" gets a 409.
   - Expired proposals are served as open with approve actions.
   - Fixes are pending: #1076 (held) and L3's expiry branch (local).
10. **Health and evals are thin.** [verified]
    - Chat sees health zone words only, with no read tool.
    - Health-log RPCs skip consent.
    - No eval or scenario exercises the app path. Live evals are in no script.
    - Nothing in P7 or P8 is reachable by natural language.

---

## 10. Evidence, inference, unverified

**Observed** (read at `889efa27` or `6dcba63` unless noted):
- `git diff` between `4bb040f5` and `889efa27`.
- The files cited above:
  - `DO`: setup, ingress, alarm, app, WhatsApp, offer-connect;
  - `owner-turn.ts` (all of it), `telegram-turn.ts`, `joined-path.ts`, `context-composer/owner-turn.ts`, `prompt.ts` (health and tool-output rendering), `tool-loop.ts`, `tools/dispatcher.ts`;
  - `canonical-owner-store.ts`, `eligibility.ts`, the handler files, `owner-browser-runtime.ts`, `browser-public-read-configuration.ts`, `surfaces/app.ts`, `app-api.ts`, `app-controls.ts`, `app-approvals.ts`, `approvals.ts`;
  - `schedule-preferences.ts`, `whatsapp-webhook.ts`, `index.ts`, `wrangler.jsonc`;
  - the link-code, presence, health-plane and health-log migrations;
  - `ct/tools/permissions.ts`, `ct/app/controls.ts`, `ct/app/core.ts`;
  - `evals/run.ts`, `scenarios/run-l1.ts`;
  - the app controllers and stub screens.
- `gh pr view` and `gh pr diff --name-only` for backend #1066, #1072, #1076, #1077, #1078, #1079, #1080 and #1032, and for app #78, #79 and #80. `gh pr list` for open app PRs.
- `L3_MORNING_BATCH_2026-10-12.md`.

**Inference:** tagged inline. The main ones:
- standing orders firing on the app;
- `set_schedule_preference` arming cards for an app-only owner;
- WhatsApp's hypothetical manifest;
- `read_tool_output` ids dying with the turn.

**Unverified:**
- Every secret-dependent state: Brave, Browserbase, the transcriber, Google client, Telegram and WhatsApp tokens, `WALDO_MCP_SERVERS`, `COMMON_BROWSER_REGISTRATION`, `RESPONSIBILITY_PUBLIC_API_ENABLED`.
- Staging behaviour beyond the reported Main-chat sends.
- Whether tests pass at `889efa27`: none were run.
- Lead claims tagged [reported]: Kennel fake, device-bridge scope, the producer ignoring health logs, the 12 h session, the expired-approvals sighting, the overwrite incident, and the 10 Oct note that `browse_page` ran on staging.
