# Full-duplex owner turn (async tools): design, 4 Nov 2026

Step 1 of the Super-agent design the owner adopted on 4 Nov (router plus workers, event triggers, full-duplex tools, Inline & Spill, watchdog). This note covers only the full-duplex step: the owner's chat turn stops running long work itself, so Waldo keeps answering while that work runs. Chain of Recall, the watchdog and standing grants are other lanes.

- **Baseline:** `beta-mvp` at `8455b0b96`. `file:line` citations are at that SHA.
- **Tags:** [verified] = read in source at the baseline or observed by a test in this PR. [inference] = concluded, not observed. [proposed] = a choice this note makes.
- **Switches:** `WALDO_ASYNC_TOOLS` ("1" staging, "0" production) and `WALDO_LIGHT_CHAT` ("0" in staging and production: it conflicts with the 27 Oct ruling that owner turns run on Terra, so the owner decides). Both off leave today's behaviour unchanged, byte for byte in the prompt and tool menu.

## What exists today

| Piece | What it does | Evidence |
|---|---|---|
| `start_task` / `cancel_task` | The model writes a job (intent before I/O, keyed `turnId:toolCallId`), the jobs lane starts a worker after the write commits, the tool returns `{status:'started', job_id, title}` at once. This is DeepSeek's `start()` and `stop()`. | [verified] source `tasks/tools.ts:31-88` |
| Worker | Runs in its own Durable Object with the profile's tools only (reader, errand). Every tool call is served by the owner object (`taskHost.tool`), which checks the lease, the profile allowlist, admission and spend. | [verified] source `tasks/brain.ts:150-270`, `tasks/profiles.ts:11-60` |
| Report | The worker's result is stored once; the jobs lane (the single retry owner) runs an apply turn that tells the owner on the surface the task was asked on. Two progress notes for long tasks. | [verified] source `tasks/brain.ts:395-420`, `tasks/lane.ts` |
| Owner turn | Holds every tool, including `browse_page` (10–23 s a call on 10 Oct), `browse_act`, `read_drive` and `delegate_task` (a synchronous research subagent inside the turn). | [verified] source `channels/owner-turn.ts:450, 567`; latency from the 10 Oct baseline [inference, one day's sample] |
| Second message | With `WALDO_SECOND_MESSAGE=1`, each round of a running owner turn shows newer owner messages; the model folds, queues or stops. | [verified] source `channels/second-message.ts` |
| Owner first | With `WALDO_OWNER_FIRST=1`, the alarm pass yields to a waiting owner message before each machine turn. | [verified] source `channels/owner-first.ts` |

So `start()`/`stop()`/report already exist. Two things keep the turn from being full duplex:

1. **The owner turn still runs heavy tools inline.** Nothing stops the model from browsing for 20 s inside the turn, and `delegate_task` runs a whole research loop inside it. A newer owner message waits for all of it (or, with second message on, until the current round, which includes the tool).
2. **A worker's browser step holds the owner's chain.** `serialBrowser` in the owner object is `self.serial(...)` (`owner-do.ts:644`), the same queue owner turns run on (`owner-do.ts:3383`, used by `drainApp` at `:2078`). A worker's 10–23 s browse therefore holds the owner's next message for that long. Without a fix here, moving browsing to workers would move the wait, not remove it. [verified] source

## Design

### 1. The owner turn does not hold long tools [proposed]

A tool record gets a new field, `long`, decided per tool like the others in `tools/records.ts`: its work can outlast one model step. `true` for `browse_page`, `browse_act`, `read_drive` and `delegate_task`; `false` for everything else.

With `WALDO_ASYNC_TOOLS=1`, the owner's own turn (`ownerTurnActive`) drops `long` tools from its menu, beside the existing probe and eligibility filters, and does not add `delegate_task`. The task workers keep them (reader and errand profiles already hold `browse_page`, `read_drive`; errand holds `browse_act`). Machine turns are unchanged.

This is a capability decision about tools, not routing by content: nothing inspects the owner's words or a result's size. Whether a piece of work becomes a task stays the model's call.

**Judgment boundary.** Mail, calendar, contacts, memory, `web_search` and MCP reads stay inline. That includes staging's Drive MCP server (`read_mcp_tool`), so a Drive read through MCP still runs in the turn: they are bounded API calls of about a second. A "long mail" job (a backlog, many threads) is something the model hands to `start_task` because it judges it long; no size rule decides it. The provider-hosted web search inside the reply's model call also stays: it adds seconds, not tens of seconds. [inference] The gate may move `web_search` into the long set if staging traces show otherwise.

**Prompt.** The task section of the behaviour prompt names `browse_page` and `browse_act` in its ladder, its "Looking things up" lines and its video line. With the switch on and `start_task` on the menu, the ladder climbs to "a background task" instead, those lines say a background task reads the page, and a short "Background work" block says: reading pages, Drive files and research run as background tasks; call `start_task` with a brief that carries what the worker needs, say in this reply what you started, and the result reaches the owner as its own message. The switch reaches the prompt as an explicit argument, not by inferring it from a missing `browse_page` (production has no browser binding, so that would turn the block on with the switch off). Switch off is byte-identical: `test/async-tools.test.ts`.

**Trade-off, stated.** With the switch on there is no same-reply research: "what does this page say" gets "I've started reading it" now and the answer as a second message, roughly a worker round later. The first reply is much faster; the full answer is a little slower (worker model calls plus the apply turn). That is the Super-agent trade by design.

**Tool loader.** Staging runs `WALDO_TOOL_LOADER=harness`. Its catalogue is built from the turn's handlers, so a dropped tool is not findable or callable through `use_tool`. The `web` namespace description names `browse_act`; it stays, because machine turns and the switch-off path still hold it. [verified] source `tools/loader.ts:42-80`; a test in this PR pins it.

### 2. A reading task's browser steps get their own lane [built]

With the switch on, `serialBrowser` runs a task's browser step on a browser-only queue (`browserSerial`), not `serial()`, when the task's tools hold no browser action (reader and owner look-up workers: `browse_page` only). The owner browser runtime read the active run through one field (`activeScope`), shared with owner turns, approvals and custody checks. The lane sets a separate `browserScope`, and the runtime reads `browserScope ?? activeScope` for browser custody.

Two places assume one run per owner object:
- **Model calls.** With a browser registration selected, every owner model call goes through the browser host's gateway (`owner-browser-runtime.ts` `gateway()`), which checks the call's run against the host's active run. During a lane step that would close the owner's turn. So the gateway checks the run on the owner's chain (`chainScope`), and browser custody checks the lane's. [verified] The test "while a task's browser step holds the browser lane…" fails without this and passes with it.
- **Cards and effects.** The approval desk and the owner effect ledger file a new card or effect under `activeApp ?? activeScope` (`owner-do.ts` `currentRunRef`). An errand's `browse_act` can raise a browser-submit card. On the lane during an owner turn, that card would be filed under the owner's turn, and `cancel_task` would not withdraw it. So steps that can act on a page (errand workers, approved browser replays) keep the owner's chain, as today. [verified] by test.

Other properties:
- The browser still serves one run at a time. A step that keeps the chain also takes the browser lane inside it (`serial(() => browserSerial(...))`), so it waits for a reading task's step rather than meeting that task's run on the browser. That would fail closed and, for an approved replay, report an action the owner said yes to as "outcome unknown" without it having run. The lane never waits on `serial()`, so this cannot deadlock. [verified] by test.
- An owner turn with the switch on holds no browser tool. If anything else reaches the browser runtime while a lane step runs, its custody check fails closed (`ClosedRunError`), as a mismatched run always does.
- Owner storage erase (app delete, console delete, console account controls) runs on the channel queue and takes its place on the browser lane, so no browser step lands after `deleteAll`: one queued later runs after the erase and finds no job book.
- With the switch off, `serialBrowser` takes today's path, and `chainScope` equals `activeScope`.

**Limits, stated:**
- An errand's browser actions still hold the owner's chain, one step at a time.
- With the switch on, an errand's chain step can also wait, while it holds the chain, for an unrelated reader's page on the lane. An owner message that arrives then waits for both: worse than switch-off for that one case. Chain-then-lane is still the right order, because lane-then-chain would let an erase, which runs on the chain and waits for the lane, deadlock.
- The real-browse test (a reader's `browse_page` holding the lane while an errand's step queues) shows both finish in order, with no deadlock. Lifting that needs cards and effects filed under the calling run instead of a global current run. That is a change to the approval desk and the effect ledger, so it is a follow-up.

### 3. Light chat model, strong workers (`WALDO_LIGHT_CHAT`) [built; switch "0"]

- The owner's own reply takes its **first step** on the provider's auxiliary model (Haiku 5.5 on Anthropic, Luna on OpenAI), with the chat step's own request plus one tool, `escalate`. The light model answers quick, simple chat itself. Anything else hands the turn to the chat model (Sonnet 5.5 / Terra), which takes the same step and writes the turn's one reply. Side jobs are unchanged.
- **The owner's 5 Nov rule:** hard asks, every day plan and every health-aware answer are written by the chat model. Which turns those are is the light model's judgment, stated in the `escalate` description (`channels/async-tools.ts`); no keyword rule decides it. The nightly `lc-` scenarios measure how often it hands over.
- **Capability boundary, not judgment:** the light step is the reply only as plain, whole text. Any tool call (`escalate` or another), a cut-off reply, or a failure discards the step unseen and the chat model takes it. So the light model never runs a tool, raises a card or takes an action, and at most one call per turn is spent before the hand-over.
- The light step streams nothing, has no floor line and no hosted web search, runs one attempt with no fallback and a 30 s bound, and reads the provider breaker without moving it. A failed light step hands over; the chat route keeps its fallback to the other provider's chat model, so an outage never lands on a second light model.
- Task workers run every task on the chat model (Sonnet 5.5 / Terra), not only `effort: 'deep'` ones. Today `standard` effort runs on auxiliary (`tasks/worker-loop.ts:230`). This is a real cost increase per task.
- **This conflicts with the 27 Oct ruling** that owner turns run on Terra. The switch stays "0" in staging and production until the owner decides; the 5 Nov rule is what makes it safe to try.
- Anthropic native prompt caching and the 16k output room follow "is this the chat call" in `ownerRoutePolicy`; the light step (`lightRoutePolicy`) keeps both. Each model keeps its own cache.

### What the owner sees

Every reply still says what was started and what was done. The receipt line already lists `start_task` as "task started"; this PR adds the task's title to that line, so the owner reads "Done: task started Hotel prices for 21–23 Nov". The report comes later as its own message on the same surface, as today.

### Not in this step

- **In-turn pickup of a report.** A task that finishes while the owner's turn is still running is reported by the follow-up apply turn, not folded into the running turn. Router turns are now short, so this is rare, and pickup would race the jobs lane, the single retry owner. [proposed] Later step.
- **Machine turns that browse.** A machine turn's own `browse_page`/`browse_act` runs on the chain, and while a reader's step holds the lane its custody check fails closed (the tool returns a refusal; nothing runs). [inference from source; not tested]
- **Owner login inside a worker.** A worker cannot resume an owner browser login within its own job; the errand stops and the report asks the owner.
- **Untested here:** an errand's browser card raised with the switch on and then withdrawn by `cancel_task`. Errand steps keep the chain with the job's run, which is the path `task-worker-owner-do.test.ts` covers with the switch off.
- **Report and machine turns.** They run on the chain without the switch's menu. A task report's apply turn holds every owner tool except `start_task` and `cancel_task`, so it can still browse inline. It is short and runs after the work, but it holds the chain while it browses.
- **Errand browser actions off the chain.** These need cards and effects filed under the calling run (see section 2).
- **Speculative work, thread subscriptions, router batching.** Other Super-agent steps.
- **Dependency.** "A new owner message is handled as soon as the current inference step ends" needs `WALDO_SECOND_MESSAGE=1` (and `WALDO_OWNER_FIRST=1` for machine work). Both are "0" in `wrangler.jsonc` today; the 4 Nov owner ruling turns them on in the bundled deploy. Without second message, a newer message waits for the whole (now short) turn.

## Invariants kept

- One writer: the owner object writes every job row; workers write nothing outside it. No second brain.
- Intent before I/O: a job is written before any worker runs; a worker's effect step writes its intent before the call.
- No external I/O inside a SQLite transaction: the new lane only reorders who waits for whom.
- One retry owner: the jobs lane. Nothing here retries.
- Cancellation fencing: `cancel_task` fences the attempt's scope; the browser lane's work runs under that scope and stops at its next `admit()`.
- Honest receipts: "started" is never "done"; the report says what the worker established.

## Tests

All in `test/async-tools-owner-do.test.ts` (owner object, real app chain, tool loop, task host, worker loop and jobs lane; scripted model and browser vendor) and `test/async-tools.test.ts`.

- **Trace assertion** (owner object, real tool loop, scripted gateway): the owner's turn calls `start_task` and returns its reply, which names the task, while the worker's browse is held open; the worker then finishes and the apply turn delivers the report. The trace order is asserted.
- **Concurrent message:** with a reader worker's `browse_page` held open, a second owner message gets its reply before the browse resolves. With the switch off (any worker), or on for an errand worker, the same message waits for the step: the baseline and the narrowed lane.
- **One run on the browser:** an errand's step waits for a reading task's lane step, then runs.
- **Cancel on the lane:** `cancel_task` in an owner turn while a reader's page loads cancels the job at once; the attempt is fenced when the page returns, nothing is reported, and the lane frees.
- **Receipts:** a refused `start_task` (a title with a health value) names nothing in the line or the typed receipt; an accepted one names its title.
- **Gateway:** with a browser registration selected and the lane held by a task's run, the owner's turn answers through the browser host's gateway.
- **Menu:** switch on, the owner turn's menu has no `long` tool and no `delegate_task`, through the harness loader too; machine turns and workers keep theirs. Switch off, menu and prompt are byte-identical to the baseline.
- **Models:** switch on, the reply runs on the auxiliary model with the chat model as its fallback, and a `standard` task runs on the chat model.

## Measurement

Time to first reply = owner app message admitted → its reply in the chat (the receipt reads `completed`). This is not a model call's `ttft_ms`.

**Simulated, on the real owner pipeline** [verified as a measurement of this harness; inference for real latency]:
- **Harness:** `test/async-tools-owner-do.test.ts`, "time to first reply". The model and the page load are the only fakes.
- **Scale:** 1:100. A model call is 60 ms (the 10 Oct median, 6 s). A page is 150 ms (about 15 s), and the page held for the second-message case is 600 ms.
- **Before (off):** the owner's turn does the page itself (inline `delegate_task`, whose call takes a page's time).
- **After (on):** the turn starts a task.
- Three runs, in ms:

| Metric | Switch off | Switch on |
|---|---|---|
| 8 asks (4 need a page), p50 | 107–111 | 111–117 |
| 8 asks, p95 | 458–460 | 196–217 |
| Second message while a page loads, p50 | 1510–1514 | 120–158 |
| Second message while a page loads, p95 | 1516–1571 | 187–202 |

**Reading:**
- An ask that needs a page now gets its first reply after two model calls, not two model calls plus the page.
- A newer message no longer waits for the page. With the switch off, the app chain holds it behind the whole running turn.
- p50 barely moves, because half the asks need no page.
- Harness overhead (tens of ms) does not scale with the model, so multiplying by 100 overstates both columns. Read the ratios, not ×100.

**Not measured:**
- `WALDO_LIGHT_CHAT` latency: a fake model has no speed difference. After a deploy with the switch on, read `light_route` (outcome and the light step's ms) and `llm_reply_light` beside `llm_reply`.
- Staging and Langfuse p50/p95: NOT RUN, because there are no credentials here. After the bundled deploy, read them from the `llm_reply` and app receipt hops, together with the delegation rate (owner turns that call `start_task`).

## Rollback

Set `WALDO_ASYNC_TOOLS` and `WALDO_LIGHT_CHAT` to "0". No migration, no new table, no contract change.
