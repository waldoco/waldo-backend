# One Waldo across surfaces: one timeline, one approval rule, numbered iMessage approvals, one capability list (25 October 2026)

Status: **proposed design**, no runtime code. It designs four owner rulings of 25 October 2026 for the backend, contracts, app, console, iMessage and WhatsApp. The build PRs in §6 are reviewed against it.

Source pin: `origin/beta-mvp` `296aee94`. Paths are under `packages/runtime/src/` unless they start with `contracts/` (`packages/contracts/src/`), `test/` (`packages/runtime/test/`) or `docs/`. Labels: **[verified]** read in source at the pin, or observed in a run named here; **[inference]** a conclusion from verified facts; **[proposed]** this design.

## 0. The rulings and what this note covers

The owner ruled on 25 October 2026 (about 10:10Z, corrected about 10:20Z):

1. **One conversation timeline.** Every message from every user surface lives in one owner timeline. The app and the console show all of it, and each message is labelled with its surface.
2. **One approval rule.** Anything sent to another person needs the email check from the last two hours, in the app and in the console. On iMessage and WhatsApp, Waldo hands those sends to the app with a link. Low-risk approvals, such as holds on the owner's own calendar, stay one tap everywhere.
3. **iMessage approves by numbered reply** ("1 to send, 2 to skip"), under rule 2.
4. **One honest capability list per surface.** The model and the routing read the same list, so Waldo never promises what a surface can't do.

**User surfaces** are the app (the default), the console, iMessage and WhatsApp. **Telegram** is internal, used only for the team's own testing. It gets no user-facing design here. Where code must say something about it, it is treated as one more chat surface, with no Telegram-only branch (`CLAUDE.md:16`).

On the team's cross-surface tracker these items are row 1 (timeline), row 3 (approval rule and numbered replies) and row 6 (the capability list). Row 2 ("where Waldo writes") was closed by the 10:20Z ruling; §5 says what that leaves unchanged. Row 4 (health on iMessage) waits on the Photon data-agreement question in PR #1463. It is not designed here, but it gates part of item 1 (§1.2.6).

| Item | The real gap today | Design in one line | PRs (§6) |
|---|---|---|---|
| 1. Timeline | The app already **shows** iMessage rows. The model's window walks only the turn's own chain. WhatsApp writes the legacy store. Console rows are labelled `app`. | One main chain `owner:<principal>` that every user surface's turns read and write, split from the per-surface delivery binding. Cut over forward only, behind a per-surface switch. | D, E |
| 2. Approval rule | Only the console checks the two-hour step-up (#1541). Chat surfaces can approve sends with buttons. | One audience predicate in the approval desk. `decide` refuses an approve that reaches other people unless the deciding surface brings a fresh proof. Chat surfaces never bring one. | B, E |
| 3. Numbered replies | iMessage turns use the app's desk, so cards never reach iMessage. | iMessage cards go through the iMessage final outbox and arm when delivered. An exact `1` or `2` on the armed card decides it before any model turn. | C |
| 4. Capabilities | Three tables disagree. The one the model reads is a literal in `telegram-turn.ts:16`. | One directional table in contracts plus a runtime resolver. The turn presentation, the prompt, the desk and delivery read only the resolver. | A |

## 1. One conversation timeline

### 1.1 Today

**Storage and chains.**
- **App and console share one chain**, `owner:<principal>` [verified]. `ownerChainRef` maps the app to it (`context-composer/owner-turn.ts:43`), and it is the default `conversationRef` (`context-composer/owner-turn.ts:128`). The console chat is the app's main chat reached with the console sign-in, so its messages are "admitted, run, stored and shown exactly as an app message" (`channels/console-chat.ts:9-11`, routed to the app paths at `:56-57`). Console rows are therefore stamped `surface: 'app'` [inference from the routing and `channels/owner-turn.ts:749,860`].
- **iMessage writes the same canonical store** under the same owner prefix, on its own chain [verified]:
  - The store keeps every chain of an owner under one prefix (`conversation/canonical-owner-store.ts:74-76,93`).
  - The iMessage turn's history is that store, with no thread (`channels/owner-do.ts:3594`).
  - Admission derives the same `prn_`/`ten_` refs on every surface (`identity/surface-owner-admission.ts:94,105`).
  - The iMessage chain key is the transport tuple `["imessage", bridge, account, chatGuid]` (`channels/imessage/ingress.ts:11`; `channels/imessage/owner-runtime.ts:37,60-61`).
  - `test/app-turn-skipped-history.test.ts:104-119` pins one store holding both chains.
- **WhatsApp writes the legacy `conv:*` store** on the chain `whatsapp-<chat>` [verified]:
  - Only the app and iMessage branches pass a `history` (`channels/owner-do.ts:3588,3594`).
  - Every other surface keeps the responder's default store (`channels/owner-turn.ts:167`), which is `durableConversationStore` (`channels/owner-do.ts:3305,3535`).
  - The chain is `surfaceChatRef(surface, chat)` (`channels/telegram-turn.ts:14`).
  - WhatsApp has no canonical admission: the composed-context host exists only for Telegram (`channels/owner-do.ts:3501`).
- **Telegram (internal)** gets canonical admission (`channels/owner-do.ts:3501-3519`) but the same legacy store as WhatsApp [verified].

**What the app shows.**
- `GET /app/v1/chat/main` reads every row under the owner prefix with no chat filter:
  - `appChatPage` calls `readForDisplay()` (`channels/owner-do.ts:1343-1355`), which lists every `conv:` row (`conversation/canonical-owner-store.ts:168,210`).
  - `appTranscriptPage` filters on role only (`channels/app-api.ts:209`).
  - Each row's `channel` is `entry.surface` (`channels/app-api.ts:225`), declared `channel: z.string()` (`contracts/app/core.ts:75`).
- **Probe [verified, uncommitted, at `296aee94`].** A copy of the `app-turn-skipped-history` fixture held two app rows and two iMessage rows on their own chain. `GET /app/v1/chat/main` returned all four, newest first, with `channel` `imessage` on the iMessage rows and `app` on the app rows.
  - A following app turn's model request contained the app rows and none of the iMessage text.
  - A control mutation of the last assertion failed, so the assertions ran.
  - The probe file was deleted afterwards.
- So for iMessage, "the app never shows it" is already untrue. **The real gaps** are:
  - the model's window;
  - WhatsApp (and internal Telegram) on the legacy store;
  - the console label.

**What the model reads per turn [verified].**
- The new owner row hangs on the leaf of the turn's own chain: `parentId: conversationLeaves.get(conversationRef)` (`channels/owner-turn.ts:749`).
- The store's turn read walks back from that chain's newest owner row, and from the stored leaf, until the window budget (`conversation/canonical-owner-store.ts:112-116,150,161-165`). Compaction is off (`conversation/compaction.ts:7-9`), so the budget is `CONVERSATION_INPUT_BUDGET_TOKENS` (`conversation/window.ts:27`).
- **Change after the pin.** `beta-mvp` `2c4672c9`, which merged #1458 after the pin, makes compaction a deploy switch (`WALDO_COMPACTION=on`). It keeps one live summary per chat under `compaction-live:<chat>`, and the turn read stops at the row that chat's summary covers [verified in the diff `296aee94..2c4672c9`, `conversation/compaction.ts` and `conversation/canonical-owner-store.ts`].
  - With one timeline, main has one live summary that covers every surface's rows.
  - Old surface chains keep theirs and are no longer read for turns.
- Per-turn recall from main can reach any indexed message that isn't on a thread, whichever surface it came from (`channels/app-threads.ts:38-43`). Cross-surface continuity today rests on recall and memory, not on the window.

**Facts the design relies on [verified].**
- **One turn at a time per owner.** App, iMessage and Telegram turns all run through the one `serial` queue (`channels/owner-do.ts:2567-2571`; callers at `:724,:1303,:1376,:1469,:1480`). Two surfaces can't append to one chain at once.
- **A fresh history load per turn.** A turn with a run scope builds its own responder (`channels/owner-turn.ts:834-842`), so a chain written by another surface's turn is re-read.
- **Ids can't collide across surfaces.** Turn ids carry the surface (`channels/owner-turn-envelope.ts:68`). The store treats a re-saved identical row as a no-op and a different row under the same id as a conflict (`conversation/canonical-owner-store.ts:217-221,238-241`).
- **Forget already reads both stores** (`channels/conversation-store.ts:97-114`).
- **Scheduled rows.** For an app owner they go to the main chain with `surface: 'app'` (`channels/owner-do.ts:990-991,3590`). For an iMessage-only owner, the job host writes the surface chain (`channels/owner-do.ts:3596`).
- **The 10 October omnipresence design** already chose one shared main (`docs/planning/OMNIPRESENCE_SEAM_DESIGN_2026-10-10.md:44`, slice 5 at `:67`), with a fresh start for legacy history (`:75`). Slice 5 was never built [verified: the store wiring above].

### 1.2 Design

#### 1.2.1 One store, one writer, one main chain [proposed]

- **Store and writer don't change.** The OwnerDO stays the only writer (`CLAUDE.md:13`), through `canonicalOwnerConversationStore`, under the prefix it has now. No new store, table or key family is added.
- **The main timeline is the chain `owner:<principal>`** (rename `ownerChainRef('app', p)` to `ownerMainChain(p)`). Every turn on a user surface reads and writes it: app, console, iMessage and WhatsApp.
- **Threads stay app and console only**, each on its own prefix (`conversation/canonical-owner-store.ts:89,93`; `channels/app-threads.ts:23,29`). Chat surfaces have no threads, so their turns always join main.
- **A scheduled or proactive message is one row on main**, whichever surface delivers it. The job host's chain becomes main for every user surface (the change at `channels/owner-do.ts:3596`). A copy on another surface is a delivery of that row, never a second row (`channels/proactive-surface.ts:75-81` already copies by app row id).

#### 1.2.2 Split the delivery binding from the history chain [proposed]

`conversationRef` does two jobs today. It names where a reply goes and who may speak, and it names the chain a row joins. The cutover moves only the second job. Each reader at the pin [verified locations]:

| Reader | Job | After the cutover |
|---|---|---|
| `channels/imessage/owner-runtime.ts:37` (handoff refuses a ref that isn't the binding tuple) | delivery binding | unchanged |
| `channels/imessage/owner-runtime.ts:60-61` (context ref must equal the record's) | history chain | compare against `ownerMainChain(principal)`; the record keeps the tuple |
| `channels/owner-do.ts:3458,3506` (Telegram turn ref equals `surfaceChatRef`) | delivery binding | unchanged |
| `channels/owner-do.ts:3492` (app skill host) | delivery binding | unchanged |
| `channels/owner-do.ts:3586` (app context ref equals the inbox record's) | history chain | unchanged: the app record already names main or a thread |
| `channels/owner-turn.ts:229-230` with `tools/live/memory.ts:61` and `channels/owner-do.ts:3546` (`remember` binds to the turn's own chat) | provenance binding | unchanged: both sides keep the envelope's transport ref |
| `channels/owner-turn.ts:738,749` (`converse` takes the context's ref) | history chain | main, from the context host |
| `channels/owner-do.ts:3590,3596` (job host chain) | history chain | main for every user surface |
| `channels/app-threads.ts:38-43` (`recallReach`) | thread scope | unchanged |
| `channels/owner-do.ts:1277-1290` (app receipt and Stop on `mainRef`) | app inbox | unchanged |
| compaction attempt key (`conversation/canonical-owner-store.ts:300-305`), and the live summary key `compaction-live:<chat>` (at `2c4672c9`) | history chain | keyed by main; one key instead of one per surface chain |

**Rule:** the turn envelope's `conversationRef` stays the transport ref. Only `OwnerContextCapability.conversationRef`, set by the context host, becomes main.

#### 1.2.3 Surface adapters [proposed]

- **iMessage.** `iMessageOwnerContext` passes `conversationRef: ownerMainChain(principal)`. The inbox record and outbox keep the binding tuple for delivery. This part ships only under §1.2.6.
- **WhatsApp** gains what the app and iMessage already have:
  - a context host using `surfaceOwnerAdmission`, with `surface: 'whatsapp'` and the same directory resolve shape as `channels/owner-do.ts:3509`;
  - `history` set to the canonical store on main.

  WhatsApp is waiting on Meta business verification, so this lands dormant behind the switch.
- **Console label.**
  - The Worker's console chat forward adds a header naming the entry point (`x-waldo-entry: console`). The app path builds its forwarded headers from scratch (`channels/app-api.ts:189-192`), so an app client can't set it [verified for the app path]. PR D adds a test for the console path.
  - The app inbox record keeps `entry`, and `converse` stamps the stored row's `surface` with `console`.
  - The turn envelope's `surface` stays `app`, because authority fences compare it (`channels/owner-do.ts:3491`).
  - Only the shape check and the display projection read a stored row's `surface` [verified: `conversation/canonical-owner-store.ts:34`, `channels/app-api.ts:225`], so the label is display-only.
- **Telegram (internal).** It takes the same code path as WhatsApp if the team wants it in the internal accounts' timeline. There is no user-facing behaviour and no Telegram-only branch.

#### 1.2.4 What the model reads per turn [proposed]

- **The window walks main.** It uses the same store read and the same budget (§1.1), so cross-surface history arrives as ordinary rows. Each row exists once, so nothing is duplicated: no merged view, no summary of another chain and no second copy.
- **Each row says where it was written.** An owner row from a surface other than the app carries a short host-framed note in the model view only, for example `(sent on iMessage)`.
  - The note depends only on the stored row, so the prompt prefix stays byte-stable from turn to turn.
  - Stored payloads don't change.
  - Whether the note helps is an eval question (§1.5, test 6). If it doesn't measurably help, it ships off.
- **The current turn's surface** still comes from the presentation block (§4), not from the row notes.

#### 1.2.5 Replay and idempotency [verified mechanisms; proposed tests]

- **Each surface keeps its own inbox dedupe:**
  - app: `client_message_id` (`channels/owner-do.ts:1478`);
  - iMessage: `dedupKey` (`channels/imessage/owner-runtime.ts:43-46`);
  - Telegram: the inbox sequence (`channels/owner-do.ts:580-593`).
- **Rows.** A row's id is the surface-prefixed turn id, and the store refuses a different row under an existing id. The serial queue rules out concurrent appends.
- **Which chain a turn joins** is decided when the turn **runs**, not when it was admitted. A record admitted before the switch and run after it joins main. A record re-run after a crash lands the same ids and is a no-op.

#### 1.2.6 Health boundary: what blocks the iMessage cutover [inference; proposed sequencing]

- **The hold.** iMessage turns get no health source today: `iMessageOwnerContext` narrows its sources to `ownerProfile` (`channels/imessage/owner-runtime.ts:52`), and the host passes only that (`channels/owner-do.ts:3593`). PR #1463 adds health and is held on the owner's answer to the Photon data-agreement question.
- **Why the cutover breaks it.** Once iMessage turns read main, the app's health conversation sits in the iMessage window. A reply could then carry it out through Photon, which would bypass that hold.
- **Default: sequence it.** The iMessage switch stays off until #1463's question is answered yes.
- **Fallback if the answer is no.** At write time the host marks a row whose turn carried health material: `healthBearing: true`, a host fact taken from whether the composer admitted a health fragment, not a judgment about the text. iMessage windows then omit marked rows. This adds an optional `ConversationEntry` field (`contracts/runtime/conversation-entry.ts:17-42`), so it needs its own review.
- **WhatsApp** already receives the responder's positional health source (`channels/owner-do.ts:3578`) [verified]. Whether Meta's data path has the same agreement question is for the owner [inference]. It doesn't block a dormant switch.

### 1.3 Contracts and storage touched

| Surface | Change | Kind |
|---|---|---|
| DO kv canonical rows | none: same prefix, same shapes; new rows land on main | none |
| `ConversationEntry` (`contracts/runtime/conversation-entry.ts`) | none, unless the §1.2.6 fallback adds an optional `healthBearing` | additive, optional |
| `appMessageV1Schema.channel` (`contracts/app/core.ts:75`) | new values `console` and `whatsapp` in an open `z.string()` | type-additive; **tell waldo-app #138 first**, because the app may branch on the value [inference] |
| App inbox record (DO kv) | `entry?: 'console'` | additive |
| Worker console forward | one trusted header | internal |
| Env | `WALDO_ONE_TIMELINE`: comma list of surfaces cut over (`imessage`, `whatsapp`, `telegram`); empty by default; documented in `.env.example` and the deploy docs | new var |

**ADR position.**
- **No blocking ADR for the bodies.** At the pin, `CLAUDE.md:18` says conversation bodies are documented in the owning contract, not as a blocking ADR. This design adds no store, so the conversation-body rule needs nothing more.
- **ADR-0077 does conflict with the code.** ADR-0077 (accepted) puts the conversation graph in Supabase and rejects "DO owns the entire chat/session tree" (waldo-brain `main` `88d013c7`, ADR-0077 §"Considered Options" A and B, §"Decision" 1). The code already keeps the chat in the OwnerDO, and the 21 October build direction makes the OwnerDO "the only writer of memory, chats and approvals" (`docs/planning/BUILD_DIRECTION_2026-10-21.md:14`). Accepted ADRs still bind their seam until amended (`CLAUDE.md:5`), so one timeline should land with an ADR-0077 amendment.
- **ADR-0035 already agrees.** It says a different channel "doesn't mean different conversation thread" (ADR-0035 §"Memory remains unified").

**Draft decision text for an ADR-0077 amendment** [proposed; owner and gate to file it in waldo-brain]:

> **Amendment (25 October 2026): the conversation graph lives in the owner's Durable Object.** The per-owner `OwnerDO` is the system of record and the only writer of the owner's conversation: one main timeline that every user surface (app, console, iMessage, WhatsApp) reads and writes, plus app and console threads, each a chain in the canonical owner store. Each row records the surface it came from; the app and console show the whole main timeline, labelled by surface. A surface's delivery binding (where a reply goes, who may speak) is separate from the chain a row joins. Option B's rejection is withdrawn for the live store: multi-device reads go through the authenticated app and console routes of that object, not Supabase RLS. Supabase keeps health data and identity; it holds no conversation rows. The R2 replay journal (layer 3) and Supabase conversation tables (layer 1) are not built and are not planned; export and deletion walk the canonical store, as forget already does. Legacy per-surface history is not imported; it stays reachable through episode recall. Health values follow ADR-0081 as amended; a surface whose provider path lacks an approved data agreement does not receive health-bearing rows in its window.

### 1.4 Migration and rollback [proposed]

- **Forward only.** Each surface in `WALDO_ONE_TIMELINE` starts writing main from its next turn. No stored row is rewritten. Changing an old row's `chatId` would break its witness match, which is fatal by design (`conversation/canonical-owner-store.ts:146-147`).
- **The first row on main after the cutover** hangs on main's newest row (§1.5, test 2).
- **Old iMessage chains** stay in the store, so the app keeps showing them. **Legacy WhatsApp and Telegram `conv:*` rows** are not imported, because the canonical store doesn't reclassify legacy rows as admitted owner input (`conversation/canonical-owner-store.ts:27-28`). They stay reachable through episode recall.
- **Rollback:** remove the surface from the list. Its turns go back to their own chain. Rows written to main meanwhile stay valid main rows: the app shows them, and recall reaches them. Nothing is deleted.

### 1.5 Tests (red first)

1. **Falsifier, cross-surface window.** With iMessage cut over, an app turn's model request contains the text of the latest iMessage exchange, and the reverse holds too. Today it fails: the probe in §1.1 shows the app request without the iMessage text.
2. **Hang-on.** The first iMessage row after the cutover has `parentId` = main's newest non-compaction row, and `chatId` = main. The old iMessage rows are byte-identical before and after.
3. **Binding kept.** After the cutover, an iMessage reply is frozen to the binding tuple's chat and nowhere else. A handoff whose envelope names main instead of the tuple is refused.
4. **Console label.** A console send stores a row with `surface: 'console'`, and the page shows `channel: 'console'`. An app request carrying `x-waldo-entry: console` is stored as `app`. Authority fences still see `turn.surface === 'app'`.
5. **Replay.** The same iMessage occurrence handed off twice adds one row. A record admitted before the switch and run after it lands on main once. A crash re-run is a no-op.
6. **Eval: row notes.** With the notes on and off, an owner asks on the app about something said only on iMessage ("what did I say about the dentist on my phone?"). The run counts as a pass when the note version answers correctly more often on the held-out set and no transcript claims a surface wrongly.
7. **Health boundary.** With the iMessage switch on and #1463 not merged, a configuration check refuses to start, or, under the fallback, a health-marked app row is absent from the iMessage window.
8. **Adversarial.**
   - An iMessage message from another handle is refused at the bridge, as today (`channels/imessage/ingress.ts:8-10`).
   - A thread turn never reads main.
   - A forget after the cutover clears the topic from main and from old chains.
   - With the switch empty, every existing timeline test passes unchanged.

## 2. One approval rule

### 2.1 Today [verified]

- **Seven proposal kinds** (`channels/approvals.ts:167-172`): `calendar_change`, `google_task_change`, `email_send`, `message_send`, `browser_submit`, `mcp_call`, `tainted_action`.
- **Console.**
  - The console checks for an email code from the last two hours (`CONSOLE_STEP_UP_MS`, `identity/console-auth.ts:15`).
  - It applies the check only to gated actions (`channels/console-step-up.ts:106-119`). `approval.send` is gated (`:36`); `approval.approve` is not (`:33`).
  - It decides only send kinds, and calendar changes without invite details (`channels/approvals.ts:479`).
- **App.** No step-up on any app route. Issue #1541 (HIGH) records it and proposes the session's `created_at` as the app's proof.
- **Chat surfaces.**
  - They approve with buttons whenever the full review fits (`channels/approvals.ts:450-455`, `REVIEW_BUDGET` at `:192`). An email send is approvable on Telegram today.
  - A card that doesn't fit carries an app link and no approve (`:452`, `:494-499`).
- **iMessage** uses the app's desk, so it never shows a card (`channels/owner-do.ts:3258-3259`). `ApprovalSurface` doesn't include `imessage` (`channels/approvals.ts:115`).
- **What `decide` already enforces.**
  - Approving needs a full-review presentation on the deciding surface (`channels/approvals.ts:476-483`).
  - A send goes out only if a presentation carries the stored payload's digest (`:486-489`, used at `:611`).
- **`message_send` reaches only the owner.** The executor sends to the owner's own chat on the named channel: `chat_id: target.owner` (`channels/owner-do.ts:3277-3285`). The console still gates it as a send to others (`channels/console-step-up.ts:36`).
- **The model can't decide an approval.** Its only approval tool lists and re-raises (`tools/live/raise-approval.ts:19-33`).

### 2.2 Design: one predicate, enforced in `decide` [proposed]

**Where the rule lives.** A route-level gate per surface can't cover old cards, Telegram buttons or a future surface. Every surface already decides through the desk, so the rule lives there once:

```ts
// channels/approvals.ts
type Audience = 'owner_only' | 'others';
export const audienceOf = (kind: string, payload: unknown): Audience => /* table below; an unknown kind is 'others' */;
export type ApprovalVia = Readonly<{ surface: ApprovalSurface; messageRef?: string; proofAt?: number }>;
// In decide, before any effect, for action 'a' only. An edit sends nothing; the draft it produces is a new card whose
// approve is gated in turn, which keeps the console's ungated approval.edit (channels/console-step-up.ts:37).
// audienceOf(...) === 'others' && !(via.proofAt !== undefined && now - via.proofAt < CONSOLE_STEP_UP_MS) → refuse
```

**What each route passes.**
- **Console:** `proofAt = session.verified_at` (`channels/console.ts:39-40`).
- **App:** `proofAt` = the app session row's `created_at`, the proof #1541 proposes.
- **Chat surfaces** (iMessage, WhatsApp, and the internal Telegram) pass no proof, so a send to others **fails closed** there. The refusal reuses the app-link wording at `channels/approvals.ts:494-499`.

**On chat surfaces, `present()` records `approvable = 0` for `others` kinds.** The card shows the review (or a summary when it doesn't fit), the app link, and skip/defer.
- The decide-time check also covers a card presented before this change with `approvable = 1`. No stored row needs rewriting.

**Who each kind reaches.** This is a hard egress/authority boundary, so a fixed table is allowed (`CLAUDE.md:11`).

| Kind | Audience | Basis |
|---|---|---|
| `email_send` | others | recipients by construction [verified `channels/approvals.ts:119`] |
| `calendar_change` | others when `calendarInviteDetails(payload)` holds (guests, `send_updates`, another calendar, location, description, Meet; `channels/approvals.ts:128-129`); otherwise owner_only | the holds on the owner's own calendar the ruling names |
| `google_task_change` | owner_only | the owner's own task lists |
| `message_send` | others **until Q1 is answered**, matching the console gate today (`channels/console-step-up.ts:36`) | as built it reaches only the owner's own chat (`channels/owner-do.ts:3281`), which is why **Q1** asks |
| `browser_submit` | others | a form sent to a third-party site; **Q2** |
| `mcp_call` | others | a third-party tool server's effect is unknown to Waldo; **Q2** |
| `tainted_action` | others unless the replayed tool is in an owner-only list (`remember`, `forget_memory`, `close_loop`, `set_reminder`); unknown tools are others | **Q2** |

**Gap: guests on an existing event.** A move or cancel of an event that already has guests doesn't show them in the payload today: the review carries `seen_start`/`seen_end` only (`channels/approvals.ts:406`). The proposing tool should record `guests_seen: boolean` from the event it read, and `audienceOf` should treat `true` as others [proposed]. Until then, a move or cancel counts as owner_only, which is today's behaviour [inference].

**Error contract (app).**
- A stale proof returns `step_up_required`. That is a new **enum value** in `appErrorCodeV1Schema` (`contracts/app/core.ts:87`), which breaks a strict reader.
- It is returned only to a build that declares the new contract revision in `x-waldo-app-contract` (`contracts/app/core.ts:8-12,23-26`). Older builds get the generic error.
- The app lane (#138) is told before merge. The app then shows a "confirm it's you" re-sign-in (email code, or Google or Apple) and retries with the same `request_id` (`contracts/app/approvals.ts:98-101`).

**How this fits #1541.** #1541 gates `account.delete`, `google.connect` and the link codes at the route. Its "approve on a send card" item should be built as this predicate, so there is one rule. Its structural test, "every app action and approval kind maps to a step-up entry", becomes: `audienceOf` covers every key of `CARDS`.

### 2.3 Contracts and storage touched

- **Runtime types:** `ApprovalVia.proofAt` and `ApprovalSurface` plus `imessage`.
- **App contract:** `step_up_required` behind a contract revision.
- **Unchanged:**
  - `approval_presentations` and the ledger;
  - `contracts/app/approvals.ts`: the states and `presented_surfaces` are unchanged, and `imessage` is already allowed (`:70-71`).

### 2.4 Migration and rollback

- **Migration:** none. The check runs at decision time.
- **Effect at deploy:** an open chat-surface send card stops approving and answers with the app link.
- **Rollback:** revert the predicate. No data is touched.

### 2.5 Tests (red first)

1. **Falsifier, app.** An approve on an `email_send` with a 3 h-old app session is refused with nothing sent, and passes with a fresh session. Today it passes, per the #1541 probe shape.
2. **Old card.** A Telegram or WhatsApp `email_send` card presented with `approvable = 1` before the change, then tapped Send: refused, the app link is returned, nothing is sent and the row is still open.
3. **Owner-only stays one tap:**
   - a primary-calendar hold with no guests approves from a chat button with no proof;
   - the same hold with one guest is refused there and approves in the app with a fresh proof.
4. **Coverage.** Every `CARDS` key has an `audienceOf` row. An unknown kind is `others`.
5. **Contract.** A build declaring the old approvals revision never receives `step_up_required`. zod valid and invalid pairs for the new code.
6. **Adversarial:**
   - a proof from another owner's session can't satisfy the check, because the proof is read inside the owner object from the admitted session;
   - a skip and a defer never need a proof;
   - an `edit` on an `others` card needs no proof on any surface, and the new draft's card is review-only on chat surfaces;
   - a console `approval.edit` with a session older than two hours still works.

### 2.6 Owner questions

- **Q1.** `message_send` reaches only the owner today, so the literal rule makes it one tap. The console gates it now. Ungating it relaxes a security setting, so it needs the owner's yes. The default keeps it gated (treated as `others`).
- **Q2.** `browser_submit`, `mcp_call` and `tainted_action` aren't named by the ruling. The default is `others` (fail closed). The alternative is a per-tool owner-only list that the owner approves once.
- **Q3.** Telegram is internal, but the owner uses it personally. Under this design every chat surface fails closed for sends, so Telegram's Send buttons stop sending and hand over the app link instead, like iMessage and WhatsApp. The alternative is an exemption for internal accounts, which would be a Telegram-only branch (`CLAUDE.md:16`). The default is no exemption.

## 3. iMessage approves by numbered reply

### 3.1 Today [verified]

- **No card ever reaches iMessage.** The desk built for iMessage turns uses the app surface (`channels/owner-do.ts:3258-3259`). The iMessage runtime's `sendMessage` caller writes to the app (`channels/owner-do.ts:2862-2863`).
- **Replies go out only through the iMessage final outbox.** They freeze inside the turn's scope (`channels/owner-do.ts:3627-3637`).
- **Delivery results** come back through `recordIMessageResult` (`channels/owner-do.ts:734-740`). A `delivered` or `local_recorded` result carries the sent `messageGuid` (`contracts/channels/imessage-v1.ts:65-66`).
- **Ingress admits only a direct, non-group `message` from the bound handle** (`channels/imessage/ingress.ts:8-10`; the bridge at `channels/imessage/bridge-do.ts:192`). Reactions (tapbacks), edits and polls are other event kinds (`contracts/channels/imessage-v1.ts:31-35`), so they never become a turn.
- **The inbox record keeps only the text**, not the reply-to guid (`channels/imessage/owner-runtime.ts:44-47`; `channels/owner-do.ts:759`).
- **The tables disagree.** The capability table claims `approval: 'numbered'` (`contracts/runtime/surface-capabilities.ts:29`), while the presentation the model reads says `none` (`channels/telegram-turn.ts:16`).

### 3.2 Design [proposed]

**The card.** A card is presented on iMessage only when the turn or job came from iMessage (the desk's own surface), and otherwise in the app as today.
- **Owner-only card:** the full review, then one fixed line, for example `Reply 1 to add it, 2 to skip.` The verb comes from `CARDS[kind].approve`.
- **Card for others:** a summary, `It's waiting in your Waldo app: <link>`, and `Reply 2 to skip.`
- **A review that doesn't fit** the iMessage text cap (§4) shows the summary and the app link only, as `REVIEW_BUDGET` does today.

**Which message carries the card.** The turn's final reply goes out after anything proposed mid-turn, and it closes progress notes first (`channels/owner-do.ts:3632-3635`). A card sent as its own message mid-turn would therefore be followed by the reply, which disarms it (see the binding rule below). So:
- **Inside an iMessage turn,** `present()` sends nothing. It records the card as pending on the turn. `queueFinal` then appends the card block (the review and the `Reply 1 …` line) to the reply text, so the message that carries the numbers is the last one the turn sends. This is the iMessage analogue of `on_this_reply` (`tools/live/raise-approval.ts:15`).
  - When reply plus card exceeds the text cap, the card is frozen as a second record in the same commit, after the reply. The drain hands records to the bridge in freeze order. PR C pins that ordering with a test.
- **Outside a turn** (a job or proactive card), the card is its own outbox message.

**Presentation is asynchronous.**
- The frozen record that carries the card records a presentation with `surface: 'imessage'`, `message_ref: cmd:<commandId>`, `approvable: 0`, and the payload digest.
- On a `delivered` or `local_recorded` result with a `messageGuid`, `recordIMessageResult` sets `message_ref` to that guid, sets `approvable = 1` for an owner-only card, and **arms** it.
- A `rejected` or `unknown` result arms nothing, and the row follows the existing `card_unconfirmed` path.

**One armed card per iMessage chat.**
- **The binding.** The armed card is Waldo's **latest** outbound message in that chat. Any later outbound message disarms it: a reply, a progress note (#1436), a proactive message or another card.
- **What the number binds to:** `(approval_id, payload_digest, messageGuid, expires_at)`, where `expires_at` is the approval's expiry (`PROPOSAL_TTL_MS`, `channels/approvals.ts:39,206-207`).
- **A second card while one is armed** waits in the outbox and is presented after the first resolves. The tool result tells the model it is queued.

**The intercept.** In `drainIMessage`, before `this.turn` (`channels/owner-do.ts:759`), the host checks whether the record is an exact decision.
- **This is iMessage's button protocol, not a reading of meaning.** The numbered reply plays the role Telegram's `callback_data` plays (`channels/approvals.ts:1306-1312`): a surface-level control the host decodes exactly.
- The model never decides authorization. The security checklist forbids LLM output in authz decisions, and the model's only approval tool lists and re-raises (`tools/live/raise-approval.ts:19-33`). So the decision can't be handed to the model's reading of free text. Anything that isn't the exact control goes to the model as conversation.
- **It is an exact decision when all of these hold:**
  - the text, with only ASCII whitespace trimmed, is exactly `1` or `2`;
  - the event had no attachments;
  - an armed card exists for this chat;
  - the card hasn't expired.
- **On a match**, the host calls `decide(approval_id, '1' → 'a' | '2' → 's', …, { surface: 'imessage', messageRef: guid })`. `shownAsStored` checks the digest, and the audience predicate (§2) applies, so `1` on an others card is refused with the app link.
- **The outcome text is fixed:** the desk's own `message`, as the Telegram callback replies today (`channels/approvals.ts:1306-1329`). It goes out through the iMessage outbox.
- **Both rows are written** under the record's own admission: the owner's `1` (surface `imessage`) and the outcome, with its receipt. No model turn runs.
  - They go to the iMessage turn's **current history chain**: the iMessage chain until PR D's iMessage switch is on, main after.
  - The app shows them either way (§1.1).
- **Anything else is an ordinary model turn**, for example `yes`, `1 please`, `send it`, `11`, `1.`, a full-width `１`, or a `1` sent with a photo.
  - The armed card stays live. The host appends one fixed line to that turn's reply: `Still waiting: reply 1 to add it, 2 to skip.`
  - That message re-arms the same `(approval_id, digest)` when it is delivered, so the "latest outbound" rule holds.
  - The presentation block tells the model that approvals on this surface happen only by that reply (§4).
- **No armed card.** A `1` or `2` arriving with no armed card, after expiry or after a disarm, gets a fixed reply ("That card isn't waiting any more; nothing was done") and no decision.
- **Optional, additive: reply-to.** The inbox record may carry `replyToGuid`. When it is present and doesn't equal the armed guid, the reply is not a decision.

### 3.3 Contracts and storage touched

- **Runtime:**
  - `ApprovalSurface` plus `imessage`;
  - an iMessage outbox record kind `card`;
  - an armed-card key per chat in DO kv;
  - `SurfacePresentation.approval` gains `numbered` (`prompt/messaging-behavior.ts:117-120`);
  - an optional `replyToGuid` on the inbox record.
- **The Photon wire is unchanged:** the send is text only (`contracts/channels/imessage-v1.ts:49`).
- **App contract: no change.** `presented_surfaces` already allows `imessage` (`contracts/app/approvals.ts:70-71`).

### 3.4 Migration and rollback

- **Switch:** `WALDO_IMESSAGE_NUMBERED`, off by default. Off is today's behaviour: the app desk, and no card on iMessage.
- **Rollback:** switch it off. Armed keys are ignored, and frozen card records settle like any outbox record.

### 3.5 Tests (red first, then adversarial)

1. **Falsifier.** A primary-calendar hold proposed mid-turn in an iMessage turn: the card rides on the turn's final reply, that reply's delivered result arms it, a later `1` creates exactly one event, and the timeline shows `1` and the outcome. Today no card is frozen.
   - Variant: reply plus card exceeds the cap. The card is frozen after the reply, reaches the bridge after it, and `1` still decides.
2. **Tapback.** A `like` reaction on the card is never admitted (bridge and ingress). The card is still open.
3. **Edit.** An edit event turning `2` into `1` is never admitted.
4. **Ambiguous replies** (`yes`, `1 please`, `11`, `1.`, `１`, `1` with an attachment, `1` from another handle, `1` in a group): each one either goes to the model or is refused at ingress, and none decides.
5. **Later message.** A progress note delivered after the card means `1` doesn't bind. The re-arm line after a model turn makes `1` bind again to the same digest.
6. **Changed digest.** After an app Modify produces a new draft, `1` on the old card is refused with the changed-draft message and nothing is sent.
7. **Already decided.** `1` after the app decided returns `Already handled.`. A replayed handoff of the same `1` makes one decision.
8. **Not yet delivered.** `1` before the card's delivery result doesn't decide.
9. **Others card.** `1` on an `email_send` card returns the app link and sends nothing. `2` skips it.
10. **Expiry.** `1` after `expires_at` gets the fixed "isn't waiting" reply.
11. **Two cards.** The second waits until the first resolves.
12. **Model.** No model tool can decide an approval (a pinned test on `tools/live/raise-approval.ts`).

## 4. One honest capability list

### 4.1 Today [verified]

- **Three tables disagree:**
  - `SURFACE_CAPABILITIES_V1` (`contracts/runtime/surface-capabilities.ts:25-31`) is read only by its own test (`contracts/runtime/surface-capabilities.test.ts`).
  - The model reads a literal built in `channels/telegram-turn.ts:16` and rendered at `prompt/messaging-behavior.ts:132-144`.
  - `channels/surfaces/whatsapp.ts:92` declares a third version and is imported by nothing.
  - `nativeSurface` (`channels/owner-do.ts:323`) is a fourth fact.
- **Overclaims in the contract table:**
  - **App `files`/`voice`.** The app send is text only (`contracts/app/core.ts:55-57`).
  - **iMessage `files`/`voice`.** The bridge holds inbound media as `media_unsupported` (`channels/imessage/bridge-do.ts:399,409`), sends `attachments: []` (`:549`), and the media loader refuses audio and native voice (`channels/imessage/media.ts:79`).
  - **iMessage `approval: 'numbered'`.** See §3.1.
- **Disagreements in the prompt literal:**
  - WhatsApp approval is `text_callback` in one place (`channels/telegram-turn.ts:16`) and `native_buttons` in the other (`channels/surfaces/whatsapp.ts:92`).
  - The console approves only some kinds (`channels/approvals.ts:479`), which neither table says.
- **Live facts exist.** The iMessage bridge reports probe-verified per-feature flags (`iMessageCapabilitiesSchema`, `contracts/channels/imessage-v1.ts:71-78`).

### 4.2 Design [proposed]

- **One table in contracts:** `SURFACE_CAPABILITIES_V2`, split by direction:
  - `text {in, out, max_chars}`;
  - `files {in, out}`;
  - `voice {in, out}`;
  - `approval {owner_only, others}`, each one of `native | buttons | numbered | app_link | none`, so rule 2 is part of the data;
  - `quick_replies`, `charts`, `threads`.
- **`V1` stays exported** for compatibility and is derived from V2. Its values are corrected, not reshaped.
- **One runtime resolver:** `channels/surface-capabilities.ts`, `surfaceCapabilities(surface, live)`. It intersects the table with live facts:
  - voice-in only when a transcriber is configured (`selectTranscriber`);
  - iMessage features only where the bridge's flag is `verified` with `send`/`receive`;
  - WhatsApp writes only inside the open window.
- **The only readers are the resolver's callers:**
  - the turn presentation (replacing the literal at `channels/telegram-turn.ts:16` and the dead one at `channels/surfaces/whatsapp.ts:92`);
  - the prompt block (`prompt/messaging-behavior.ts:132-144`), which also lists the owner's linked surfaces and what each one can do, so the model can say "send the PDF in the app";
  - the desk's per-surface approval mode (§2, §3);
  - artifact and file delivery (a link when `files.out` is false);
  - attach-tool gating.
- **Conformance:** the presentation equals a projection of the resolver's output, and a guard refuses a `presentation: {` literal outside the resolver.

**The table at the pin, corrected** [verified cells cite above; others are inference]:

| Surface | text out cap | files in/out | voice in/out | approval owner_only / others | quick replies | threads |
|---|---|---|---|---|---|---|
| app | `REPLY_TEXT_MAX_CHARS` | no / no (send is text only) | no / no | native / native + step-up | chips | yes |
| console | `REPLY_TEXT_MAX_CHARS` | no / no in chat | no / no | calendar changes without invite details only; other owner-only kinds go to the app (`approvals.ts:479`) / sends, native + step-up | none | yes |
| iMessage | 4096 | no / no (held) | no / no | numbered (after PR C; `none` until then) / app_link | numbered | no |
| WhatsApp | 4096 | images and documents in, host-resolved [inference] / [unverified] | in when transcribed [inference] / no | buttons / app_link | buttons | no |
| Telegram (internal) | 4096 | yes / yes | in with a transcriber / no | buttons / app_link | buttons | no |

The WhatsApp and Telegram cells marked inference or unverified are confirmed in PR A against the live senders before the table merges.

### 4.3 Contracts, migration and rollback

- **Contract change:** a new export, `SURFACE_CAPABILITIES_V2`. V1 values change, but V1 has no runtime reader [verified]. Whether waldo-app pins this file is [unverified]; PR A asks #138.
- **Rollback:** revert. The prompt literal returns.

### 4.4 Tests

1. **Falsifier.** On an iMessage turn the prompt says attachment sending is unavailable and approvals are by numbered reply, and it never says `native_buttons`. Today the literal says approval `none`, and the contract claims files.
2. **Conformance.** For each surface, `presentation === project(surfaceCapabilities(surface, live))`. The guard finds no `presentation: {` literal elsewhere.
3. **Honesty eval.** Asked on iMessage to "send me the file here", Waldo answers with an app link and doesn't claim a send.
4. **Live intersection.** An iMessage bridge whose `files` flag is unverified yields `files.out = false`.

## 5. Row 2 is closed: what doesn't change

- **The app stays the default** proactive surface (`channels/proactive-surface.ts:26-29`). `PROACTIVE_SURFACES` doesn't change (`:10`), and neither does the app enum (`contracts/app/onboarding.ts:74`).
- **No Telegram choice and no "last surface you wrote from" default** are designed.
- **The Telegram override** (`channels/owner-do.ts:2309,2338`) affects only internal Telegram-linked accounts. It stays as it is.
- **Interaction with item 1:** a proactive message is one main-timeline row, whichever surface delivers it (§1.2.1).

## 6. PR split and owners

Two files are shared, so each has one writer at a time: `channels/approvals.ts` (B, then C) and `channels/owner-do.ts` (A touches it lightly; B, C and D touch it more). The gate fixes the order. The order proposed here is **A → B → C → D**, with E following B's contract notice.

| PR | Scope | Owner | Depends on |
|---|---|---|---|
| A | The capability table V2, the resolver, the presentation and prompt from the resolver, the conformance guard (§4) | Ark, #1449 | none |
| B | The audience predicate and the proof in `decide`; console and app routes pass `proofAt`; `step_up_required` behind a revision (§2). Builds the approval part of #1541. | Ansh, #1479 | #1541 scope |
| C | iMessage numbered replies: card outbox kind, arming on result, intercept, timeline rows, switch (§3) | Ansh, #1479 | A (`numbered` mode), B (predicate) |
| D | Timeline cutover: split refs, main for the iMessage and WhatsApp context hosts and the job host, console entry label, `WALDO_ONE_TIMELINE` (§1) | Ark, #1449 | iMessage part after #1463's question (§1.2.6) |
| E | App: render `channel` labels (`app`, `console`, `imessage`, `whatsapp`), "confirm it's you" retry on `step_up_required`, `imessage` in presented surfaces | app lane, waldo-app #138 | B's contract notice |
| Brain | ADR-0077 amendment (§1.3 text) and an `accepted-adrs.json` repin | owner and gate | lands with D |

Each PR runs `git diff --check` and `npx -y pnpm@10.34.4 verify` at its head, records pgTAP as UNAVAILABLE on macOS, and gets a gate review at the exact SHA. None of them deploys, migrates or sets a secret.

## 7. Evidence for this note

- **Observed:**
  - source read at `296aee94` (every [verified] citation above);
  - ADR-0035 and ADR-0077 read from waldo-brain `main` `88d013c7`;
  - issue #1541 read;
  - the uncommitted probe in §1.1, with its control.
- **Not checked:**
  - how the app renders `channel` today;
  - whether waldo-app imports `contracts/runtime/surface-capabilities.ts`;
  - WhatsApp's live outbound file and voice behaviour;
  - Google Calendar's default `sendUpdates` when the desk omits it;
  - #1463's data-agreement answer.
