# Full-duplex owner turn (async tools): design, 4 Nov 2026

Step 1 of the Super-agent design the owner adopted on 4 Nov (router plus workers, event triggers, full-duplex tools, Inline & Spill, watchdog). This note covers only the full-duplex step: the owner's chat turn stops running long work itself, so Waldo keeps answering while that work runs. Chain of Recall, the watchdog and standing grants are other lanes.

- **Baseline:** `beta-mvp` at `8455b0b96`. `file:line` citations are at that SHA.
- **Tags:** [verified] = read in source at the baseline or observed by a test in this PR. [inference] = concluded, not observed. [proposed] = a choice this note makes.
- **Switches:** `WALDO_ASYNC_TOOLS` ("1" staging, "0" production) and `WALDO_LIGHT_CHAT` ("1" staging under the 4 Nov standing rule, "0" production). Both off leave today's behaviour unchanged, byte for byte in the prompt and tool menu.

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

**Judgment boundary.** Mail, calendar, contacts, memory, `web_search` and MCP reads stay inline: they are bounded API calls of about a second. A "long mail" job (a backlog, many threads) is something the model hands to `start_task` because it judges it long; no size rule decides it. The provider-hosted web search inside the reply's model call also stays: it adds seconds, not tens of seconds. [inference] The gate may move `web_search` into the long set if staging traces show otherwise.

**Prompt.** The task section of the behaviour prompt names `browse_page` and `browse_act` in its ladder. When the menu has `start_task` but no `browse_page`, that section says instead: reading pages, Drive files and research run as background tasks; call `start_task` with a brief that carries what the worker needs, tell the owner in this reply what you started, and the result arrives as its own message. The section is derived from the tool names, as `web_search` already is (`prompt/messaging-behavior.ts:144`), so switch-off is byte-identical.

**Trade-off, stated.** With the switch on there is no same-reply research: "what does this page say" gets "I've started reading it" now and the answer as a second message, roughly a worker round later. The first reply is much faster; the full answer is a little slower (worker model calls plus the apply turn). That is the Super-agent trade by design.

**Tool loader.** Staging runs `WALDO_TOOL_LOADER=harness`. Its catalogue is built from the turn's handlers, so a dropped tool is not findable or callable through `use_tool`. The `web` namespace description names `browse_act`; it stays, because machine turns and the switch-off path still hold it. [verified] source `tools/loader.ts:42-80`; a test in this PR pins it.

### 2. Worker browser steps get their own lane [proposed]

With the switch on, `serialBrowser` runs on a browser-only queue, not `serial()`. The owner browser runtime reads the active scope through one field today (`activeScope`, shared with owner turns, approvals and custody checks). The lane sets a separate `browserScope`, and the runtime reads `browserScope ?? activeScope`.

- The browser still serves one scope at a time: every worker browse and every approved browser replay goes through the one lane.
- An owner turn with the switch on holds no browser tool. If anything in an owner turn reaches the browser runtime while a worker browses, the scope check fails closed (`ClosedRunError`), exactly as a mismatched scope does today.
- Owner storage erase already waits on `channelQueue`; it also waits on the browser lane, so no browser write lands after `deleteAll`.
- Switch off: `serialBrowser` is today's code path.

### 3. Light chat model, strong workers (`WALDO_LIGHT_CHAT`) [proposed]

- The owner's own reply runs on the provider's auxiliary model (Haiku 5.5 on Anthropic, Luna on OpenAI). The fallback stays the other provider's chat model, so an outage does not drop quality twice. Side jobs are unchanged.
- Task workers run every task on the chat model (Sonnet 5.5 / Terra), not only `effort: 'deep'` ones. Today `standard` effort runs on auxiliary (`tasks/worker-loop.ts:230`). This is a real cost increase per task.
- **This conflicts with the 27 Oct ruling** that owner turns run on Terra. The 4 Nov adoption of the Super-agent design asks for a lighter router; the switch keeps both reachable and the gate decides staging. A light router may delegate less well: the eval reports delegation rate, not only latency.
- Anthropic native prompt caching and the 16k output room follow "is this the chat call" in `ownerRoutePolicy`; the light reply keeps both.

### What the owner sees

Every reply still says what was started and what was done. The receipt line already lists `start_task` as "task started"; this PR adds the task's title to that line, so the owner reads "Done: task started Hotel prices for 21–23 Nov". The report comes later as its own message on the same surface, as today.

### Not in this step

- **In-turn pickup of a report.** A task that finishes while the owner's turn is still running is reported by the follow-up apply turn, not folded into the running turn. Router turns are now short, so this is rare, and pickup would race the jobs lane, the single retry owner. [proposed] Later step.
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

- **Trace assertion** (owner object, real tool loop, scripted gateway): the owner's turn calls `start_task` and returns its reply, which names the task, while the worker's browse is held open; the worker then finishes and the apply turn delivers the report. The trace order is asserted.
- **Concurrent message:** with a worker's `browse_page` held open, a second owner message gets its reply before the browse resolves.
- **Menu:** switch on, the owner turn's menu has no `long` tool and no `delegate_task`, through the harness loader too; machine turns and workers keep theirs. Switch off, menu and prompt are byte-identical to the baseline.
- **Models:** switch on, the reply runs on the auxiliary model with the chat model as its fallback, and a `standard` task runs on the chat model.

## Measurement

Time to first reply = owner message admitted → first reply delivered (not a model call's `ttft_ms`).

- **Simulated** [inference for real latency]: the scripted-gateway world with fixed delays, 6 s per model call (10 Oct median), 15 s per browse, before and after, p50 and p95 over a fixed set of asks. Reported in the PR.
- **Staging / Langfuse p50 and p95:** NOT RUN here (no credentials). After the bundled deploy, the gate or the eval lane reads it from `llm_reply` and delivery hops.

## Rollback

Set `WALDO_ASYNC_TOOLS` and `WALDO_LIGHT_CHAT` to "0". No migration, no new table, no contract change.
