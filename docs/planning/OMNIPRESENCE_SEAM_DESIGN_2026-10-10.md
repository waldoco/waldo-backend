# Omnipresence seam: one owner, any surface

Design, 10 October 2026. Pins: `beta-mvp` `957a2cbb`, #998 `fc4c2b9d`, #915 `2bc64346`. Paths are under `packages/runtime/src/` unless they start with `contracts/` (`packages/contracts/src/`). "DO" is `channels/telegram-owner-do.ts`. Companion to the [website promise ledger](WEBSITE_PROMISE_LEDGER_2026-10-10.md) §2 and Wave 1.

The owner loop already exists (#915 slice C): Telegram, WhatsApp and app turns all enter `this.turn` and one responder implementation, and proactive jobs use `responder.prompt`. This design changes what surrounds the loop: what a turn knows about its surface, what it produces, where the output goes, and the one history it reads and writes.

## 1. What is wrong today

1. **No shared transcript.** Telegram and WhatsApp write the legacy `conv:*` store on separate parent chains (`telegram-<id>`, `whatsapp-<digits>`); the app writes `canonical-owner-v1:<prn>:<ten>:` (`conversation/canonical-owner-store.ts:28`). The model's window walks one chain (`conversation/joined-path.ts:68,116-117`), 100k tokens, oldest dropped first, never compacted (`conversation/window.ts:15-61`). Cross-surface recall rests on memory claims and `search_episodes`.
2. **Proactive work is Telegram-bound.** On directory-backed deploys the alarm returns after `drainApp` unless `telegram_subject` is bound (DO ~:1166-1176), so an app-only owner gets no scheduled work. Every producer uses `this.setup()`, which defaults to `'telegram'` (~:1449). The final outbox is keyed by Telegram `chat_id` (`channels/telegram-final-outbox.ts:195`). Reminders reach the outbox only on Telegram (~:2068); Calendar Prep exits on other channels (~:2276) and its gate requires a Telegram channel (~:2307); standing orders, event briefs and day cards call the Telegram API; ratings exist only as Telegram `fb:` buttons (~:2367).
3. **Approvals can open unseen.** `sayCard` opens a row whenever the sink returns anything (`channels/approvals.ts:119-121`); the app sink returns a fake `{message_id:1}` and drops everything except text (`channels/app-api.ts:203-207`). The desk is built per channel runtime with that channel's numeric subject, and the effect identity uses it (`approvals.ts:100`, `owner-effect-ledger.ts:50-54`), so one proposal decided from two surfaces conflicts.
4. **No push sender.** Device custody exists (`20261010040000`, applied on staging); the runtime calls only `app_push_revoke_session` at signout.
5. **Seams that exist but are unused:** `OwnerTurnEnvelope.presentation/attachments/messageRef/replyTo` (`channels/owner-turn-envelope.ts:25-43`), `ConversationEntry.parentId/threadAnchorId/surface` (`contracts/runtime/conversation-entry.ts:12-27`), `waldoCardSchema` (`contracts/ui/card.ts:51`), `pushNotificationSchema` (`contracts/ui/notification.ts:10`), `channels/surfaces/whatsapp.ts` (imported by nothing).

## 2. Target shape

| Aggregate | Single writer | State |
|---|---|---|
| Surface bindings and presence | `identity/*` and new `channels/surface-presence.ts` | DO SQLite `surface_presence` (last owner message per surface, linked state) |
| Main chat and app threads | `conversation/canonical-owner-store.ts` | DO kv `canonical-owner-v1:<prn>:<ten>:main` and `…:thr_<uuid>` |
| Reply envelopes and deliveries | new `channels/delivery/outbox.ts` (replaces `TelegramFinalOutbox`) | DO kv `owner:outbox:*`, keyed by `(reply_id, surface)` |
| Approvals | one approval desk per DO | DO SQLite `ledger` plus `approval_presentations` |
| Effects | `owner-effect-ledger.ts` | unchanged, except `owner_ref = prn_…` |
| Push devices | signed Supabase RPCs | `waldo.app_push_devices` (Vault) |

**One turn envelope.** `OwnerTurnEnvelope` gains `capabilities: SurfaceCapabilitiesV1` (replacing `presentation`; the prompt reads the same object) and `anchor: { conversationRef, parentEntryId?, replyToRef? }`. Each adapter authenticates, then admits through `surfaceOwnerAdmission`; scheduled work admits the owner binding. The per-channel runtimes become one runtime per DO with per-surface transports, removing the synthetic Telegram update on app turns and the `'telegram'` default.

**Reply parts** (`contracts/runtime/reply-parts.ts`). `ReplyEnvelopeV1 { reply_id, principal_ref, conversation_ref, anchor_entry_id?, origin: turn|proactive, visibility: shared|app_only, custody: durable|volatile_owner_health, urgency?, parts[] }`. Parts: `text`, `card` (`waldoCardSchema`), `approval { approval_id, kind, review, payload_digest, actions, expires_at }`, `quick_replies { choices[{id,label}] }`, `chart_series { title, unit, series, alt_text }`, `file { file_ref, name, mime, bytes, sha256 }`, `artifact { artifact_id, revision }`, `voice { audio_ref, transcript }`. Every non-text part carries `fallback_text`. Parts come from structured tool results and desk proposals, never from parsing reply text. `ui_part` (AG-UI component) is deferred to its own review: the first pin carries only parts the app already renders. Health-derived rows default to `visibility: app_only`.

**Renderers.** `render(envelope, caps) → SurfaceMessage[]`, pure, one per surface under `channels/surfaces/`. A renderer never emits an affordance its capabilities deny; a conformance test enforces it.

| Part | App | Telegram (dev) | WhatsApp | iMessage |
|---|---|---|---|---|
| approval | native card + push nudge | inline buttons | up to 3 buttons | numbered reply or app deep link |
| quick_replies | chips | inline buttons | buttons (≤3) or list (≤10) | short numbered line |
| chart_series | native chart | alt text (image later) | alt text (image later) | alt text (image later) |
| file / artifact / voice | native | document / voice | document / audio | attachment |
| follow-up | app thread or main chat | main chat, reply anchor | main chat, context anchor | main chat, quoted anchor |

**Delivery routing** (`channels/delivery/router.ts`): `route(envelope, presence, prefs) → { primary, mirrors[], nudge? }`. The owner timeline records each reply once under `reply_id`, the single receipt; each surface send is a projection with its own provider receipt. Primary surface: the owner's preference for that kind, else the surface of the owner's most recent message, else the app. Push is a nudge naming `reply_id`, never a body. `volatile_owner_health` custody stays out of the journal, push and mirrors. Quiet hours and the daily cap apply until #915 K replaces them.

**Approvals from any surface.** `propose` writes `card_unconfirmed` and emits an approval part. A row opens only when a renderer records a presentation that showed the full review on a surface whose capabilities allow approvals; a durable app-journal commit counts, a fake ack does not. `decide(id, action, { surface, presentation_id, expected_digest })` accepts Telegram callbacks, WhatsApp selections, iMessage numbered replies, the app route and the console, with the digest equal to the stored payload digest. The first decision wins through the existing status transition; other presentations retire ("Approved in the app"). The executor follows the proposal's destination, not the deciding surface. At cutover, effects in `attempting`/`unknown` still carry the old per-surface `owner_ref`; reconcile reuses the stored identity.

**Context continuity.** Threads and sessions exist in the app and console only. Telegram, WhatsApp and iMessage each keep one main chat, which is the same canonical `…:main` conversation the app shows, with entries stamped by surface. A messaging follow-up continues the main chat anchored through a `message_refs` table (provider ids to entry ids). App threads can reference main-chat entries. For "that one", the composer gets a fenced per-conversation working set after the stable prompt prefix listing the last referents shown across surfaces (approvals, artifacts, cards, files) with surface and time; the model resolves the reference. On overflow, the store writer compacts into a summary entry that keeps receipts instead of dropping the oldest messages. Legacy `conv:*` stays read-only for episodes and is never reclassified as owner input.

**How #915 C and #998 converge.** #915 C delivered the loop; its remainder (surface transports, surface-keyed outbox) and #998 A2 (canonical admission, composer seam, one history) are one change. #998 threads land as app and console threads; #998 `app-delivery.ts` becomes the app renderer with typed parts replacing its Telegram `callback_data` regex; #998 work.v1 becomes the app approval route. #998's DO file is never adopted.

## 3. Contracts, persistence, invariants

**Contracts** (additive, each with zod valid and invalid tests): `contracts/runtime/reply-parts.ts`, `contracts/runtime/surface-capabilities.ts`, new part types and `visibility` in `contracts/app/core.ts`, approvals list and decision routes returning the `/actions` receipt shape with an `exact` block from the frozen payload and `superseded` on digest change, channel status/link/unlink through `/actions`, threads (from #998), push register/revoke, a stable machine-readable `code` on non-generic errors, `imessage` in `channelNameSchema` (ADR-0012 note), optional `replyId`/`providerRefs` on `ConversationEntry`.

**DO persistence** (reserved per `DO-MIGRATIONS.md`): `owner:outbox:*` with a dual read of `telegram_final_outbox_v1` until it drains; `approval_presentations`; `surface_presence`; `message_refs`; `working_set`; the app delivery journal. **Supabase:** a delivery-preference setting and an owner-scoped signed RPC that releases a device token to the push sender.

**Unchanged:** owner authority (directory lookup, physical DO id, per-surface presence recheck); intent before I/O through the effect ledger; exact-payload approvals with a 12-hour TTL; egress guard on every renderer; canaries and taint; health custody and the trace text rule; RunLoopDO and WaldoCoordinator for trusted scheduled runs; no regex for meaning.

## 4. Slices

One slice in flight; `verify` green at every merge. The app lane asked for contracts pinned in this order: message parts and `visibility`, approvals routes, channel status, threads, plus error `code`s. Slice 0 pins them before runtime work.

| # | Scope | Red-first tests | Falsifier | Rollback |
|---|---|---|---|---|
| 0 | Contracts only: reply parts (no `ui_part`), capabilities, `visibility`, approvals list/decision, channel status/link/unlink actions, error `code`s | zod valid/invalid pairs; app fixtures parse | an app-facing field removed or retyped | revert; nothing reads them yet |
| 1 | App renderer replaces `appSinkCaller`; `sayCard` opens only on a recorded presentation; app approvals list and decision route for approvals presented on the app; history merges journal parts | app "move my 3pm to 4" shows an approval part with exact review and digest, row `open`; approve in app gives exactly one effect; a later Telegram tap says already handled; journal failure leaves `card_unconfirmed`; wrong digest refused | an `open` row without a presentation | revert; ledger rows untouched |
| 2 | Surface-keyed outbox, router v0; the alarm admits the owner binding instead of requiring `telegram_subject`; reminders, heartbeat, day cards, update cards (ratings become quick replies), standing orders, event briefs and Calendar Prep emit envelopes | app-only owner: "remind me at 5" arrives in the app; an owner who last spoke in the app gets the Brief there; Calendar Prep runs without Telegram; the outbox crash test passes unmodified | a producer still names a surface | dual-read outbox |
| 3 | One desk per DO; `approval_presentations`; decide from any surface; executor by destination; `owner_ref = prn_…` | propose on Telegram, approve in app: one send, Telegram buttons clear; stale digest refused; truncated review refused with an app deep link; an `unknown` effect at cutover reconciles | two effects for one approval | reads accept both `owner_ref` forms |
| 4 | Renderer interface in `channels/surfaces/` (finishes C-3); WhatsApp and iMessage conformance fixtures, shim retirement agreed with Ashish | every part on every capability set renders or degrades; Telegram's 4,096-character split kept | an affordance emitted that caps deny | per-renderer revert |
| 5 | One main transcript: Telegram and WhatsApp admitted into `…:main`; `message_refs`; skill host on every surface | WhatsApp "book the dentist" shows in the app main chat; a Telegram reply to an app message resolves its anchor; skills load on app turns | two histories after cutover | per-surface flag back to `conv:*` |
| 6 | App and console threads (#998 threads.v1) with main-chat references, working set, compaction | options listed on WhatsApp, "book that one" in an app thread books the right one; overflow compacts and keeps receipts | oldest-first drop still reachable | threads stay empty |
| 7 | Push: register route, owner-scoped token RPC (new migration), APNs sender, router nudge | a Brief to a closed app sends one id-only push; a revoked device gets nothing; volatile health has no push body | a push carries reply text | sender flag off |
| 8 | App rich input/output: attachments and voice in (#998 `app-turn-media.ts`); file, voice and `chart_series` out | an app photo reaches the model; a chart renders natively and degrades on Telegram | the app claims an undelivered part | parts fall back to text |

## 5. Defaults taken (owner may override)

1. **Wave 1 exit surface:** the app plus Telegram as interim development proof; final acceptance repeats on WhatsApp or iMessage once Ashish's adapter or the relay is live.
2. **Legacy history:** start the canonical main chat fresh; legacy `conv:*` stays searchable through episodes and is not imported as entries.
3. **Default routing:** the surface of the owner's last message, else the app with a push nudge; per-kind preferences come with app settings.
4. **Charts on messaging surfaces:** alt text until a rasterizer is chosen.
5. **APNs from Workers:** verify HTTP/2 outbound support when slice 7 starts; use a relay if Workers cannot.
