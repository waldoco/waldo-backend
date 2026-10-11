# App chat plan, 11 October 2026

**Owner direction (11 Oct, about 14:30Z):**
- Stop work that serves only other surfaces.
- Make the app chat the core: the main agent chat plus sessions, at the level of Claude, ChatGPT and Codex, and delivering what Instinct, Meta Muse and our website promise.
- WhatsApp, iMessage and Telegram become extensions of the app chat, not replacements.
- Standing ruling (10 Oct): every promise on heywaldo.in ships, including the "Coming next" and "Planned" panels. The website is therefore the acceptance bar for the chat, alongside Claude and ChatGPT parity.

**Pins:**
- backend `beta-mvp` `497bdcb6`: #1060 (sign out everywhere also revokes app and email sign-ins) merged at 15:32Z on 11 Oct. Source rows below were read at `e5fd7200`; #1060 touches none of them;
- staging `81c4f892`, so #1060 is merged but not deployed;
- waldo-app `main` `9937d456`, after #62–#66 merged at about 15:00Z on 11 Oct. At that commit `tsc --noEmit` exits 0, and jest passes 547 tests in 82 suites (1 suite and 1 test skipped). Nothing has run on a device;
- waldo-app PR #67 at `ce590e4b` (the C0 review fixes): `tsc --noEmit` exits 0, and jest passes 551 tests in 82 suites (1 suite and 1 test skipped). It awaits the owner's merge yes in L4's session;
- website `Pin4sf/waldo-landing` `main` `830bfc2` (9 Oct), the pin the promise ledger also uses. I have not checked that heywaldo.in serves this commit.

Tags:
- `[verified]`: read at those pins.
- `[reference]`: how other products behave. For Instinct and Muse it comes from vendor pages (`COMPETITOR_RESEARCH.md` on PR #1058, fetched 11 Oct). For Claude, ChatGPT and Codex it is common knowledge, not re-checked today.

## Where the chat is today [verified]

**Main chat works end to end, as a plain transport:**
- **Sending:**
  - The app posts text only, at most 4,000 characters (`contracts/src/app/core.ts:34`).
  - It polls the receipt every 2 s (`mainChatController.ts`).
  - When the turn closes, it reads the history page.
  - Only one message can be open at a time.
- **Turn states:** each turn shows an honest open state, "Waldo has your message" and then "Waldo is working" (`ChatPane.tsx:494`). Retry reuses the same message id.
- **Already built:** loading earlier messages, jump to latest, channel labels, haptics and VoiceOver announcements.
- **Rendering: text as markdown, plus approval cards.**
  - `transcriptAdapter.ts` draws `text` parts through an in-app markdown parser (`markdown.ts`, #63) and `approval` parts as cards (#64).
  - The contract also defines `quick_replies`, `chart_series`, `file`, `voice`, `artifact` and `operation` parts (`core.ts:41-45`, `parts.ts`); the app does not draw those.
  - The backend builds approval parts (`approvals.ts:177`). I found nothing in the runtime that emits the other part types.
- **No dependency changed with #62–#66** (`package.json`). Markdown uses the hand-written parser, and copying goes through the iOS share sheet. There is still no clipboard, image or document picker, speech or streaming library.

**Sessions do not reach Waldo:**
- `threads.store.ts` keeps them in memory only, so they are lost on restart.
- The screen says so: "Individual sessions are local drafts only" (`useChat.ts`).
- The backend has only `/app/v1/chat/main`.
- ADR-0077 (thread graph) and ADR-0039 (threading tools) are accepted, and their schemas exist (`contracts/src/tools/schemas/threading.ts`), but nothing in the runtime imports them. The console has no threads either.

**"Ask Waldo" reaches the main chat from two places (#65):**
- The two places are an approval in the Approvals list and the Home health scores.
- Each puts a first line in the main chat composer. The owner reads it, then sends or clears it.
- I found no callers on main for the older paths: `startContextualChat` in `threads.store.ts` (a local session that cannot send), `CalendarIntelligenceCard` and `AskWaldoCTA`. They are cleanup candidates.
- The local session's context summary is still a stub: "No health or calendar context is attached" (`ChatPane.tsx:581`).

**The composer:** Attach and Mic are disabled buttons. The thread list offers only a long-press to archive or delete, on the device.

**Waldo barely speaks first in the app:**
- **Reminders reach the app transcript** (#1034, `telegram-owner-do.ts:1300-1312`). That is not proven live.
- **Nothing else is armed.** An app-channel runtime arms none of the nightly run, day cards, briefs or heartbeat (owner DO:1992).
- **No push:** P3a and S7 push are unbuilt, and `expo-notifications` is installed but never imported. The owner sees a proactive message only after opening the app.

## Gap map, ranked

Ranking: what blocks the experience first, then the biggest visible lift for the cost.

| # | Capability | Reference | Waldo today | Work | Lane | Gate |
|---|---|---|---|---|---|---|
| 1 | Waldo speaks first: brief, nightly run, heartbeat and reminders, with push | Muse comes back "when something changes or when it needs approval"; Vellum pushes on iOS | Reminders reach the app transcript but are unproven live. Nothing else is armed on the app channel. No push. | P3a (arming, the zone flag), S7 APNs, app push registration, tap a notification to open the chat | L2, L4 | **Blocks** |
| 2 | Sessions that reach Waldo | Muse: "one main chat plus side chats"; Claude and ChatGPT: a list of conversations | Local drafts only | Threads contract (an ADR-0077 subset); a transcript per session in the DO; routes to list, create, rename, archive, delete, send, read history and get a receipt; the app switches from the local store to the server | contracts, L2, L4 | **Blocks**; storing conversation bodies needs contract review |
| 3 | Proven on a physical iPhone | n/a | Nothing proven on a device | The live checks and a device run of the loop below | L4, owner go | **Blocks** |
| 4 | Cards inside the chat: approvals (Do it / Not now / Modify), quick replies, charts, files, artifacts | Muse: structured accept or reject cards; Vellum: inline approval buttons; Claude: artifacts | Approval cards are drawn in the chat (#64; merged, not proven on a device). The other parts are not drawn. | Approval cards: each card's buttons look up the same `approval_id` on the approvals page and decide through the route the approvals screen already uses. A changed digest shows the card as changed, with no buttons. Never act on the history part, which is read tolerantly and for display only (`app-routes-v1.ts`). Next: operation steps, files and artifacts. Backend producers for quick replies and health charts: none exists today. | L4, then L2 and L1 | Additive only; charts carry a health gate (row notes) |
| 5 | Live progress and sources ("Checking your calendar", then "Checked 3 things" with where each fact came from) | Claude's tool rows; Dots' Activity View; Muse's avatar work snippet; the website's hi-fi chat | Receipt phase only | Emit real trace hops as `operation` steps on the receipt, and draw them. When the turn closes, collapse them into one line that names the sources read. Nothing decorative. | L2, contracts, L4 | Real-data rule |
| 6 | Streaming replies and a Stop button | Claude, ChatGPT | No stream route. The receipt contract reserves `cancelled`, `archived`, `deleted` and `thread_changed`, but the runtime emits only `interrupted` and `session_revoked` (`app-inbox.ts:23`). | A cancel route first. Then streaming, after a short ADR: the transport (streaming fetch vs a DO WebSocket) and which checks run before text leaves the DO. | L2, L4 | ADR note |
| 7 | Readable replies: markdown, links, lists, code; copy and share; a long-press menu | Every chat app | Markdown, links behind a confirm, a long-press menu and a visible "Share or copy" row (#63, #66; merged, not proven on a device). Text inside a reply cannot be selected on main; #67 makes it selectable again. | Merge #67 (C0) | L4 | None |
| 8 | "Ask Waldo" from any card | Muse, Claude | An approval or the Home health scores puts a first line in the main chat composer (#65; merged) | The main-chat half is done. After #2: open a server session carrying a context reference (ADR-0077 pins). | L4, contracts | Additive |
| 9 | Voice | Claude and ChatGPT voice; Poke voice messages; Instinct calls; the website's composer mic and its "Planned" voice panel | Mic disabled. The iOS keyboard's dictation already works in the composer. | **Deferred by the owner (11 Oct), not dropped:** ruling 10 still owes the "Planned" voice panel. Until then the Mic stays visible and disabled. When it resumes: on-device recognition only (`requiresOnDeviceRecognition`), because server recognition would send the owner's speech to Apple, which is provider egress. Then voice notes (the `voice` part exists), read-aloud and the Brief read out. | L4, then L2 | The speech library is a dependency change, reviewed in the app lane; voice notes need contract review |
| 10 | Photos and files into the chat | Every chat app | Attach disabled; text-only send | Upload route, storage, a taint class, image input to the model | L2, L4 | Contract and ADR review |
| 11 | Managing chats: rename, pin, search, synced archive and delete | Claude, ChatGPT | Local archive and delete | Follows #2. Search means processing conversation bodies. | after #2 | ADR review for search |
| 12 | Edit and resend; regenerate | Claude, ChatGPT | Retry of the same id. "Edit as a new message" fills the composer (#63; merged). | Still open: retry from the reply row, which sends the question again as a new message. True branching needs an ADR. | L4 | ADR for branching |
| 13 | Memory and activity in the app ("what Waldo knows", "what Waldo did") | Muse: editable memory files and an audit trail; Folk: memory dashboard; Dots: Activity View | Console only | Already step 2 in the owner's order (memory) | L3, L4 | Single memory write path |
| 14 | Artifacts library | Muse | `artifact` part exists, not drawn | Later | L4, L2 | |
| 15 | Rate any message (thumbs up or down) | The website's "Thumbs" panel, labelled "Working today"; Claude, ChatGPT | Telegram update cards only (`fb:` callback, `telegram-owner-do.ts:1462-1465`; `update-cards.ts:54-59`) | An additive app action, and a store the rating feeds. A rating changes style and which messages arrive, never truth or authority (promise ledger). | contracts, L2, L4 | Additive |
| 16 | Context Waldo pins at the top of a chat | The website's "Pinned by Waldo" chips: a draft, a call time, a renewal amount | Nothing | A read-side field on a chat's history that lists what Waldo pinned, each item from a real source (the ADR-0077 pins). The model picks what to pin. | contracts, L2, L4 | ADR-0077 subset review; real values only |
| 17 | The first message of the day is not held behind background work | Claude and ChatGPT start answering at once | Draft PR #1061 traced slow console actions in tests to the owner DO's `serial` queue: the first request on a cold DO waits for `setup().ready`, which queues the boot `planToday`. #1061 fixes only the test pool. Its production follow-up [inference]: the first interactive request of an owner-local day waits one full model call (about 6 s per the latency baseline), and during an OpenAI 5xx incident the SDK's retries stack inside `serial`. `migrateCoreFiles` is queued the same way. | Stop boot work from holding the owner's first request without breaking the ordering `serial` protects: a forget or a pin must not land between a model call's memory check and its apply (two `dashboard-controls-owner` tests depend on it). | L2 | Measure on staging before and after |

Rows 15 and 16 were added from the website scan, and row 17 from #1061; they are not ranked.

**Row notes (website scan and PR #998, 11 Oct):**
- **#2.** Draft PR #998 (last updated 10 Oct) already has a `threads.v1` contract and runtime: `contracts/src/app/threads.ts`, `replay.ts` and `media.ts`, and `channels/app-threads.ts`, at `fc4c2b9d`. It covers:
  - listing, creating, reading, archiving, deleting and cancelling threads;
  - sending with `context_refs` and `attachment_refs`;
  - a receipt whose `closed_reason` includes `cancelled`, `archived`, `deleted` and `thread_changed`;
  - an event replay route.

  It is a candidate starting point, not a reviewed design:
  - It has no rename route. Auto-titled chats need one (the model names a new chat from its first question, as the website shows), and so does #11.
  - It adds a seventh contract file that the app pins, under `contracts/src/app/*`, so decision 1 gates the port.
  - A transcript per thread is conversation-body storage, which needs contract or ADR review (CLAUDE.md).
  - Per the promise ledger, #998's head has 76 failing tests and conflicts with `beta-mvp`. The ledger re-cuts it by path: threads are item 8, after the receipt kernel. Threads are also item 3 in L3's queue.

  L4 asked for these in the threads contract (11 Oct). Here is what #998 does at `fc4c2b9d` (`app-threads.ts`, and the host in `telegram-owner-do.ts`):
  - **Rename:** there is no route.
    - Auto-titling renames a chat while its first turn is still running.
    - In #998, any change to a thread's `revision` closes the running turn (`assertAppConversationCurrent`).
    - A rename that bumps `revision` would therefore end that first reply [inference]. A rename needs its own revision, or must leave the turn fence alone.
  - **Last activity:** missing. `updated_at` changes only on create, archive, cancel and delete, never on a send or a reply. The list sorts by it, so it is not ordered by last activity. A `last_activity_at` field must also leave the turn fence alone.
  - **Kind:** there is none. Main is not a thread; it stays on `/app/v1/chat/main`.
  - **Archive and cancel:** both stop the running turn and bump `revision`, so a send still carrying the old `expected_revision` gets 409. Archive can be undone with `archived: false`. Sending to an archived thread returns 409 `thread_archived`.
  - **Delete:**
    - It stops the turn and erases only that thread's records: messages, recall-index rows, inbox and delivery records. It returns `erased_messages`.
    - Memory derived from the session is left alone [inference]; see decision 2.
    - It keeps a tombstone with an empty title, which the list hides.
    - It never touches main or another surface; messaging surfaces see main only.
  - **Receipts:** per thread, at `GET /app/v1/threads/{thread_id}/messages/{client_message_id}`. The shape is the main receipt plus `effects_unconfirmed`. Main keeps its own route.
  - **Limits:** at most 256 live threads (429 `thread_capacity`). The list has no paging. History pages by cursor, at most 50.
  - These wait on decision 1. L4 has been told not to build against #998 until the contracts owner confirms.
- **#4.**
  - The website's hi-fi chat shows prepared actions as a "Ready when you say" list, tagged with state words: Checked, Prepared, Needs you, Watching, Done. Approval cards should use the same words.
  - Charts: health series in the app are fine under the beta ruling. But a `chart_series` part's `fallback_text` that reaches WhatsApp or iMessage would carry health numbers to another destination. Review that against ADR-0081 and `docs/app/HEALTH_PLANE_AMENDMENT.md`. The promise ledger already limits health series to the owner's own surfaces.
- **#6, #8 and #16.**
  - #998's cancel route is per thread (`POST /app/v1/threads/{thread_id}/cancel`). The main chat still needs its own cancel route; #998's `core.ts` has none.
  - #998's `context_refs` (`thread` or `source` refs) are attached by the client when it sends. They cover "Ask Waldo" from a card.
  - They do not cover the website's "Pinned by Waldo" chips. Those are context that Waldo picks and shows on the read side of a chat, and #998 has nothing for them. That is #16.
  - The runtime has no model streaming, and replies pass post-model guards whole (promise ledger). Streaming therefore needs an ADR; it is not a flag.
- **#13.** Correcting a memory in chat, as the website's Trust window shows, needs an `update_memory` handler. The tool is registered but has none (`hooks/tool-replay-class.ts:48`).

## What the website promises about chat

Source: `Pin4sf/waldo-landing` `main` `830bfc2`, read with `git show main:<path>`. Each promise's status lives in the promise ledger (`docs/planning/WEBSITE_PROMISE_LEDGER_2026-10-10.md` on `beta-mvp`). The table below only maps each promise to a row above.

**The "Talk to Waldo" panels** (`app/how-it-works/page.tsx`):

| Promise | Site label | Promise ledger at `e5fd7200` (file line) | Row |
|---|---|---|---|
| Threads: each part of life in its own conversation, one tap between them | Working today | Contract only on beta; #998 has routes (line 116) | #2 |
| Follow up on anything: "Tell me more" opens a thread about that message | Coming next | Telegram reply-quote only (line 117) | #8 |
| Quick replies | Working today | Nothing (line 118) | #4 |
| Charts in replies | Working today | Nothing (line 119) | #4 |
| Full history, with the reason beside each move | Working today | Main chat history works; the reasons need provenance, and search is missing (line 120) | #11, #5 |
| Thumbs up, thumbs down | Working today | Telegram update cards only (line 121) | #15 |
| Voice: ask out loud, hear the answer, have the Brief read out | Planned | Voice in on Telegram and WhatsApp only (line 138) | #9 |

The ledger's own count: none of the 19 "Working today" panels is accepted under the app bar (line 143).

**The hi-fi app chat** (the See section's "Chat" and "Plan" cards; `components/site/see/chat.tsx`, `kit.tsx`, `see-fixture.ts`):
- A chat starts as "New chat" and is renamed from the question → #2.
- "Pinned by Waldo" context chips sit at the top → #16.
- "Waldo is looking" dots, then parallel checks that collapse to "Checked 3 things" → #5.
- A short answer comes first, then an evidence card showing what changed and where each fact came from, then the detail → #5, #4.
- A proposal card compares what is scheduled with what Waldo proposes, and a "Ready when you say" list waits for "Do it" → #4.
- Under each answer: copy, thread, thumbs up and down, speak, retry → #7, #8, #15, #9, #12.
- The composer has a mic that becomes the send arrow while you type → #9.

**The feel, for L4.** Mockups set the feel only; the real-data rule holds.
- Waldo's words sit in a white bubble with a hairline, its tail at the bottom left. Yours sit in an ink bubble, tail at the bottom right.
- The app chat shows no avatar, names or times. Charts and lists run full width under Waldo's words.
- Text is system SF Pro at 16.5. The orange accent appears once per screen, on the send arrow.
- New lines rise and un-blur. Checks shimmer while running and settle into one line. Sheets rise on a spring.
- The website's design notes say the bubbles were taken from the app's own `ChatBubble.tsx`, so the app may already match.

**Conflicts on the site to settle:**
- **Two session models.** The how-it-works wireframe shows topic tabs ("This week", "Training", "Lisbon trip"). The hi-fi chat shows an auto-titled "New chat" behind a sidebar icon. See decision 2.
- **At least seven approval vocabularies:** Yes/No, a typed "Do it", Go ahead/Not now, Move it/Leave it, Approve/Reject, "Send with Gmail", Review/Undo. This is a design call for Suyash: one label set for the contract's four actions, `approve`, `skip`, `edit` and `undo`.
- **No token streaming anywhere.** The mockups show answers arriving in whole, staged pieces. Progress steps meet the website; token streaming is for Claude and ChatGPT parity (decision 3).
- **Undo.** One page says both "One tap takes it back" and "Whether an action can be reversed depends on the service".
- **Where to talk today.** how-it-works says "Talk to it on Telegram and the web today", which the later app-first ruling contradicts.
  - The promise ledger's ruling 10 keeps the copy as published until the owner decides.
  - A local, unpushed waldo-landing branch from 10 Oct, `copy/promise-ledger-2026-10-10`, rewrites the line. It looks superseded by ruling 10 [inference].
  - This needs one answer from the owner. It does not block the app work.

**Notes for the audit lane (re-pins at `e5fd7200`):**
- The promise ledger's defects table cites ratings at `telegram-owner-do.ts:2262`. They are now at `:1462-1465` and in `update-cards.ts:54-59`.
- The missing `update_memory` handler is at `hooks/tool-replay-class.ts:48`.
- At app `9937d456`, C13's app half is met. The pinned `approvals.ts` and `parts.ts` are byte-identical to backend `3839e9d4` and `e5fd7200`, and the app drops items it cannot read and counts them. Approval parts are drawn in the chat. Both are merged and not proven on a device.
- App #62 deleted the app repo's legacy Supabase function source, including `oauth-google`, and the `waldo-worker` source.
  - I have not checked whether those functions are still deployed.
  - A deployed OAuth handler with no source in any repo is a security surface.
  - The read-only check of the legacy deployments needs the owner's go.

## Extensions, not replacements

- Every reply part carries `fallback_text` (`parts.ts`). The same reply therefore degrades honestly to text on Telegram, WhatsApp and iMessage. The contract already supports "app first, other surfaces as extensions".
- Messaging surfaces see the main chat only (ruling 2). Sessions stay in the app and the console.
- Starting now, no new work serves only those surfaces.

## Order of work

**C0, now, app only (L4).**

Merged on app main `9937d456` (#63–#66, about 15:00Z on 11 Oct), not proven on a device:
- Readable replies (#7): markdown, links behind a confirm, a long-press menu and a visible "Share or copy" row.
- Approval cards in the chat, the first half of #4. They decide through the approvals page.
  - C13 is met: the app's pinned `approvals.ts` and `parts.ts` (`src/agent/contracts/backend-999/`) are byte-identical to backend `3839e9d4` and `e5fd7200`.
  - The reader drops an item it cannot parse and shows a count, instead of blanking the page.
  - The buttons use the app's existing per-kind labels. One vocabulary still waits on Suyash.
- "Ask Waldo" into the main chat from the Approvals list and the Home health scores (#8, the main-chat half).
- Edit as a new message (#12).
- The honest session copy holds: "Individual sessions are local drafts only" (`useChat.ts:54`). The Mic and Attach stay visible and disabled (#9).

Still open:
- Review follow-ups. App PR #67 (`ce590e4b`) fixes six of the seven below. It keeps the seventh, the tolerant page envelope, on purpose: unknown keys are ignored so an additive backend change does not blank the page, each item is still parsed strictly, and a comment now says so. I read its diff and ran tsc and jest at its head (pins above). It awaits the owner's merge yes in L4's session. Both MEDIUM fixes come before the device run's approval check:
  - **MEDIUM: a decision sends the wrong digest.**
    - It sends the digest from the current list, not the one the owner saw (`approvalsController.ts:49`). This affects both the chat card and the Approvals screen.
    - The comment at line 15 promises the reviewed digest. Yet a refresh that lands between render and tap approves a version the owner never saw.
    - Fix: pass the rendered digest into `decide()`.
  - **MEDIUM [inference, not device-tested]: VoiceOver cannot reach controls inside Waldo's bubble.**
    - The bubble is one `Pressable` (`ChatPane.tsx:465`), and a Pressable is accessible by default.
    - On iOS that hides the nested approval buttons, the links and the "Share or copy" row from VoiceOver. The bubble's label carries only the message text.
    - The Approvals screen stays the only VoiceOver path to a decision. Check with Accessibility Inspector.
  - LOW:
    - "No longer available" shows when the approvals list failed to load (`approvalCardView.ts:15`).
    - "Edit as a new message" overwrites an unsent draft (`ChatPane.tsx:231`).
    - Markdown is parsed again on every render (`MarkdownText.tsx:47`).
    - The page envelope is `z.object`, not `z.strictObject` (`appRoutesClient.ts:19`).
    - The menu uses `ActionSheetIOS` with no platform check, so it throws on Android. The app is iOS only today.
- Retry from the reply row (#12).
- The website's "looking" and checks styling, driven only by the real receipt phases until #5 lands.
- Cleanup: the unused Ask Waldo paths listed above.
- In parallel, the device run (#3), once the owner gives the go.

**C1, the backend contract wave (contracts owner and L2).**
- In parallel:
  - #2 threads, re-cut from #998 after review;
  - #5 progress steps and sources;
  - a cancel route for the main chat as well as threads (#6);
  - the context reference from #8;
  - the thumbs action from #15;
  - Waldo's pinned context from #16.
- Throughout: P3a and S7 for #1.
- Every app.v1 change is additive and agreed with L4 before it ships.

**C2, liveness (L2, L4).** Streaming after its ADR note. Producers for charts and quick replies.

**C3, media and depth.** Voice notes, attachments, search, branching, artifacts, and memory and activity in the app.

**Against the promise ledger's waves.** C0–C3 reorder the ledger's waves for the app chat; they do not replace them.
- First:
  - the app half of Wave 1: parts drawn in the app, proactive routing to the app, APNs;
  - #998 port items 7–10: receipt kernel, threads, files and media, memory correction.
- The messaging half of Wave 1 follows as an extension.
- Voice in the app moves from Wave 6 to C3.
- Ratings that feed the Brief stay in Wave 4. The thumbs control itself is C1.

**Golden checks, each on a physical iPhone:**
- **Sessions:** create a session and send in it; Waldo replies. Kill the app and reopen it: the session and its messages come back from the server. Telegram does not show it. The console, which has no threads today, comes later.
- **Approval card** (after the digest fix): ask Waldo to email someone. The card in the chat shows the exact recipients and body. Not now: nothing is sent. Do it: one send, and the receipt shows in the chat.
- **VoiceOver:** with VoiceOver on, the approval card's details and buttons in the chat can be reached, and so can "Share or copy".
- **Proactive:** with the app closed, the morning brief arrives as a push. Tapping it opens the main chat at the brief.
- **Progress:** a calendar question shows a real "checking your calendar" step. When the turn closes, one line names the sources read. Both match the trace.

## Coordination (11 Oct, about 15:50Z)

- **One writer for `telegram-owner-do.ts` per wave.** Threads, the cancel routes, progress steps, arming and the row 17 fix all touch it. Merge order for each C1 item: L3's contract PR, then L4 pins the contract hash, then L2's runtime PR, then L4's UI PR.
- **#1060** is merged and not deployed. L1 is the only staging deployer, and that deploy needs its own go.
- **#1061** (draft, test pool only). CI shard 3/4 failed one test, `trusted-run-loop.test.ts:1438`, "settles a pending 'provider_plan' receipt before recomposition can issue the next tool": expected `context:materials_unavailable`, got `llm_observe:effect_receipt_unavailable`.
  - That test drives a scripted gateway with no network. A comment in it and #879 record a race with the platform firing the alarm on its own.
  - #1061 changes only how the pool answers outbound fetches, so a logic link is unlikely [inference]; it can shift timing.
  - Classify before merging: rerun that shard once on #1061 and repeat the test on `beta-mvp`. Do not rerun until green.

## Owner decisions

**Decided (11 Oct, about 15:30Z; the owner took the recommendations):**
1. **Contracts owner.** Restart L3 as the sole editor of `packages/contracts/src/app/*`; almost every item above changes app.v1. L2 keeps P3a, S7 and the DO.
   - Corrected premise: L3 is idle (last active 13:52Z), not finished. Its #1059 is green, and the owner already told L3, in its session, to merge it when green.
2. **What a session is:**
   - its own transcript, sharing the owner's memory and approvals;
   - proactive messages go to main;
   - messaging surfaces see main only;
   - deleting a session deletes its transcript and its recall-index rows (`episodes`, the full-text index in `channels/episodes.ts`, as #998 does). What Waldo learned in it stays: the delete confirmation says so and links to Memory (#13), where the owner can correct it. Account deletion remains the full erasure;
   - the list looks like the website's hi-fi chat: auto-titled chats behind a sidebar, as in Claude and ChatGPT, not the wireframe's topic tabs.
3. **Streaming.** Real progress steps first (#5), token streaming second (#6, after its ADR note).
- **Voice is deferred, not dropped** (row 9).

**Open:**
4. **Go for the live checks and the device run** in L4's session.
5. **C1 before Constellations?** L3's next item in the owner's order is the Constellations view. Recommendation: the threads review and the main-chat cancel come first. Sessions (#2) block the app chat the owner named the core, and L4 waits on that contract. Constellations follows.

**A design call for Suyash, not an owner decision:** one approval vocabulary for the app (see the website conflicts).
