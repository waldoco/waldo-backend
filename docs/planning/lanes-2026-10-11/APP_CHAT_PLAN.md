# App chat plan, 11 October 2026

**Owner direction (11 Oct, about 14:30Z):**
- Stop work that serves only other surfaces.
- Make the app chat the core: the main agent chat plus sessions, at the level of Claude, ChatGPT and Codex, and delivering what Instinct, Meta Muse and our website promise.
- WhatsApp, iMessage and Telegram become extensions of the app chat, not replacements.
- Standing ruling (10 Oct): every promise on heywaldo.in ships, including the "Coming next" and "Planned" panels. The website is therefore the acceptance bar for the chat, alongside Claude and ChatGPT parity.

**Pins:**
- backend `beta-mvp` `15134581`: #1060 (sign out everywhere also revokes app and email sign-ins) merged at 15:32Z on 11 Oct, then #1059 (an optional latest delivery on day cards). Source rows below were read at `e5fd7200`; neither PR touches them;
- staging `15134581` (Worker version `30b43ff7`), per L1's report: deployed on the owner's yes in L1's session, so #1060 and #1059 should be live. I have not checked staging myself;
- waldo-app `main` `18d5d0c3`: #62–#66 merged at about 15:00Z on 11 Oct, #67 (the C0 review fixes) at 15:44Z, then #68 (why the agent could not be reached) and #69 (the chat follows the design system). The checks below ran at `7bbf3135`. Its tree is identical to #67's head `ce590e4b`, where `tsc --noEmit` exits 0 and jest passes 551 tests in 82 suites (1 suite and 1 test skipped). Rows below that cite app line numbers were read at `9937d456`. Nothing has run on a device;
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
| 1 | Waldo speaks first: brief, nightly run, heartbeat and reminders in the app, and a push for what may interrupt | Muse comes back "when something changes or when it needs approval"; Vellum pushes on iOS | Reminders reach the app transcript but are unproven live. Nothing else is armed on the app channel. No push. | P3a (arming, the zone flag), S7 APNs within the design system's push budget, app push registration, a tap lands on the exact object | L2, L4 | **Blocks** |
| 2 | Sessions that reach Waldo | Muse: "one main chat plus side chats"; Claude and ChatGPT: a list of conversations | Local drafts only | Threads contract (an ADR-0077 subset); a transcript per session in the DO; routes to list, create, rename, archive, delete, send, read history and get a receipt; the app switches from the local store to the server | contracts, L2, L4 | **Blocks**; storing conversation bodies needs contract review |
| 3 | Proven on a physical iPhone | n/a | Nothing proven on a device | The live checks and a device run of the loop below | L4, owner go | **Blocks** |
| 4 | Cards inside the chat: approvals (Do it / Not now / Modify), quick replies, charts, files, artifacts | Muse: structured accept or reject cards; Vellum: inline approval buttons; Claude: artifacts | Approval cards are drawn in the chat (#64; merged, not proven on a device). The other parts are not drawn. | Approval cards: each card's buttons look up the same `approval_id` on the approvals page and decide through the route the approvals screen already uses. A changed digest shows the card as changed, with no buttons. Never act on the history part, which is read tolerantly and for display only (`app-routes-v1.ts`). Next: operation steps, files and artifacts. Backend producers for quick replies and health charts: none exists today. | L4, then L2 and L1 | Additive only; charts carry a health gate (row notes) |
| 5 | Live progress and sources ("Checking your calendar", then "Checked 3 things" with where each fact came from) | Claude's tool rows; Dots' Activity View; Muse's avatar work snippet; the website's hi-fi chat | Receipt phase only | Emit real trace hops as steps on a route of their own, not on the receipt, which the app parses strictly (L3's review). Draw them as the design system's working line. When the turn closes, end with one line that names the sources read, never a step count. Nothing decorative. | L2, contracts, L4 | Real-data rule |
| 6 | Streaming replies and a Stop button | Claude, ChatGPT | No stream route. The receipt contract reserves `cancelled`, `archived`, `deleted` and `thread_changed`, but the runtime emits only `interrupted` and `session_revoked` (`app-inbox.ts:23`). | A cancel route first. Then streaming, after a short ADR: the transport (streaming fetch vs a DO WebSocket) and which checks run before text leaves the DO. | L2, L4 | ADR note |
| 7 | Readable replies: markdown, links, lists, code; copy and share; a long-press menu | Every chat app | Markdown, links behind a confirm, a long-press menu and a visible "Share or copy" row (#63, #66; merged, not proven on a device). Text inside a reply is selectable again (#67, merged). | The device check | L4 | None |
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

**The feel, for L4: use the design system** (next section). The website's hi-fi chat differs from it in four places:
- Waldo writes unboxed on the page, not in a white bubble. The app already does this.
- Waldo's turn shows the mark, "Waldo" and the time.
- Send is ink, never orange. The one orange on a screen belongs to a decision.
- The working state is one specific line, never animated dots or a shimmer.

**Conflicts on the site to settle:**
- **Two session models.** The how-it-works wireframe shows topic tabs ("This week", "Training", "Lisbon trip"). The hi-fi chat shows an auto-titled "New chat" behind a sidebar icon. See decision 2.
- **At least seven approval vocabularies:** Yes/No, a typed "Do it", Go ahead/Not now, Move it/Leave it, Approve/Reject, "Send with Gmail", Review/Undo. The design system settles this for the app: the button names the effect (next section).
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

## The design system (shared by the owner, 11 Oct)

The owner's Waldo design system is a claude.ai artifact, visible to the people it is shared with: https://claude.ai/artifact/7wKJuF255GspDEBR643qNS. It holds:
- tokens for three themes;
- 67 React components (`window.Waldo`) and eight showcase screens;
- 19 sections, from colour to voice.

I read it at version `1791721337-e9e9`.

**How an agent reads it** (the Artifact tool's `read` action with a `path`):
1. `project/README.md`: the principles, the rules agents break most, and the card index.
2. `project/api/components/<Comp>.md` for a component's props and states, and `project/api/tokens.md` for token values. A value not read from a card is a guess.
3. `project/components/<Comp>/README.md`: the long-form contract, with states, confirmations, copy and accessibility.
4. The sections that bear on chat: `09-voice-and-content.md`, `10-agency-and-approval.md`, `11-states.md`, `13-notifications-and-channels.md` and `15-platforms.md`.

The React components are the reference for the web and Kennel. The iPhone app reimplements each one natively against the same tokens, and each component's README is the contract both follow (`15-platforms.md`).

**Components for the checklist rows:**

| Row | Component |
|---|---|
| B3 | `NotificationPreview`, `PermissionPrePrompt` |
| B4, B5 | `ThreadRow`: topic titles, an ink unread dot, "Waldo added a note at 07:14", delete through `ConfirmSheet` |
| B8 | `Banner`: "You're offline. Showing what Waldo knew at 07:14." |
| B16 | `AttachmentChip` and the `Composer`'s attachments row |
| A2 | The `Message` working line ("Checking your last 7 nights…", shown at least 0.5 s), `ProcessingCard` for longer jobs, `SourceCard` and source chips ("No source, no claim"), `EvidenceRow` |
| A3 | `ProcessingCard`'s two-step Stop ("Stop", then "Stop now?") |
| A7, A8 | `NeedsYouCard` with `ChangePreview` inside the turn. Once approved, it cross-fades into a `ReceiptCard` with Undo and its window. |
| A9 | `ChoiceChips` for quick replies; suggestion `Chip`s fill the composer and never send |
| A10 | `MemoryClaim` |
| A15, row 8 | `ContextCard` ("Talking about"). It needs the `source` refs that L3's review moved out of C1. |

**What it settles in this plan:**
- **Approval vocabulary.** The button names the effect ("Move to Fri 10:00"). Edit and Not now lead, "Don't do this" sits under the actions, and "Approve" never appears. Open for L3 and L4: how the contract's `skip` maps to the two ways out, Not now (defer) and Don't do this (deny).
- **Push** (B3, row 1):
  - at most three a day, collapsed per object;
  - only for a Needs You near expiry, a change made under a standing permission, a failed or unconfirmed effect, or a source down for more than 6 hours that breaks a promise;
  - the Brief never pushes; it waits in the app;
  - no health values in a push, and no badges;
  - permission is asked after the first value, as provisional authorisation.
  - Its table does not say whether a reminder the owner set may push. That is a question for the owner.
- **Badges** (B14): never. A thread shows an ink unread dot and, when Waldo re-entered it, "Waldo added a note at 07:14".
- **Dark mode** (B19): light ships. Settings shows Dark as "Coming soon" at launch, and a `contrast` theme serves Increase Contrast.
- **Session delete copy** (decision 2): `ThreadRow`'s confirmation says "The conversation and its messages go." and "What Waldo did in it stays in Home." Decision 2 adds what Waldo learned, so the copy needs both.
- **Words:** never "Loading…", "Thinking…", "Oops", "Something went wrong" or an exclamation mark. Receipts are in the past tense, text is in sentence case, and spelling is en-GB.

**Where the app differs today** [verified at app `7bbf3135`]:
- It uses `nativewind/preset`, with none of the system's semantic tokens (`bg-canvas`, `bg-inset`, `text-secondary`) and no copied `exports/`.
- The working state shows animated `TypingDots` (`ChatPane.tsx:500`). The system allows one specific line and no dots.
- The person's bubble is ink (`userBubble`); the system draws it on `bg-inset`.
- The theme store offers a working dark override; the system ships light, with Dark "Coming soon".
- Already matching: Waldo's turn is unboxed, with the mark beside it (`assistantTurn`).

**To settle with the owner:**
- `13-notifications-and-channels.md` calls Telegram "the V1 fallback and demonstration channel". The owner's 10 Oct ruling made Telegram test-only.
- The website's "Pinned by Waldo" chips (#16) have no component. `ContextCard` is the pin the person brings, not one Waldo picks.
- `15-platforms.md` describes a `tooling/build.mjs` export pipeline that the artifact does not hold. Where it lives is unverified.

## Extensions, not replacements

- Every reply part carries `fallback_text` (`parts.ts`). The same reply therefore degrades honestly to text on Telegram, WhatsApp and iMessage. The contract already supports "app first, other surfaces as extensions".
- Messaging surfaces see the main chat only (ruling 2). Sessions stay in the app and the console.
- Starting now, no new work serves only those surfaces.

## Baseline chat features and work left

What every chat app and every agent chat app has, against Waldo at app `7bbf3135` and backend `497bdcb6`. Status is `[verified]` from source unless a cell says `[inventory]`, which means a reading agent reported it and I did not re-check it. Sizes are `[inference]`. XS is hours, S one small PR, M one large PR or two, L several PRs or an ADR first. "Row" points at the gap map above.

**Every chat app:**

| # | Feature | Waldo now | Work | Lane | Size |
|---|---|---|---|---|---|
| B1 | Send once; sending, sent, failed; retry | Built. One client id per send, and retry reuses it. The backend returns the same record for the same id and text. | None | | Done |
| B2 | Stay signed in | The app session ends 12 h after sign-in, with no refresh (`app-api.ts:81`). The owner types an email code twice a day, and a push tapped after that lands on sign-in. `contracts/src/auth/app-session.ts` exists and nothing uses it. | Refresh or rotation, revocable. Security review. | L2 | M |
| B3 | Push; a tap opens the message | Device-token tables and functions exist (`20261010040000_app_push_custody.sql`). No register route, no APNs sender, and the app never imports `expo-notifications`. | Row 1 | L2, L4 | M + M |
| B4 | Conversation list; new chat | Main plus local drafts that cannot send | Row 2 | L3, L2, L4 | L |
| B5 | Rename, archive, delete, pin | Local only | After B4. Rename needs its own revision (row notes). | L3, L2, L4 | S each |
| B6 | Message times; day separators | Stored chat rows carry no time: `ConversationEntry` has no time field, and rows are keyed by sequence (`conversation-store.ts:19`). The app contract has none either. | A stored time (absent on older rows), an additive `created_at`, shown in the owner's zone | L3, L2, L4 | S + S + S |
| B7 | Times in the owner's zone | Approval times use the device zone (`approvalsView.ts`, `toLocaleString()`). This breaks the 11 Oct ruling that the owner's zone wins. | Format with the zone from the day view | L4 | XS |
| B8 | Offline and reconnect | No network awareness: nothing imports NetInfo. | An offline state that keeps the unsent text | L4 | S |
| B9 | Draft survives a restart | Kept in memory per chat, lost on restart | Keep the main draft in secure storage | L4 | XS |
| B10 | Long messages | The counter allows 4,000 characters, but the app caps the body at 8,192 bytes (`appRoutesClient.ts`). The server allows 32,768 (`APP_SEND_MAX_WIRE_BYTES`). About 2,700 Hindi or CJK characters always fail, and Retry fails the same way. | Use the contract's wire cap | L4 | XS |
| B11 | Scroll, load earlier, jump to latest | Built. No new-message marker `[inventory]`. | The marker | L4 | XS |
| B12 | Copy, share, select | Built (#63, #66, #67) | None | | Done |
| B13 | Markdown, links, code | Built, without tables | None | | Done |
| B14 | Unread marker | Missing | An ink unread dot per thread, and "Waldo added…" (`ThreadRow`). No badge counts: the design system rules them out. | L4 | S |
| B15 | Search | Missing | Row 11 (ADR) | | L, C3 |
| B16 | Photos and files | Missing | Row 10 | | L, C3 |
| B17 | Voice | Deferred | Row 9 | | Later |
| B18 | Accessibility | Labels, live regions and reduced motion. #67 opened Waldo's bubble to VoiceOver (not device-tested). | The VoiceOver golden check | L4 | XS |
| B19 | Dark mode | Built. The light/dark override lives in a store that is not saved, so it resets on restart (`theme.store.ts`). The channel label is a fixed `#BDBDBD` in both themes (`ChatPane.tsx:453`), reported as low contrast on the dark-mode bubble `[inventory]`. | A design call: the design system ships light, with Dark "Coming soon" at launch and a `contrast` theme | L4, Suyash | XS |
| B20 | Rate limits | A 429 shows the generic error. The server always sends `Retry-After: 60`. | Say when to try again | L4 | XS |

**Every agent chat app:**

| # | Feature | Waldo now | Work | Lane | Size |
|---|---|---|---|---|---|
| A1 | Working indicator | Built from the receipt phases | None | | Done |
| A2 | Live steps and sources | Phase text only. The app's evidence line is never set `[inventory]`. The reply ends with a plain-text receipt line listing effects (`owner-turn.ts:593`). | Row 5 | L3, L2, L4 | S + M + M |
| A3 | Stop | Missing. There is no cancel route, and a turn closes early only as interrupted or session-revoked (`app-inbox.ts:23`). | Row 6, cancel first | L3, L2, L4 | S + M + S |
| A4 | Streaming | Missing | Row 6, after its ADR | | L, C2 |
| A5 | Regenerate | Missing | Send the question again as a new message | L4 | S |
| A6 | Edit and resend | Fills the composer (#63), appending to a draft (#67) | None | | Done |
| A7 | Approvals in the chat | Built (#64, #67) | The golden check | L4 | XS |
| A8 | Receipts and undo | The decision notice, plus the server's Undo. Only calendar changes can be undone, within 10 minutes. | The website's undo conflict; the unused inline confirmation card | L4, Suyash | S |
| A9 | Quick replies, charts, files, artifacts | Contract only; nothing produces them | The fallback rule below first, then producers | L2, L4 | M each, C2 |
| A10 | See and correct memory | Console only. `update_memory` has no handler. | Row 13. Until the app has a Memory view, the session-delete confirmation points at the console's Memory. | L3, L2, L4 | M + M + M |
| A11 | What Waldo did | The backend's `activity` view exists (`controls.ts:8`). The app never asks for it. | Draw it | L4 | S |
| A12 | Waldo speaks first | Reminders only. Nothing is armed when the app starts. | Row 1, P3a | L2 | M |
| A13 | Background work; told when done | Runs show only in the activity view, which the app does not draw yet (A11) | With B3 | L2, L4 | S |
| A14 | Connect a service from the chat | During an app turn, the "Connect Google" message is accepted and dropped, and the producer records it as sent (`surfaces/app.ts`, `deliverConnectLink`). The app's Connections screen does connect Google. | Fail honestly now. Later, a link inside the reply. | L2 | S |
| A15 | Ask about a card in its own session | Ask Waldo fills the main draft only | Rows 2 and 8 | | After B4 |
| A16 | Usage and the cost ceiling | The $25 per-user monthly ceiling is not wired | #915 (open) | L2 | M |
| A17 | Custom instructions | Time zone and quiet hours only | Later | | |
| A18 | Fast first reply | Row 17 | Row 17 | L2 | M |

**The fallback rule, before any new part type ships.** Every reply must still read as text in the app. Either the runtime fills the message's `text` with the parts' fallback, or the app draws `fallback_text` for parts it does not draw. Today the app shows only `text` and text parts (`transcriptAdapter.ts`), so a reply made only of new parts would be an empty bubble. This step goes ahead of any producer in the merge order.

**Work left for "the basics are covered"** (C0, C1, B2 and A14; not streaming, media, search or voice) `[inference]`:
- **L4, app:** about 8 PRs, plus the device run:
  - one polish PR (B7, B9–B11, B19, B20, A5, the cleanup);
  - one each for activity (A11), offline (B8), push and badges (B3, B14), server sessions (B4, B5), steps (A2), stop and times (A3, B6), and Memory (A10).
- **L3, contracts:** about 3 PRs after #1059:
  - one C1 contract PR: the threads subset with a rename revision and last activity, cancel keyed to the turn, a steps route, `created_at`, thumbs, the fallback rule and the push device routes (L3's review trims the subset);
  - memory;
  - session refresh.
- **L2, runtime:** about 11 PRs: P3a, S7, the threads port from #998, cancel, steps, times, A14, B2, row 17, thumbs and the `update_memory` handler.
  - Most of these touch `telegram-owner-do.ts`, so they run one after another. L2 is the critical path.
- **L1:** one staging deploy per wave. **Audit:** re-checks the promises after each wave.
- **About 22 PRs.** At one or two merged PRs per lane per working day, L2's queue sets the length: about 5 to 8 working days. L3 and L4 run ahead in parallel. Streaming (C2) and media and search (C3) are each a further wave with an ADR first.

**How it can land in one push:**
- **One go dispatches every lane** with its slice of this plan.
- **Work lands in waves.** Each merge and each deploy still needs the owner's go in the session that runs it. The owner gets one message per wave listing what is ready.
- **One writer per wave on `telegram-owner-do.ts`.** Merge order per C1 item: L3's contract, then L4's hash pin, then the fallback rule, then L2's runtime, then L4's UI.
- **To shorten the critical path,** files outside the owner DO can go to a second writer: the APNs sender and its register route, session refresh, and the `update_memory` handler. Any call site in the owner DO lands in L2's wave. See decision 6.
- **Two reviews can stretch the estimate:**
  - Thread transcripts are conversation-body storage, which needs a bounded contract or ADR review (CLAUDE.md).
  - Session refresh changes auth, which needs a security review before merge.

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

Review follow-ups, landed with #67 (merged 15:44Z, not proven on a device):
- #67 fixes six of the seven below.
- It keeps the seventh, the tolerant page envelope, on purpose. Unknown keys are ignored so an additive backend change does not blank the page, and each item is still parsed strictly. A comment now says so.
- I read its diff and ran tsc and jest at its head (pins above).
- The device run checks both MEDIUM fixes:
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
Still open:
- Retry from the reply row (#12).
- The website's "looking" and checks styling, driven only by the real receipt phases until #5 lands.
- Cleanup: the unused Ask Waldo paths listed above.
- The app-only items in the baseline checklist below.
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
- **Approval card:** ask Waldo to email someone. The card in the chat shows the exact recipients and body. Not now: nothing is sent. Do it: one send, and the receipt shows in the chat.
- **VoiceOver:** with VoiceOver on, the approval card's details and buttons in the chat can be reached, and so can "Share or copy".
- **Proactive:** with the app closed, a Needs You with a near expiry arrives as a push: title "Waldo", the exact action, its expiry, and no health values. Tapping it opens that request. The Brief is waiting on Home and did not push. Whether the Brief also pushes waits on the owner: the website promises a 6:30 notification (register question 8).
- **Progress:** a calendar question shows a real "checking your calendar" step. When the turn closes, one line names the sources read. Both match the trace.

## Coordination (11 Oct, updated about 16:40Z)

- **One writer for `telegram-owner-do.ts` per wave.** Threads, the cancel routes, progress steps, arming and the row 17 fix all touch it. Merge order for each C1 item: L3's contract PR, then L4 pins the contract hash, then L2's runtime PR, then L4's UI PR. The fallback rule (in the baseline checklist) lands before any new part producer.
- **#1060 and #1059** are merged and not deployed. L1 is the only staging deployer, and that deploy needs its own go.
- **L3's C1 review** is on #998 (16:13Z). The owner kept it posted and approved its reduced scope: no replay, media, `source` refs or rights in this wave. It corrects this plan twice:
  - Live steps cannot go on the receipt, because the app parses receipts strictly. L3 recommends a route of their own; L4 and the owner pick.
  - A thread's `revision` change also closes turns in other threads that cite it. So rename gets its own `title_revision`, and cancel is keyed to the turn.
  - The C1 contract PR opens once L4 and L2 have answered the review's questions.
- **L2's answers** (#116):
  - `last_activity_at` lives on the thread row, written by one helper.
  - Ratings go in a new owner-DO table, `message_ratings`, which needs a reserved DO migration.
  - Owner-DO waves: W1 P3a, started on the owner's go; W2 S7 and the device routes; W3 the threads port, after the C1 contract; W4 steps, ratings and the "Connect Google" fix.
  - Session refresh runs alongside the waves, outside the DO.
- **Constellations** is built on L3's local branch `feat/app-constellation-view` (`e6761e42`), not pushed. Its PR and merge need the owner's go in L3's session.
- **#1061** (draft, test pool only). CI shard 3/4 failed one test, `trusted-run-loop.test.ts:1438`, "settles a pending 'provider_plan' receipt before recomposition can issue the next tool": expected `context:materials_unavailable`, got `llm_observe:effect_receipt_unavailable`.
  - **Classified as flaky and pre-existing, not caused by #1061** (cf002a's session; I re-checked the first two points):
    - The test pool runs the run loop in fake mode, which builds `FakeRunLoopGateway` and no network adapter (`run-loop/adapters.ts:137-151`). #1061's egress stub is never on this path. My first guess, an unmapped host answered with a retried 502, was wrong.
    - `beta-mvp` run 38077476494 (`1757beb2`, 10 Oct) failed a sibling crash-and-recover case in the same file at 2,546 ms ("promise resolved false instead of rejecting"), without #1061.
    - cf002a also reports 0 outbound requests across 3 full runs of the file at #1061's head, and 6/6 and 5/5 local passes.
  - The pattern: different crash-and-recover cases fail at about 2.5 s, which matches the platform-alarm race the test's own comment and #879 describe [inference].
  - Next, per the test-failure rule: quarantine and ticket the race with an owner and a removal date. Do not rerun until green. A one-off CI rerun of #1061, and its merge, are the owner's call in cf002a's session.

## Owner decisions

**Decided (11 Oct, about 15:30Z; the owner took the recommendations):**
1. **Contracts owner.** Restart L3 as the sole editor of `packages/contracts/src/app/*`; almost every item above changes app.v1. L2 keeps P3a, S7 and the DO.
   - Corrected premise: L3 is idle (last active 13:52Z), not finished. Its #1059 is green, and the owner already told L3, in its session, to merge it when green.
2. **What a session is:**
   - its own transcript, sharing the owner's memory and approvals;
   - proactive messages go to main;
   - messaging surfaces see main only;
   - deleting a session deletes its transcript and its recall-index rows (`episodes`, the full-text index in `channels/episodes.ts`, as #998 does). What Waldo learned in it stays: the delete confirmation says so and links to Memory (#13), where the owner can correct it; until the app has a Memory view, that is the console's. Account deletion remains the full erasure;
   - the list looks like the website's hi-fi chat: auto-titled chats behind a sidebar, as in Claude and ChatGPT, not the wireframe's topic tabs.
3. **Streaming.** Real progress steps first (#5), token streaming second (#6, after its ADR note).
- **Voice is deferred, not dropped** (row 9).

**Decided later (11 Oct, about 16:55Z; the owner took the recommendations again):**
5. **C1 before Constellations:** settled in L3's session (the review, then Constellations); both are done.
6. **A second runtime writer: withdrawn** after L2's answer. L2's own plan carries S7 in W2 and session refresh alongside its waves. It comes back only if W2 slips.
7. **The design system is the app's UI contract.** Where the website's mockups differ, it wins for the app.
   - Its channel page now says Telegram is a test surface (design system version `1791739821-2ff8`).
   - Where the app differs today, and what unblocks each gap: [APP_DESIGN_SYSTEM_GAPS.md](APP_DESIGN_SYSTEM_GAPS.md).
8. **L2's W2:** S7 and the device routes, plus storing `created_at`. Cancel lands in W3 with the C1 cancel route.

**Open:**
4. **Go for the live checks and the device run** in L4's session.
9. **Whether a reminder the owner set may push.** The design system's push table is silent. Recommendation: yes, at the time the owner chose, held by quiet hours, with no health values, and the row added to the design system's table.
10. **The register's owner questions:** the token pipeline, the dock labels and side menu, the three scores' colours, dark mode at launch, deny against `skip`, and renaming Patrol, Spots and Fetch.

**Approval vocabulary:** the design system settles it for the app (buttons name the effect). Still open for L3 and L4: how the contract's `skip` maps to Not now and Don't do this.
