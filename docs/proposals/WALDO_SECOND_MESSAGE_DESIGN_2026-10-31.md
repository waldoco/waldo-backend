# Second message while Waldo works: findings and design, 31 Oct 2026

Design only. This document and its characterising tests change no runtime code, flag, deploy or migration. It is a candidate: the owner approves it before any slice is built, and each slice is then built under its own issue and gate review.

- **Baseline:** `beta-mvp` at `fe3d73ae5` (merge of #1753). Backend `file:line` citations are at that SHA. App citations are `waldo-app` `origin/main` at `b8432541`.
- **Tags:** [verified] means a test in this PR observed it, or I read it in source at the baseline (marked "source"). [inference] means concluded but not observed. [proposed] is a design choice this document puts forward.
- **Tests (this PR):** `packages/runtime/test/second-message-app.test.ts`, `imessage-second-message.test.ts`, `whatsapp-second-message-owner-do.test.ts`, `telegram-second-message-steer.test.ts`. They pin today's behaviour; they are not the target.

## The owner's report

"If I send two messages in a row while Waldo is working, Waldo drops the first task and works on the new one. On iMessage it doesn't happen at all."

## What happens today, per surface

The owner sends B while A's turn is running.

| Surface | What happens to B | What happens to A | Is a reply lost? | Evidence |
|---|---|---|---|---|
| App, backend | Durably admitted; runs as its own turn after A. B's model input holds A's ask and A's reply. | Untouched. | No. Each message gets its own reply, hung under it. | [verified] `second-message-app.test.ts` |
| App, iOS client | **Cannot be sent.** While A is accepted, the composer's button is Stop, even with text typed. Tapping where Send was cancels A. | Cancelled by that tap ("You stopped this one."). | A's reply is never written. | [verified] source: `Composer.tsx` (`onStop ? Stop : Send`), `ChatPane.tsx:298`, `useChat.ts:129,137`, `mainChatController.ts:110` |
| Console | Admitted on the app inbox (the console proxies to the app send path) and queued like the app. The console UI shows Send whenever text is typed. | Untouched. | No. | [verified] source: `console-chat.ts:59`, `dashboard-app/src/Chat.tsx:236-238`; backend half is the app test |
| iMessage | Durably admitted; runs as its own turn after A. | Untouched. A's reply is frozen to thread onto A's message because B came in first (`imessage/final-outbox.ts:108`). | No. Both replies reach the host, A first. | [verified] `imessage-second-message.test.ts` |
| WhatsApp | Meta gets its 200 at once. B waits as an in-memory promise behind A on `serial()`; the pending record holds message ids only. | Untouched, unless A outlives the 150 s WhatsApp turn deadline. Then A is closed with the partial notice and no reply, and B runs. | A's reply, when A runs past 150 s. A queued B on eviction: it is never replayed and gets the same "may have only partly handled" notice, though it never started. | [verified] `whatsapp-second-message-owner-do.test.ts`; eviction path [verified] source `owner-do.ts:2268` |
| Telegram (internal) | Steered into A by a fixed rule: any non-command text while a run is live becomes a steer (`owner-do.ts:802`). | Usually folded: B reaches A's next round as "[While you were working, the owner added: …]". **But if B lands while A's round is building its context, A's run throws `ClosedRunError`.** The owner DO then closes A as uncertain and B runs as its own turn. | A's reply, in that race. | [verified] `telegram-second-message-steer.test.ts` (responder half); owner-DO half [verified] source `owner-do.ts:899-924` and `owner-do-ingress-isolation.test.ts` ("late steering to a closed target becomes one ordinary FIFO turn") |

Steer exists only on Telegram [verified]. `steerTarget`, `bindTarget` and `durableConsume` are only called on the Telegram runtime (`owner-do.ts:831`, `:871-884`). Every other surface has a `turnControl` that nothing feeds.

No surface lets a new message abort the running turn [verified]: the only abort a new message triggers is the app's compaction job (`owner-do.ts:1947`, `:1953`).

### Which path produces "drops the first task"

Ranked by how well each fits the report. All three mechanisms are real; which one the owner hit is not yet observed.

1. **App: Stop sits where Send was** [inference, strongest fit]. The owner types B while A runs and taps the button. It is Stop, so A is cancelled. The draft survives, Send comes back, and B runs. To the owner that reads exactly as "dropped the first and worked on the new one". *Falsifier:* the dropped message's app inbox row is not `closed_reason: 'cancelled'`, or the owner was not on the app.
2. **WhatsApp: the 150 s turn deadline** [verified mechanism]. `TURN_TIMEOUT_MS = 150_000` (`telegram-listener.ts:11`) is the WhatsApp turn's wall clock (`owner-do.ts:2110`), against 15 min on the app and iMessage and 14 min on Telegram. A long A dies, then B runs. The notice says "your last WhatsApp message", which by then reads as B. *Falsifier:* A finished inside 150 s, or no partial notice arrived.
3. **Telegram: the context-build race** [verified mechanism]. It fires when B lands within the seconds A spends gathering recall, receipts and health for a round, which is exactly "two messages in a row". *Falsifier:* the owner was not on Telegram. Telegram is internal only.

The backend never drops A on the app, console or iMessage because of B [verified].

**The iMessage half of the report has two readings**, and the evidence fits both:
- "The drop doesn't happen on iMessage." This is consistent with the test: B queues and both are answered.
- "On iMessage, a second message gets no response at all while Waldo works." Also consistent: staging runs `WALDO_IMESSAGE_PROGRESS=0` (`wrangler.jsonc:109`), so B sits silently behind A, possibly for the full 15 min.

Asked of the orchestrator; see Owner decisions.

**Cheap confirmation, needs read access to staging (not done here):**
- App inbox rows with `closedReason: 'cancelled'` near the reported time.
- WhatsApp partial notices sent.
- Telegram inbox rows quarantined `execution_uncertain` with a returned steer child.

## Design

### (a) A second owner message: fold, queue or stop, decided by the model

Today, every surface but Telegram queues by construction, and Telegram steers by a fixed rule. Both are fixed answers to a judgment call. Whether B adds to A ("also make it Friday"), is separate ("is it raining?") or replaces A ("forget that, do X") is the model's to decide (CLAUDE.md, constraint 1).

[proposed] One seam, inside OwnerDO, the same on every surface:

1. **Durable admission first.** B is admitted on its surface's inbox before any decision. App, console and iMessage already do this. Telegram does it too. WhatsApp does not: B is a promise. WhatsApp moves to an inbox with per-message rows, admitted before the ack, so B survives eviction and its receipt can be honest. One writer per aggregate is unchanged: the OwnerDO inbox.
2. **Offer, don't inject.** At A's next round boundary, the running turn sees B as a host note: "The owner sent a new message while you work: … ". The model answers through one small tool, `owner_message_heard({ id, choice })`, with three choices:
   - `fold`: B changes or adds to this task. A's final answers both. B's row closes as answered by A's reply, durably, before any text of B reaches a model round. Telegram's `durableConsume` is that path today; it generalises.
   - `queue`: B is separate. B stays admitted and gets its own turn after A, as today on most surfaces.
   - `stop_current`: B replaces A. A ends at this boundary with an honest receipt (d), and B runs next.

   A B the model never answers stays queued. That is the safe default: nothing is lost, and nothing is folded without the model saying so.
3. **Deterministic only where a reject must be guaranteed.**
   - `/stop`, and the app and console Stop control (`AppInbox.cancel`, `app-inbox.ts:132`).
   - Session revoke, unlink and rebind.
   - The run's own deadline.

   None of these asks the model.
4. **Fix the context-build race before generalising steer.** A steer that lands while a round builds its context must make the round rebuild once more, not close the run. Today it throws `ClosedRunError` (`owner-turn.ts:564`, `:668`, rethrown at `:772`). The fix is in `owner-turn.ts`, not `owner-do.ts`. The rebuild is bounded: at most one extra rebuild per round, then B waits for the next boundary.
5. **The app client lets the owner send.** The iOS composer shows Send whenever the draft has text and Stop only for an empty draft, as the console does. It keeps one slot per message, not one `pending` slot for the chat. The backend needs no change for the app to queue B.

Rejected alternatives:
- **Steer everything,** Telegram's rule on every surface. This keeps a fixed rule for a judgment call, and inherits the race.
- **Queue everything.** This is safe, but the owner cannot correct a running task ("make it Friday instead") without waiting up to 15 min or stopping it.
- **Interrupt on every new message** (latest wins). This is the reported bug made policy.

### (b) When a long ask becomes a background task

What exists [verified source]:
- `start_task` writes a job, arms a wake and returns at once (`tasks/tools.ts:35-75`).
- The worker is its own Durable Object, with its own 10-minute alarm slices and a 6 h deadline.
- Its tool RPCs do not take the owner's `serial()` queue. Browser tools are the exception (`owner-do.ts:601`).
- Only the report's apply turn runs on `serial()`.

So B can be answered while a task runs, waiting at most behind one apply turn [inference: no test asserts it].

Why the model rarely uses it [inference from source, no trace]:
- `start_task` is not in the core tool set. It is deferred in the `reminders` namespace, so the model sees only "start_task for long work that reports back later" (`tools/records.ts:14`) and must load it through tool search first.
- The prompt has no guidance on when a reply should hand work off.
- Nothing tells a turn how long it has been running.

[proposed]:
- Always load `start_task` and `cancel_task` on owner turns.
- Give the model the elapsed wall clock and the count of waiting owner messages as round context ("You have been working 95 s; 1 owner message is waiting").
- Add one prompt line, as context and not a rule: when the rest is long, start a task with what you have and reply now.
- Test the model's choice with scenario evals (judgment → scenarios, not a timer rule).
- Separately, the WhatsApp 150 s turn deadline is a leftover from the polling era (W0 hardening, `96c768347`). WhatsApp replies are asynchronous like the app's, so it should get the same 14–15 min deadline and the same hand-off.

Report routing [verified source]: a task's report goes to the owner's first proactive surface for that alarm pass (`owner-do.ts:2811-2840`, `drainJobs` at `:3121`). It does not go to the surface the owner asked on. A task started on iMessage can report in the app. Owner decision D3.

Done criterion "owner gets a reply while a 10-minute job runs": the mechanism is in place [inference]. It is untested. The first slice adds the golden test.

### (c) Parallel tasks and one merged brief

What exists [verified source]:
- At most `TASK_MAX_PER_TURN = 3` tasks per turn and `TASK_MAX_OPEN = 10` open (`tasks/jobs.ts:84-85`, enforced at `tasks/tools.ts:60-61`).
- At most `TASK_MAX_RUNNING = 3` workers at once (`jobs.ts:77`).
- Each report gets its own apply turn and its own outbox record. Nothing merges.
- `delegate_task` runs several read-only subagents in parallel inside a turn (`conversation/subagent.ts:151-153`), but it blocks that reply.

So "four parallel research workers return one merged brief" fails today [verified source]:
- The fourth `start_task` in a turn is refused as `rate_limited`.
- Only three would run at once.
- The owner would get separate reports, not one brief.

[proposed]:
- A **task group**: one `start_task` call with N briefs and a merge instruction, or a `group` field on several calls in one turn.
- The job book records the group.
- The jobs lane holds the apply turn until every member has settled or the group's deadline passes.
- One apply turn then receives every member's report and writes one brief.
- The caps become a budget envelope with a hard ceiling. The ceiling stays as a guard on spend and fan-out; it is not a product rule.
- The job book's group column is a persistence change. It needs bounded contract review, and the gate allocates any migration.

### (d) Honest receipts when a turn is interrupted

| Case | Today | Honest? |
|---|---|---|
| App, owner stop | Receipt `interrupted` / `cancelled`, `effects_unconfirmed`; app shows "You stopped this one." | Yes [verified] |
| App, deadline or crash | One "did not finish" reply under the message, with the landed-effects line and when it was received (`owner-do.ts:1313-1345`). | Yes [verified source] |
| iMessage, did not finish | `RUN_DID_NOT_FINISH` plus when the request was received. | Yes [verified source] |
| WhatsApp, A past 150 s | "I may have only partly handled your last WhatsApp message." | **No.** It names no message, and B is the owner's last message by then [verified test]. |
| WhatsApp, queued B on eviction | The same partial notice. | **No.** B never started, so the unstarted notice is the true one [verified source]. |
| Telegram, race | "Your request was interrupted, and its outcome is uncertain…" | It does not say which request [verified source]. |
| Any surface, model chooses `stop_current` | n/a | [proposed] below |

[proposed] Every interrupted-turn receipt says three things:
- Which message: its time, and a short quote where the surface allows. The quote is the owner's own text, so it is no new egress.
- Whether that message started.
- What already landed: the receipt line the app's notice already carries.

A folded B closes as "answered in the reply to <A>". On the app this is an additive app.v1 receipt field or `closed_reason` value. The gate allocates the revision, and the app lane hears before any new enum value ships.

## Ranked build plan

Each slice is its own issue, PR and gate review.

| # | Slice | Where | Size | Why this rank |
|---|---|---|---|---|
| 1 | **App composer: Send when text is typed, per-message slots.** Golden test: send B during A, both answered. | waldo-app (app lane) | S | Strongest fit for the reported symptom; the backend already queues. |
| 2 | **Steer race: rebuild, don't close.** `telegram-second-message-steer.test.ts` case 2 flips to "A answers both". | `owner-turn.ts` | S | Removes a verified way a reply is lost. No `owner-do.ts` edit. |
| 3 | **WhatsApp honesty and durability.** Per-message inbox rows; unstarted B gets the unstarted notice; notices name the message. | `owner-do.ts`, WhatsApp inbox | M | Verified dishonest receipts. Sequenced after the day-awareness lane releases `owner-do.ts`. |
| 4 | **WhatsApp deadline parity:** 14–15 min plus progress notes. | WhatsApp turn constant | S | Verified short deadline. Owner decision D4. |
| 5 | **Golden test: reply while a 10-minute task runs.** | tests only | S | Turns a done criterion from inference to verified. |
| 6 | **`start_task` always loaded, elapsed-time context, scenario evals.** | prompt, tool loader, evals | M | Makes (b) happen by model choice. |
| 7 | **Generalised fold / queue / stop** with `owner_message_heard`. Replaces Telegram's auto-steer. | `owner-turn.ts`, `owner-do.ts`, contracts | L | The full (a). Needs 2 and 3 first; additive app.v1 receipt field via the gate. |
| 8 | **Task groups with one merged apply turn;** caps as a budget envelope. | `tasks/`, job book | L | The (c) criterion. Needs persistence review. |
| 9 | **Report routing to the asking surface.** | `drainJobs` | S | Owner decision D3 first. |

## Owner decisions

- **D1.** The iMessage line: was it "the drop doesn't happen on iMessage", or "a second iMessage gets no answer while Waldo works"? If the second, turning progress notes on (`WALDO_IMESSAGE_PROGRESS=1`) is the quick win, and slice 7 the real fix.
- **D2.** Which surface the drop was on. Slice 1 if the app; slices 3–4 if WhatsApp.
- **D3.** Where a background task reports: where the owner asked, or the owner's preferred proactive surface (today).
- **D4.** The WhatsApp turn deadline: raise it to the app's 15 min, or keep it short and rely on hand-off to a task.

## Constraints this design keeps

- **One writer per aggregate.** Each surface's inbox stays the OwnerDO's. No new authority root. Workers stay authority-free.
- **No external I/O inside a SQLite transaction.** Fold, queue and stop decisions commit synchronously; delivery stays in the outboxes.
- **app.v1 additive only.** The gate allocates any revision.
- **Judgment goes to the model.** Deterministic paths cover only the owner's stop control, session revoke and unlink, the run deadline, and spend ceilings.
