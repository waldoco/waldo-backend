# Second message while Waldo works: findings and design, 31 Oct 2026

Design only. This document and its characterising tests change no runtime code, flag, deploy or migration. It is a candidate: the owner approves it before any slice is built, and each slice is then built under its own issue and gate review.

- **Baseline:** `beta-mvp` at `fe3d73ae5` (merge of #1753). Backend `file:line` citations are at that SHA. App citations are `waldo-app` `origin/main` at `b8432541`.
- **Tags:** [verified] means a test in this PR observed it, or I read it in source at the baseline (marked "source"). [inference] means concluded but not observed. [proposed] is a design choice this document puts forward.
- **Photon host:** `waldoco/waldo-imessage-host` branch `ashish/photon-rich` at `25217b16`, the branch that adds Photon replies. Which host build runs on staging is not observed.
- **Tests (this PR):** `packages/runtime/test/second-message-app.test.ts`, `imessage-second-message.test.ts`, `whatsapp-second-message-owner-do.test.ts`, `telegram-second-message-steer.test.ts`. They pin today's behaviour; they are not the target.

## The owner's report

"If I send two messages in a row while Waldo is working, Waldo drops the first task and works on the new one. On iMessage it doesn't happen at all."

### Owner rulings, 31 Oct (relayed by the gate)

The owner said: "imessages but ideally, it should be regardless of the surface, right where the world is, where you are interacting with the world."

- **The principle (constraint 0):** one second-message behaviour on every surface (app, iMessage, WhatsApp, console). Replies go where the owner is talking.
- **D2:** the drop was seen on iMessage.
- **D1:** settled by D2.
- **D3:** a background task reports on the surface where it was asked.
- **D4:** surface parity. WhatsApp gets the app's deadline plus progress notes, not a special short one. [inference: the gate read this from "regardless of the surface", pending the owner's confirmation]

## What happens today, per surface

The owner sends B while A's turn is running.

| Surface | What happens to B | What happens to A | Is a reply lost? | Evidence |
|---|---|---|---|---|
| App, backend | Durably admitted; runs as its own turn after A. B's model input holds A's ask and A's reply. | Untouched. | No. Each message gets its own reply, hung under it. | [verified] `second-message-app.test.ts` |
| App, iOS client | **Cannot be sent.** While A is accepted, the composer's button is Stop, even with text typed. Tapping where Send was cancels A. | Cancelled by that tap ("You stopped this one."). | A's reply is never written. | [verified] source: `Composer.tsx` (`onStop ? Stop : Send`), `ChatPane.tsx:298`, `useChat.ts:129,137`, `mainChatController.ts:110` |
| Console | Admitted on the app inbox (the console proxies to the app send path) and queued like the app. The console UI shows Send whenever text is typed. | Untouched. | No. | [verified] source: `console-chat.ts:59`, `dashboard-app/src/Chat.tsx:236-238`; backend half is the app test |
| iMessage | Durably admitted; runs as its own turn after A. | Untouched. But because B came in first, A's reply is frozen to thread onto A's message (`imessage/final-outbox.ts:108`). It goes out threaded when the host reports verified replies (`imessage/bridge-do.ts:273`). | Not with a plain host: both replies go out, A first. **With a host that reports replies and then refuses the threaded send, A's reply is lost for good.** The outbox keeps the first terminal result (`final-outbox.ts:169`) and never resends it plain. B's plain reply goes out. | [verified] `imessage-second-message.test.ts`, both cases |
| WhatsApp | Meta gets its 200 at once. B waits as an in-memory promise behind A on `serial()`; the pending record holds message ids only. | Untouched, unless A outlives the 150 s WhatsApp turn deadline. Then A is closed with the partial notice and no reply, and B runs. | A's reply, when A runs past 150 s. A queued B on eviction: it is never replayed and gets the same "may have only partly handled" notice, though it never started. | [verified] `whatsapp-second-message-owner-do.test.ts`; eviction path [verified] source `owner-do.ts:2268` |
| Telegram (internal) | Steered into A by a fixed rule: any non-command text while a run is live becomes a steer (`owner-do.ts:802`). | Usually folded: B reaches A's next round as "[While you were working, the owner added: …]". **But if B lands while A's round is building its context, A's run throws `ClosedRunError`.** The owner DO then closes A as uncertain and B runs as its own turn. | A's reply, in that race. | [verified] `telegram-second-message-steer.test.ts` (responder half); owner-DO half [verified] source `owner-do.ts:899-924` and `owner-do-ingress-isolation.test.ts` ("late steering to a closed target becomes one ordinary FIFO turn") |

Steer exists only on Telegram [verified]. `steerTarget`, `bindTarget` and `durableConsume` are only called on the Telegram runtime (`owner-do.ts:831`, `:876-884`). Every other surface has a `turnControl` that nothing feeds.

No surface lets a new message abort the running turn [verified]: the only abort a new message triggers is the app's compaction job (`owner-do.ts:1947`, `:1953`).

### Which path produces "drops the first task"

The owner saw it on iMessage (D2). Ranked by fit:

1. **iMessage: a refused threaded reply loses A** [verified backend mechanism; host trigger is inference].
   - Threading happens only when the owner wrote again before Waldo answered. That is exactly "two messages in a row".
   - The Photon host sends a threaded reply by first resolving the target message at Photon: `space.getMessage(guid)` in `src/photon/spectrum.ts`. A failed lookup throws `PhotonTargetUnavailable`, which the host reports as `rejected` / `not_started` / `photon_target_unavailable` (`src/photon/transport.ts`, `classifySendError`).
   - The backend settles that result as final and never retries plain. The owner sees B answered and A silently gone.
   - The same loss follows from any other refusal of the threaded send: `capability_unverified` when the host's fresh probe no longer verifies `replies`, or `photon_unsupported`.
   - *Falsifier:* on staging, A's bridge delivery shows a `local_recorded` result, or the host reports `replies` unverified, so A went out plain.
2. **iMessage: A interrupted, then B answered** [verified mechanism, generic].
   - A turn that dies (its 15 min deadline, an eviction, a deploy that resets the object, or a model or tool failure) gets the "did not finish" notice. B then runs.
   - With `WALDO_IMESSAGE_PROGRESS=0` on staging (`wrangler.jsonc:109`), A is silent until then. That can read as "dropped".
   - *Falsifier:* A's inbox row is `completed`, not `interrupted`.
3. **iMessage inbound lost before admission** [inference].
   - The Photon host rebuilds its Spectrum stream on error, with backoff (`spectrum.ts`).
   - A message sent during a gap reaches the host only if Spectrum redelivers it. The host dedupes by message id (`inbox.ts`, `INSERT OR IGNORE`).
   - This would drop either message, not specifically the first.
   - *Falsifier:* both messages are in the host inbox.
4. **Elsewhere, the same symptom from other mechanisms:**
   - The iOS app's Stop sits where Send was [verified source].
   - WhatsApp's 150 s deadline [verified].
   - Telegram's context-build race [verified].

The backend never drops A because B arrived, on the app, console or iMessage. On iMessage it can lose A's reply because B arrived [verified].

**Staging evidence that would settle it** (read-only; the gate fetches it):
- The `IMessageBridgeDO` `deliveries` rows for the owner around the report: `reply_ref`, `state`, the result `state` and `reason`. Look for `photon_target_unavailable`, `capability_unverified` or `photon_unsupported` on a `reply:imsg-…` whose next turn's reply went `local_recorded`.
- The bridge's stored capability report: is `replies` sent and verified?
- The owner object's `IMessageFinalOutbox` records (`replyTo` set or not, result) and `IMessageOwnerInbox` states.
- Host logs (`photon_stream_error`, `delivery_held_*`) and the host build staging runs (`ashish/photon-rich` or older).

## Design

### Constraint 0: one behaviour on every surface

The owner's ruling: what happens to a second message, how long a turn may run, how progress is shown, what an interrupted turn says, and where a background task reports are the same on the app, iMessage, WhatsApp and the console. The model, the inbox seam and the receipts are surface-neutral. Only a surface's transport differs: threading, buttons, windows. Replies go to the surface the owner is talking on. Every slice below is checked against this, and a slice that fixes one surface ships the shared seam, not a surface patch.

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
- Separately, the WhatsApp 150 s turn deadline is a leftover from the polling era (W0 hardening, `96c768347`). WhatsApp replies are asynchronous like the app's, so it gets the same 15 min deadline, progress notes and hand-off (D4, decided).

Report routing [verified source]: a task's report goes to the owner's first proactive surface for that alarm pass (`owner-do.ts:2811-2840`, `drainJobs` at `:3121`). It does not go to the surface the owner asked on. A task started on iMessage can report in the app. D3 is decided: the report goes where the task was asked. [proposed] The job row already records `surface` (and the app thread). The jobs lane delivers on that surface's outbox, falling back to the proactive surface only when that one can no longer deliver (unlinked, or WhatsApp's window closed with no template).

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
| iMessage, host refuses A's threaded reply | Nothing. The reply is settled `rejected` and the owner is never told. | **No.** A silent loss [verified test]. A `not_started` refusal is safe to resend plain under a new command id. |
| Any surface, model chooses `stop_current` | n/a | [proposed] below |

[proposed] Every interrupted-turn receipt says three things:
- Which message: its time, and a short quote where the surface allows. The quote is the owner's own text, so it is no new egress.
- Whether that message started.
- What already landed: the receipt line the app's notice already carries.

A folded B closes as "answered in the reply to <A>". On the app this is an additive app.v1 receipt field or `closed_reason` value. The gate allocates the revision, and the app lane hears before any new enum value ships.

## Reuse vs build: what Cloudflare already ships

The owner asked for this section, through the gate. Sources were read on 2026-10-31:

- npm `agents@0.32.0`, `@cloudflare/ai-chat@0.12.2` and `@cloudflare/think@0.23.0`, from the shipped `dist/` and `docs/` on unpkg.
- developers.cloudflare.com and blog.cloudflare.com.

Quotes are verbatim and short. GitHub `main` was not read, so unreleased changes are not covered. No spike was run (see "Spikes" below).

### 1. Agents SDK `subAgent()` and an `Agent` base for `OwnerDO`

What the sources say:
- **Experimental and already deprecated in the released package.** `dist/agent-routing-*.d.ts` marks `subAgent`, `abortSubAgent` and `deleteSubAgent` "@experimental The API surface may change before stabilizing" and "@deprecated Use … this.dynamicAgents.get() instead". The docs page does not say this, so docs and source disagree.
- **Peers are not facets.** The same file says: "For independent peers such as one-DO-per-chat, use `getAgentByName` instead."
- **Where facets run.** The docs (`agents/agent-class/sub-agents`) say: "Child agents are created as facets of the parent — they share the same machine but have fully isolated SQLite storage." The d.ts adds: "Facets run in separate colocated isolates".
- **Storage is shared with the parent.** "The supervisor's database and the facet's database are stored together as part of the same overall Durable Object" (`dynamic-workers/usage/durable-object-facets`).
- **Alarms belong to the parent.** "The top-level parent still owns the physical Durable Object alarm because facets do not have independent alarm slots."
- **`Agent` takes over `fetch()` and `alarm()`.**
  - The layering is "DurableObject > Server > Agent", and `Server` "already implements `fetch`".
  - The Lifecycle docs say: "Do not call `ctx.storage.setAlarm()` on an object that uses the Lifecycle."
  - They also say: "If your class keeps its own `fetch()` or `alarm()`, those run instead, and the Lifecycle never starts."
- **Startup needs a name.** "Startup fails for an object that has no name. This happens with IDs from `newUniqueId()` or `idFromString()`."

What converting `OwnerDO` to extend `Agent` would break [inference from the sources above plus our source]:

- **The alarm.** `OwnerDO` multiplexes about 23 due keys and its own retry and backoff onto the one physical alarm (`scheduler/alarm-slot.ts`, `owner-do.ts:2771`). The Lifecycle wants that slot. We either keep our `alarm()`, which turns off schedules, fibers and facet alarm routing (so we gain nothing), or we port every lane to `schedule()`. Porting rewrites the hottest, most-tested code in the owner's single-writer root.
- **Waking from a worker.** `TaskWorkerDO` reaches the owner through `OWNER_DO.idFromString(...)` (`tasks/worker-do.ts:45`). Under the Lifecycle, a cold start from that path can fail.
- **`fetch()`.** It is one long route table (app, console, WhatsApp, Telegram, OAuth, iMessage RPC). `Server`'s `fetch` would sit in front of it.
- **SQLite and KV.** The SDK adds `cf_agents_*` tables and `cf_agents:*` KV keys. Nothing in `src/` uses that prefix, so nothing collides today [verified: no `cf_agents` matches].
- **DO migration.** A base-class swap probably needs no new migration entry, because migrations track class names [inference: no doc covers it].

Does a same-machine facet keep "a crash or 128 MB overrun kills one worker, not the owner's turn"?
- **Docs: unanswered.** "Separate colocated isolates" suggests memory is isolated. Nothing says a child's OOM never resets the parent, or that each facet gets its own 128 MB.
- **Today: yes, structurally.** `TaskWorkerDO` is a separate namespace, so it is a separate object and isolate. It has its own alarm in 10-minute slices, and its storage is deleted when it ends.

What the SDK would replace in the job protocol, and what stays ours:
- **The SDK would replace** the worker's alarm slicing and re-arm, and its start/abort/delete lifecycle (`abortSubAgent`, `deleteSubAgent`). That is about the 62 lines of `worker-do.ts`.
- **What stays ours,** because it is the authority boundary, not plumbing:
  - The job row written before I/O.
  - Lease tokens and the fence.
  - Apply-once reports.
  - The rule that every tool call runs on the owner through `taskTool` (`tasks/brain.ts`).
  - The one retry owner.

  The SDK has no concept of these.

**Recommendation: do not adopt, for now.**
- Converting `OwnerDO` puts the single-writer root's alarm and fetch under a 0.x framework, to save very little.
- Moving `TaskWorkerDO` to facets saves about 62 lines, takes an experimental, already-deprecated API, makes the owner's alarm the worker's alarm, and leaves crash isolation unproven.
- Revisit when `dynamicAgents` is stable and Cloudflare documents facet failure isolation.

### 2. Concurrency in `AIChatAgent` and Think: second message during a turn

- **Queue by default; A is never aborted by a new message.** `ai-chat` `index.d.ts`: "`"queue"` (default) — queue every submit and process them in order."
- **The alternatives are fixed per class, not per message.** The same file lists `"latest"`, `"merge"`, `"drop"` and `{ strategy: "debounce" }`.
- **`merge` joins waiting messages only.** It joins trailing user messages "into one combined user turn before the latest queued turn runs". It never reaches into the running turn.
- **Order: persist B, then queue.** `persistMessages` runs before `_runExclusiveChatTurn`. `TurnQueue` is an in-memory promise chain (`agents/dist/chat/index.js`), the same shape as our `serial()`.
- **Stopping A is a client action.** It happens on a `chat-request-cancel` message (`this._abortRegistry.cancel(event.id)`).
- **No steer anywhere.** "steer" appears zero times in `ai-chat` 0.12.2 or `agents/chat` 0.32.0. Think 0.23.0 uses the same `messageConcurrency`.
- **Project Think** (https://blog.cloudflare.com/project-think/, 15 Apr 2026):
  - It says "Project Think is experimental" and "The features described in this post are in preview".
  - For input mid-run it lists only abort/cancel.
  - What it adds is durability: a fiber is "registered in SQLite before execution begins, checkpointable at any point via stash()".

**Recommendation: build (a) ourselves.** Nothing shipped lets the model fold B into a running turn. Cloudflare's design is a fixed admission policy plus a client cancel, which is our app path today.

Two things to borrow, not import:
- The policy vocabulary: queue, latest, merge, drop.
- Their "persist first, then queue" order, which our app and iMessage inboxes already follow and which WhatsApp lacks (slice 6).

### 3. Workflows for long tasks

What the sources say:
- **GA.** "Workflows is now *Generally Available*" (changelog, 2025-04-07).
- **Callable from a plain Durable Object.** "Within a Durable Object" is a listed trigger. `create`, `get`, `status` and `sendEvent` are plain binding calls, so the DO's base class stays as it is.
- **The Agent wrapper is not plain-DO compatible.** `AgentWorkflow` requires an `Agent`: "AgentWorkflow requires __agentName, __agentBinding, and __workflowName".
- **Steps and limits** (Workers Paid):
  - `step.do` takes `retries` and `timeout`.
  - Steps: "10,000 default, configurable up to 25,000".
  - Wall clock per step: "Unlimited". CPU per step: 30 s, "configurable to 5 minutes".
  - "1MiB" per step result or event. Instance state: 1 GB.
  - `waitForEvent` defaults to "24 hours".
- **Docs that conflict.** The Agents `run-workflows` page says "10 MB per workflow" and "30 minutes per step". Retention dropped to "seven days by default" for instances created from 2026-09-10.
- **Idempotent creation.** A duplicate `create()` id "Throws an error if the provided ID is already used", so a job-keyed instance id is idempotent.

**Fit [inference]:**
- A task group (slice 10) maps naturally onto one Workflow: one `step.do` per member brief, run in parallel, then a merge step. That is the "four workers, one merged brief" criterion, without the job book holding the apply turn.
- Each member's tool calls must still go to the owner's `taskTool` RPC, inside a step, so the lease and fence stay ours.
- Step retries must be `limit: 0`, or keyed by the job's attempt, or Workflows becomes a second retry owner.
- A long single task gains little over `TaskWorkerDO`, which already slices and checkpoints.

**Recommendation: spike Workflows for slice 10 only, before building task groups on the job book.** It needs `wrangler.jsonc` workflow bindings, not the `agents` dependency. The spike runs on a scratch branch.

### 4. Everything else

| Shipped piece | What it would remove | Verdict |
|---|---|---|
| Agents `schedule()` (cron, delay; "stored in SQLite and run from the Lifecycle's job queue") | Our scheduler lanes | No. It needs the `Agent` base and owns the alarm (item 1). |
| Fibers (`runFiber`, `stash`) | Our durable inbox rows and recovery notices | No. They need the Lifecycle, and "The original closure cannot be replayed automatically", "No automatic retries". Our admitted, running, interrupted rows already give the same guarantee with honest receipts. |
| Durable Object alarms ("a single alarm at a time"; at-least-once, "up to 6 retries") | n/a | This constraint is why we multiplex. It stays. |
| Browser Run session reuse (`keep_alive` "up to 20 minutes"; `connect()`; DO-held sessions) | Browser session plumbing | Already used: `keep_alive` and `sdk.connect` in `cloudflare-browser-adapter.ts:55` and `cloudflare-general-browser.ts:167`. Nothing more to remove. |

### Ranking

| Option | User value | Effort | Risk to the single-writer root | Call |
|---|---|---|---|---|
| Workflows for task groups (slice 10) | High: the merged-brief criterion | M | Low: authority stays in `OwnerDO` through RPC | Spike, then decide |
| Borrow `messageConcurrency` vocabulary and persist-first order | Medium | S | None | Adopt as design input |
| Facets / `dynamicAgents` for task workers | Low: about 62 lines saved | M | Medium: the owner's alarm becomes the worker's alarm; isolation unproven | Not now |
| `OwnerDO` extends `Agent` (schedules, fibers, `schedule()`) | Low | XL | High: alarm and fetch takeover of the root | Reject |

### Spikes

None run. The questions the docs leave open are not ones a local spike can settle:

- **Facet out-of-memory isolation** needs production isolate limits; workerd locally does not enforce 128 MB the same way [inference].
- **Whether our `compatibility_date` (2026-06-16) exposes `ctx.facets`** only matters if we adopt facets, which this section does not recommend.
- **The Workflows task-group spike** is proposed above. It is to run on a scratch branch, with workflow bindings only. Adding the `agents` dependency to beta-mvp needs the owner's explicit yes, and nothing here asks for it.

## Ranked build plan

Each slice is its own issue, PR and gate review. Re-ranked after the owner's rulings: the iMessage mechanism leads, and every slice is built as the shared seam (constraint 0).

| # | Slice | Where | Size | Why this rank |
|---|---|---|---|---|
| 1 | **iMessage: a refused threaded reply goes out plain.** When the host settles a threaded reply `rejected` / `not_started`, the outbox re-freezes the same text unthreaded under a derived command id, so the host's journal sees a new command. A threaded reply that is `unknown` / `may_have_completed` is not resent. That stays an honest uncertainty, and the owner is told. `imessage-second-message.test.ts` case 2 flips to "both answers reach the owner". | `imessage/final-outbox.ts` (`settle`), `imessage/owner-runtime.ts` | S | The owner's reported surface; verified silent loss. No `owner-do.ts` edit. |
| 2 | **Photon host: resolve reply targets reliably, or report `replies` unverified.** Check `space.getMessage` against the ids the stream delivers, including part ids. Until verified, the probe stops reporting `replies`, and the backend then threads nothing. | `waldo-imessage-host` (host lane) | S | Removes the trigger at the source. Slice 1 still guards every host. |
| 3 | **Progress notes on, every surface (D4 parity).** Turn on iMessage progress notes (`WALDO_IMESSAGE_PROGRESS`, a flag flip that needs its own go) and give WhatsApp the same pacer and the app's 15 min deadline. | flag; WhatsApp turn wiring | S–M | A long A is never silent anywhere. The WhatsApp half touches `owner-do.ts`, after the day-awareness lane. |
| 4 | **Steer race: rebuild, don't close.** `telegram-second-message-steer.test.ts` case 2 flips to "A answers both". | `owner-turn.ts` | S | Must land before steer reaches any other surface (slice 7). |
| 5 | **App composer: Send when text is typed, per-message slots.** Golden test: send B during A, both answered. | waldo-app (Suyash's lane) | S | The app's way to lose A. The backend already queues. |
| 6 | **WhatsApp honesty and durability.** Per-message inbox rows; an unstarted B gets the unstarted notice; notices name the message. | `owner-do.ts`, WhatsApp inbox | M | Verified dishonest receipts. After the day-awareness lane. |
| 7 | **One fold / queue / stop seam on every surface,** with `owner_message_heard`. Replaces Telegram's auto-steer. Interrupted-turn receipts name the message, say whether it started, and list what landed. | `owner-turn.ts`, `owner-do.ts`, contracts | L | The full (a) and (d), surface-neutral. Needs 1, 4 and 6 first. The app.v1 receipt field is additive, through the gate. |
| 8 | **Task reports on the asking surface (D3)** and the golden test "owner gets a reply while a 10-minute task runs", on iMessage and the app. | `drainJobs`, `tasks/lane.ts`, tests | S–M | Decided. Its `owner-do.ts` part follows the day-awareness lane. |
| 9 | **`start_task` always loaded, elapsed-time context, scenario evals.** | prompt, tool loader, evals | M | Makes (b) happen by the model's choice. |
| 10 | **Task groups with one merged brief;** caps as a budget envelope. Spike Workflows first (Reuse vs build §3); fall back to job-book groups. | `tasks/`, job book or a Workflow binding | L | The (c) criterion. Needs persistence or binding review. |

### Slice 2, ready to file for the host lane (`waldoco/waldo-imessage-host`)

**Title:** Photon: a threaded reply whose target cannot be resolved is refused, so Waldo's answer is lost.

**Where:** branch `ashish/photon-rich` at `25217b16`.
- `src/photon/spectrum.ts:137-140`: `target()` resolves the reply target with `space.getMessage(partIndex ? \`p:${partIndex}/${guid}\` : guid)`. If that throws or finds nothing, it throws `PhotonTargetUnavailable` before any send.
- `src/photon/transport.ts:35` classifies that as refused (`photon_target_unavailable`).
- `src/photon/sender.ts:49` needs `replies` verified for any command with a target message.
- The id the backend targets is the one the host forwarded inbound: `src/photon/reader.ts:26`, `messageGuid: row.messageId, partIndex: 0`.

**What happens:** when the owner sends two messages before Waldo answers, the backend threads the first reply onto the first message. The host refuses that send. Until backend slice 1 lands, the backend settles the reply as lost.

**Expected host behaviour:**
1. Prove that `space.getMessage` resolves the stream's own inbound message ids, for messages older than a few minutes too. Add a test with a real Spectrum id shape.
2. If the target cannot be resolved, refuse as today (`not_started`, nothing sent). The backend will resend plain after slice 1. Never send unthreaded on its own: the backend owns the retry.
3. Report `replies` as verified only while (1) holds, so a host that cannot resolve targets makes the backend send plain from the start.

**Evidence wanted from the live host:** the count of `photon_target_unavailable` results, and whether the host reports `replies` as verified.

## Owner decisions

D1–D4 are decided (see "Owner rulings, 31 Oct"). Still open:

- **D4 confirmation.** Parity for WhatsApp was read from "regardless of the surface". The gate confirms it with the owner before slice 3's WhatsApp half.
- **The progress-notes flag (slice 3).** `WALDO_IMESSAGE_PROGRESS=1` on staging is a flag change. It needs its own go and is not part of this PR.

## Constraints this design keeps

- **One writer per aggregate.** Each surface's inbox stays the OwnerDO's. No new authority root. Workers stay authority-free.
- **No external I/O inside a SQLite transaction.** Fold, queue and stop decisions commit synchronously; delivery stays in the outboxes.
- **app.v1 additive only.** The gate allocates any revision.
- **Judgment goes to the model.** Deterministic paths cover only the owner's stop control, session revoke and unlink, the run deadline, and spend ceilings.
