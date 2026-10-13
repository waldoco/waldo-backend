# Harness practice references for Waldo's open decisions

> **Orchestrator review, 13 Oct 2026, 21:06Z.** This note was written to meet the owner's bar from 20:39Z (digest item 35): no rash decisions, and mature practice checked for every ambiguous point. Lanes cite it in a PR's "Prior art" section, and must still read the primary source themselves.
> - **Spot-checked against `beta-mvp` `9440ec6a`:**
>   - `llm/provider.ts:443-457`: every gateway failure except `invalid_args` moves on to the next plan step and counts toward the breaker.
>   - `tools/live/browser.ts:113-139`: `auth_failed` means Waldo's own browser is not configured or its key was rejected.
>   - `conversation/tool-loop.ts`: dedupe uses name plus arguments, and the calls in one response run one after another.
> - **Line numbers** below are from the runtime at `4bb040f5`, the docs branch's base. On the tip, `channels/owner-turn.ts` and `conversation/tool-loop.ts` have since changed (132 and 31 lines), so search for the code in those two files. The other cited files are unchanged.
> - **Already settled, so no new owner call is needed:**
>   - B2's spec under the approved ADR #1182 takes health policy (a): a summary may carry the owner's qualitative health, numbers are instructed out, and the Scribe checks it.
>   - B3's pinned blocks are views over existing claims, not copies, so the claims store's qualitative-only rule and its forget barrier apply unchanged. Lane R pins both with tests.

This note maps how mature agent systems handle the decisions Waldo has open, area by area. It was written for the Mac orchestrator by a read-only research lane on 13 Oct 2026 (UTC).

**How to read it**
- Waldo code is cited as `path:line` under `packages/runtime/src`, at worktree HEAD `a45f5f5a`. Nothing under `packages/` changed since `f8c058b7`.
- [S#] points to the Sources list. [verified] means I saw it in a fetched page or a file I read in this run. [inference] is my conclusion. [proposed] is a suggested step.
- OpenAI SDK facts come from the installed `openai@5.12.2` source, the version pinned in `packages/runtime/package.json:26`. I read it locally from a sibling checkout's pnpm store; it was not fetched.
- All 29 web calls were used (25 plus 4 for area 8). Four of them returned only a redirect and one returned a 403. Anything I could not read is marked NOT RUN or NOT VERIFIED.

## 1. Model-call timeouts, retries and per-turn deadlines

### What mature systems do
**SDK defaults**
- Both SDKs retry twice and time out after 10 minutes.
- Both retry connection errors, timeouts, 408, 409, 429 and 5xx ([S2]; `openai@5.12.2 src/client.ts:569-594`, `:749-759`).
- The OpenAI SDK obeys `x-should-retry` first (`:741-747`). It honours a `retry-after` under 60 s; otherwise it backs off 0.5 s → 8 s with up to 25% jitter (`:764-815`).
- **Anthropic: stream long requests.** Idle connections can be dropped, and the SDK throws on a non-streaming request expected to run past about 10 minutes [S2].
- **OpenAI: the timeout is per attempt, and aborts wait for the retry sleep.** The timeout applies to each attempt (`:706`), and the SDK warns the total wait can far exceed it (`:233-234`). The retry sleep is a plain timer (`src/internal/utils/sleep.ts:3`), and the abort signal is checked only when the next attempt starts (`src/client.ts:561`).

**Claude Agent SDK [S4]**
- A run is bounded by `maxTurns`, `maxBudgetUsd` (an estimate that can overshoot, so leave headroom), an `abortController`, and an alpha `taskBudget` that tells the model what remains.
- There is no wall-clock limit for the whole run. `API_TIMEOUT_MS` defaults to 600000 and `CLAUDE_CODE_MAX_RETRIES` to 10 (capped at 15), so the Claude Code harness retries far more than the bare SDKs.
- Hitting a bound returns a typed result, not an exception: `error_max_turns`, `error_max_budget_usd` or `error_during_execution`. The result carries `num_turns`, `duration_ms`, `total_cost_usd`, `usage` and `errors[]`, but no `result` text.

**OpenAI Agents SDK [S5]**
- `max_turns` counts LLM calls. Exceeding it raises `MaxTurnsExceeded`, unless an `error_handlers["max_turns"]` handler returns a controlled final output, which can be kept out of history.
- It raises `ModelTimeoutError` per call and `ToolTimeoutError` per tool, but has no timeout for the whole run.
- `cancel(mode="after_turn")` stops a run, which can resume from `RunState`.

**AWS Builders' Library [S3]**
- Set the timeout at the latency percentile that matches an acceptable false-timeout rate: 0.1% means p99.9.
- Retries are "selfish": 5 layers of 3 tries each is 243× the load, so "retry at a single point in the stack".
- Use a local token bucket in preference to circuit breakers, plus jitter.
- Never retry client errors. Retry side effects only when they are idempotent.
- No deadline guidance.

**Google SRE, "Addressing Cascading Failures" [S6]**
- Cap retries per request and per process, use randomized backoff, and retry at one layer: 3 retries × 4 layers is 64 attempts.
- Never retry overload or permanent errors.
- Propagate an absolute deadline, check the time remaining before each stage, cancel work that can no longer succeed, and fail fast.

### What it means for Waldo
**[verified] One chat model step stacks five retry layers:**
1. SDK `maxRetries: 2` (`llm/openai.ts:40-44`).
2. A re-ask after a reasoning-only reply, inside the same timer (`:62-107`).
3. The provider plan (`llm/provider.ts:1108-1128`): primary model at full context, then at reduced context, then the fallback model. Each step gets a fresh 30 s timer (`llm/openai.ts:59`). `user_message` has one fallback (`packages/contracts/src/runtime/routing.ts:314-319`).
4. A breaker that opens after 3 failures and cools down for 30 s (`llm/provider.ts:276-278`).
5. The model re-calling tools that failed transiently (`conversation/tool-loop.ts:133-139`).

**[verified] The provider moves on after every failure except `invalid_args`** (`llm/provider.ts:443-457`), and every failure counts toward the breaker.
- `auth_failed` and `not_found` are permanent errors, yet they are re-sent twice more. Neither SDK retries 401, 403 or 404, and both AWS and SRE say never to retry permanent errors.
- `rate_limited` is retryable, but the SDK has already retried it twice inside the adapter. Re-sending it adds a retry layer and goes against SRE's "don't retry overload".

**[inference] The 30 s adapter timer (`llm/openai.ts:37`, `:59`) is not a wall-clock bound.** A 429 with `retry-after` under 60 s makes the SDK sleep on a timer that cannot be cancelled, so one adapter call can approach 90 s.

**[verified] Only the SDK reads the retry headers.** The SDK sees `retry-after` and `x-should-retry`, but the adapter collapses errors to bare codes (`llm/openai.ts:188-196`).

**[verified] The two paths differ.**
- Owner turns use `OpenAIResponsesAdapter` with the 30 s default (`channels/owner-turn.ts:186`).
- The run loop uses the Cloudflare gateway adapter: 20 s and no SDK retries (`run-loop/adapters.ts:164`; `llm/gateway.ts:20`, `:116-127`).

**[proposed] Pick one retry owner for `complete()`.**
- **Option A, the provider plan.** Set SDK `maxRetries` to 0 and surface the headers. Retry only transient errors, timeouts, 5xx, and 429 with a short `retry-after`. The plan sees attempts, fallbacks and the deadline.
- **Option B, the SDK.** Keep SDK retries, which handle the headers for free, and stop the plan re-sending on `transient`. The SDK cannot see the deadline.
- Either way, leave the trusted effect path alone: it is already one attempt plus reconcile (`llm/provider.ts:515-516`).

**[proposed] Add a per-turn deadline.**
- Set an absolute deadline at admission. Check it before admitting each model call or tool dispatch.
- When time runs short, withdraw tools the way the round budget does (`conversation/tool-loop.ts:163-175`).
- Never tear down an in-flight mutating dispatch; that is the cancellation fence.
- Retry a timed-out call at most once, and only if the deadline still covers it.
- Set timeouts from measured p99 or p99.9 latency.

**[proposed] End an out-of-time turn with a typed exit.**
- Add the exit beside `completed`, `budget_exhausted` and `withdrawn` (`conversation/tool-loop.ts:40-43`). It carries rounds, calls and elapsed time.
- Send an honest reply that names any unsettled effect, and decide whether that reply enters history.

**[inference] The timeout lane will not fix S5.** S5's extra ~17 s is two extra rounds (~12 s) plus three failed browse calls; area 3 covers that.

### Open questions
- What are the staging p50, p99 and p99.9 latencies for each path?
- Should a reduced-context retry run on a timeout, or only on `oversize`?
- Does the reasoning-only re-ask count against the retry budget?
- In a per-owner Durable Object, is a token bucket better than the in-memory breaker?

## 2. Conversation compaction (owner-approved plan #1182)

### What mature systems do
**Anthropic, "Effective context engineering" [S7]**
- Compaction summarizes a conversation near the window limit and restarts from the summary.
- Claude Code keeps decisions, unresolved bugs and implementation details. It drops redundant tool output, and keeps the five most recently accessed files.
- Tune the summary prompt on complex traces, aiming for recall first and then precision.
- Clearing old tool results is the lightest, safest form of compaction.
- Use compaction for long conversations, notes for milestone work, and sub-agents for parallel research.

**Claude API compaction [S14]**
- On demand: you request a summary and swap it in (beta `compact-2026-09-04`).
- At a token threshold: the API compacts inside the request and drops what came before the summary.
- Or you run your own summarizer.
- Recent turns can stay verbatim, a custom prompt replaces the default one, and compaction can run in the background.

**Claude API context editing [S8]**
- `clear_tool_uses_20250919` triggers at 100k input tokens by default and keeps the last 3 tool pairs. The call stays, and only its result becomes a placeholder.
- Edits apply server-side while the client keeps the full, unmodified history.
- Clearing breaks the prompt cache, hence the `clear_at_least` setting.

**Claude Agent SDK [S4]**
- A `compact_boundary` message carries `trigger` (manual or auto) and `pre_tokens`.
- The `PreCompact` hook gets `custom_instructions`, and the `PostCompact` hook gets `compact_summary`.

**OpenAI [S15], [S5]**
- The Responses API compacts by `context_management.compact_threshold` (the examples use 200,000) or through `/responses/compact`.
- The output is an encrypted, opaque item that must be passed on unedited. It is ZDR-friendly with `store=false`.
- The Agents SDK trims history per call with `call_model_input_filter`.

**NOT RUN:** the Claude Code `/compact` docs page and Codex compaction.

### What it means for Waldo
**[verified] The prompt window does not summarize.**
- It keeps the newest messages under 100k tokens and drops the oldest, always keeping the current owner turn (`conversation/window.ts:25-27`, `:41-60`). Drops are logged only as counts (`channels/owner-turn.ts:243`).
- Separately, each saved turn's raw text is stored in an FTS5 episode index in the owner's Durable Object. `search_episodes` and the nightly pass read that index (`channels/episodes.ts:5-6`).

**[inference] Trigger on input tokens, as both vendors do.** Compaction should fire before drop-oldest; drop-oldest stays as the never-fail floor.

**[inference] Keep three things verbatim:**
- the last N turns;
- the current message;
- references to open loops, pending approvals, owner corrections and commitments. These are Waldo's equivalent of Claude Code's decisions and recent files.

**[inference] Compact whole rounds, and never split a call from its output.** Waldo already keeps this rule for forgotten topics. It keeps the call and swaps only the output, because dropped results made the model repeat reads or the provider reject the request (`conversation/held-turns.ts:5-14`).

**[inference] The transcript stays canonical.** The summary is a derived view keyed to the range it covers. It is regenerated, never edited.

**[inference] Test recall from the compacted span.** Ask about corrections, names and commitments that appear only in the compacted part. Include a case where a forgotten topic must not resurface.

**Health tension (flag for the owner or an ADR)**
- CLAUDE.md lets the owner's health context into model context but keeps it out of bulk long-term memory ("qualitative patterns only"). New conversation-body storage needs a bounded contract or ADR (CLAUDE.md lines 17 and 23).
- [inference] A stored, reused summary acts as long-term memory. It should carry qualitative statements and pointers, with numbers recomposed each turn from the health plane. An ephemeral per-request summary is plain model context.
- [inference] OpenAI's opaque item cannot be inspected for health values or forgotten topics, which argues for a summary Waldo owns.
- Not checked: whether episodes hold health text.

### Open questions
- What does #1182 decide on trigger, storage and retention? I did not read it in this run.
- Should the summary be built inside the turn, which adds model time, or in the background [S14]?

## 3. The tool set per turn, and tool errors (S5's repeated `auth_failed`)

### What mature systems do
- **Anthropic, "Writing effective tools for agents" [S9].** Build a few thoughtful tools rather than wrapping every endpoint, because overlapping tools distract the agent. Claude Code caps a tool response at 25,000 tokens. Error responses should name specific, actionable fixes, not opaque codes. Measure tool calls, errors, tokens and runtime.
- **Anthropic, context engineering and tool definitions [S7], [S11].** Avoid bloated tool sets with ambiguous choices. Detailed descriptions matter most. Consolidate tools and give them namespaced names.
- **Anthropic, tool search [S10].** `defer_loading: true` keeps 3–5 core tools loaded and finds the rest on demand. It pays off above about 10K definition tokens or more than 10 tools, saved 85% of tokens in one example, and leaves the cache intact.
- **Anthropic, "Handle tool calls" [S13].** Return `is_error: true` with what to try next. After an invalid call, Claude retries 2–3 times with corrections.
- **Anthropic, "Building effective agents" [S20].** Design tools so mistakes are hard to make (poka-yoke).
- **Anthropic, multi-agent research system [S24].** Tell the agent when a tool is failing, and back that up with deterministic safeguards such as retry logic and checkpoints.

### What it means for Waldo
- **[verified] In the browse tools, `auth_failed` means Waldo's own browser setup is broken, not a site's login wall.** `browse_page` and `browse_act` return it when the provider is unconfigured or the browser key is rejected (401/403) (`tools/live/browser.ts:104`, `:113-139`, `:198`, `:207-219`; `channels/owner-browser-runtime.ts:153`). The failure cannot clear mid-turn, and both tools share it.
- **[verified] Eligibility is read once per turn.** It is offer trimming, not authority, and a check that throws keeps its tool (`tools/eligibility.ts:6-22`; `channels/owner-turn.ts:305-307`). A key that fails mid-turn therefore never withdraws the tool.
- **[verified] The loop dedupes on exact name plus arguments** (`conversation/tool-loop.ts:103-104`, `:138`). A settled failure replays only for an identical call, so a new URL dispatches again. Only `transient` with `tool_result_error` is retryable (`:133-134`). [inference] This fits S5; I did not read its trace.
- **[inference] There are three options:**
  1. **Offer fewer tools.** Necessary, but blind to failures that start mid-turn.
  2. **Return an actionable, non-retryable error.** For example: "browsing is broken for this turn; don't call browse tools again; ask the owner to replace the key." It is cheap and keeps judgment with the model, but relies on the model complying.
  3. **Add a loop guard.** After a typed `auth_failed` from either browse tool, withhold both for the rest of the turn and answer later calls with a receipt. This acts on a typed, settled signal, as the loop already does when it replays cached failures and refuses repeats (`conversation/tool-loop.ts:112-139`); it is not a judgment call.
- **[proposed] Combine options 2 and 3, scoped to the shared credential, and keep `transient` retryable within the budget.** [inference] On S5 this saves about two rounds, roughly 12 s. The provider has the same gap (area 1).
- **[inference] Tool search is not available as-is.** Waldo calls OpenAI Responses with function tools (`llm/openai.ts:77`), but the principle of offering fewer tools still holds. Measure definition tokens per turn first.

### Open questions
- Can `browse_act` fail for site-specific reasons that are worth retrying?
- How many tools, and how many definition tokens, does an owner turn offer?

## 8. Memory retrieval: pinned blocks, per-turn recall, hybrid search (B3 and B4)

### What mature systems do
- **Anthropic, context engineering [S7].** Hybrid retrieval loads a little up front for speed and fetches the rest just in time through tools; Claude Code loads CLAUDE.md up front and uses glob and grep at runtime. Just-in-time fetching is slower and needs heuristics, so start with the simplest approach that works. Recall falls as the token count grows (context rot).
- **Anthropic, memory tool [S25].** Memory is read just in time, and the API tells the model to view it first. Cap file sizes and `view` output, and expire files nobody accesses. Claude usually declines to store sensitive data, but strip it in the handler anyway.
- **Letta memory blocks [S16] (legacy V1 docs).** Blocks are always in context, with no retrieval step. Each has a label, a description, a value and a character `limit`, and the agent edits blocks through built-in tools. Blocks can be read-only or shared. The page does not say what happens on overflow.
- **ChatGPT saved memories.** NOT VERIFIED [S17].
- **Anthropic, Contextual Retrieval [S12] (Sep 2024).** BM25 plus embeddings, merged by rank fusion; BM25 catches exact identifiers. Failure rates fall by 35% with contextual embeddings, 49% with contextual BM25 added, and 67% with reranking (150 candidates down to 20), measured at top-20. Under about 200k tokens, put the whole corpus in the prompt with caching instead. The post names neither RRF nor k.
- **Elastic, RRF [S19].** The score is the sum of 1/(k + rank) across lists. `rank_constant` defaults to 60, and a higher k gives lower ranks more weight. RRF needs no tuning, and BM25 plus vector is its stated main use. The original paper was NOT READ [S18].

### What it means for Waldo
- **[verified] Waldo already runs FTS5 BM25 in three places:**
  - over active or promoted claims that are not untrusted (`tools/live/memory.ts:84`);
  - over episodes (`channels/episodes.ts:5-6`);
  - on a job-prompt path that keeps only owner-origin, non-health claims (`channels/owner-turn.ts:659-661`).
- **[inference] B3's design matches the documented hybrid:** pinned blocks, a per-message `<recalled>` block, and tools for depth. The sources stress a hard size cap and a clear description for each block, and getting depth through tools rather than bigger injections.
- **[inference] Keep `<recalled>` small, because context rot makes low-relevance hits a cost.** Contextual Retrieval's finding that top-20 beat 5 or 10 comes from document QA, not chat memory.
- **[inference] For short replies, let the model decide.** A reply like "ok do it" gives BM25 little to match. Whether to inject memory then is a judgment call under CLAUDE.md, so prefer the model calling `search_episodes` or `read_memory` over a fixed skip rule.
- **[inference] k = 60 is a defensible B4 default.** It is documented and needs no tuning. The evidence for it is from document retrieval, so validate it on a labelled Waldo recall set.
- **[inference] Measure before building B4.** If a typical owner's claim set is small, putting all of it in the prompt may beat embeddings.
- **[inference] Two hard rules apply.** Pinned blocks are long-term memory: qualitative only, with no raw health values (CLAUDE.md line 23). Blocks and vectors must also pass the forget barrier (area 6).

### Open questions
- How many tokens is a typical owner's claim set?
- Can the owner see and correct the nightly pinned selection?
- Which labelled set will measure recall?

## 4. Agent loop shape and latency

### What mature systems do
- **Anthropic, "Building effective agents" [S20].** Start simple: agentic systems trade latency and cost for task performance. Use stopping conditions, get ground truth from the environment at each step, and set checkpoints. Parallelize by sectioning or by voting.
- **Anthropic, latency docs [S21].** Use a faster model or lower effort, trim prompt and output tokens, set `max_tokens`, and stream for a faster first token. The page says nothing about round trips.
- **Anthropic, programmatic tool calling [S10].** One code block can run 20+ calls without a model round trip each, and the post reports 37% fewer tokens.
- **Anthropic, multi-agent research [S24].** Parallel subagents and parallel tool calls cut research time by up to 90%.
- **NOT RUN:** the Agent SDK engineering post and the parallel-tool-use page.

### What it means for Waldo
- **[inference] On S5, fewer rounds beats faster calls.** Cutting 2 of the 8 rounds removes about 25% of model time, plus the time the failed tools took; a faster model would need a 25% per-call speedup just to match that. Effort is already set low (`llm/openai.ts:75`).
- **[verified] Tool calls in one response run sequentially** (`conversation/tool-loop.ts:100-120`). [inference] Running read-only calls concurrently would cut tool time, but mutations must stay ordered, because dedupe and epoch state depend on order (`:138-153`). The request does not set `parallel_tool_calls` (`llm/openai.ts:68-80`), and I did not check its default.
- **[inference] Streaming improves perceived latency in the app, not total turn time** [S21].

### Open questions
- Across the 9 scenarios, how is turn time split between model calls, tools and overhead?

## 5. Evals for agents

### What mature systems do
**Anthropic, "Demystifying evals for AI agents" [S22] (Jan 2026)**
- **Terms.** Task, trial, grader, transcript, outcome, evaluation harness, agent harness and eval suite.
- **Graders.** Code-based graders are fast but brittle. Model-based graders are flexible but need calibration against humans. Human graders are the gold standard but slow.
- **pass@k and pass^k.** pass@k counts at least one success in k trials. pass^k requires all k to succeed, which suits customer-facing agents: a 75% per-trial rate gives about 42% at pass^3.
- **Capability and regression evals.** Capability evals start with low pass rates; regression evals sit near 100%.
- **Getting started.** Begin with 20–50 tasks drawn from real failures. Give each a reference solution, balance cases that should and should not trigger, and run every trial in a clean environment.
- **Grading practice.** Read transcripts. Grade the outcome, not the path, and allow partial credit. For conversational agents, a second LLM often plays the user.

**Other Anthropic posts [S24], [S9]**
- Start with about 20 queries. Grade with an LLM judge on a 0–1 rubric, add human testing, and check the end state.
- Keep held-out sets, and track calls, errors, tokens and runtime.

### What it means for Waldo
- **[proposed] Turn each of the 9 scenarios into a task.** Each task has:
  - a fixed owner message and seeded test-owner state;
  - a coded outcome check on the end state (what was stored, sent or opened for approval);
  - a rubric grader for the reply, plus human spot checks.
- **[inference] Report pass^k with k ≥ 3 alongside pass@k,** since Waldo is person-facing.
- **[proposed] Record calls, tool calls, tool errors and wall time on every trial.** S5's 8 calls against the baseline's 6 then shows up as a regression without anyone looking for it.
- **[inference] Use a fresh test owner for each trial, with synthetic health values only,** as the security checklist requires.

### Open questions
- Which scenarios need a simulated user?
- Where can transcripts be read under the trace rules?

## 6. Forgetting memories

### What mature systems do
- **Anthropic memory tool [S25].** `delete` removes a file or directory recursively, and `str_replace` with no `new_str` deletes text. Expire stale files, and strip sensitive data in the handler.
- **Anthropic context editing [S8].** Cleared tool results leave the prompt, but the client keeps the full history, so clearing is not deletion.
- **OpenAI compaction [S15].** Items older than the latest compaction item may be dropped. [inference] The opaque compaction item can still carry their content.
- **ChatGPT.** NOT VERIFIED [S17]. This area has no primary source from outside Anthropic.

### What it means for Waldo
- **[verified] Waldo already pairs deletion with a content-free tombstone:**
  - `forget` deletes the row (`memory/claims.ts:439-441`).
  - `barrier` stores only a fingerprint, which blocks re-admission (`:442-453`).
  - `remember` refuses text that matches a barrier (`tools/live/memory.ts:56`).
  - A cleanup that cannot be verified keeps the topic hidden until it is (`:127`).
  - Tool outputs that match are withheld behind a receipt (`conversation/held-turns.ts:3-14`).
- **[inference] No API offers unlearning, so the only lever is keeping a forgotten topic out of context.** The sweep must cover every new derived copy (areas 2 and 8), the episode index, and traces.

### Open questions
- Are summaries, pinned blocks, vectors and episodes swept on forget, and is that tested?

## 7. Long-running and multi-session work (how the orchestrator runs lanes)

### What mature systems do
**Anthropic, "Effective harnesses for long-running agents" [S23] (Nov 2025)**
- **Setup.** Each session starts with no memory, so an initializer agent sets up the handoff first.
- **Handoff files.** A JSON feature list with pass/fail fields (models are less likely to overwrite JSON), a progress file, an init script and git commits.
- **Pace.** Work on one feature at a time, and leave a clean state.
- **Session start.** Read the progress file and the git log, then run a basic end-to-end test.
- **Done means tested.** Mark a feature passing only after end-to-end testing.
- **Observed failures.** One-shotting the whole task, and declaring victory early.

**Anthropic, multi-agent research system [S24] (Jun 2025)**
- **Cost.** Multi-agent runs use about 15× the tokens of chat, and token usage explains 80% of the variance.
- **Briefs.** Each needs an objective, an output format, tool guidance and boundaries.
- **Fit.** The pattern suits tightly coupled coding poorly.
- **Operations.** Resume rather than restart. Use rainbow deploys, and trace without reading content.

### What it means for Waldo
- **[proposed] Give each lane a JSON task list, a progress log and a start routine.** The routine reads the log and the git log, then runs the gate. "Done" requires a passing gate, which matches the repo's PASS/FAIL/NOT RUN rule.
- **[inference] Keep code lanes single-writer, and fan out only for research and review.** This matches `.claude/rules/INDEX.md`, which keeps code lanes single-writer unless their files are disjoint. Budget the token cost before any fan-out.

## Sources (fetched 2026-10-13 UTC)

- [S1] https://github.com/anthropics/anthropic-sdk-typescript (README; no retry detail, points to S2)
- [S2] https://platform.claude.com/docs/en/api/sdks/typescript
- [S3] https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter (301 from aws.amazon.com/builders-library; byline "Marc", @mbrooker)
- [S4] https://code.claude.com/docs/en/agent-sdk/typescript (characters 0–200000 of 291014 read)
- [S5] https://openai.github.io/openai-agents-python/running_agents/
- [S6] https://sre.google/sre-book/addressing-cascading-failures/
- [S7] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (29 Sep 2025)
- [S8] https://platform.claude.com/docs/en/build-with-claude/context-editing (first 100000 of 105119 characters)
- [S9] https://www.anthropic.com/engineering/writing-tools-for-agents (11 Sep 2025)
- [S10] https://www.anthropic.com/engineering/advanced-tool-use (24 Nov 2025)
- [S11] https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use (served the "Define tools" page)
- [S12] https://www.anthropic.com/news/contextual-retrieval (19 Sep 2024)
- [S13] https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
- [S14] https://platform.claude.com/docs/en/build-with-claude/compaction (overview page only)
- [S15] https://developers.openai.com/api/docs/guides/compaction (301 from platform.openai.com)
- [S16] https://docs.letta.com/guides/agents/memory-blocks (legacy V1 docs)
- [S17] NOT READ: https://help.openai.com/en/articles/8590148-memory-faq (403)
- [S18] NOT READ: https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf (302 to cormack.uwaterloo.ca, not followed)
- [S19] https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion
- [S20] https://www.anthropic.com/engineering/building-effective-agents (19 Dec 2024)
- [S21] https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency
- [S22] https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents (9 Jan 2026)
- [S23] https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (26 Nov 2025)
- [S24] https://www.anthropic.com/engineering/multi-agent-research-system (13 Jun 2025)
- [S25] https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Local, not fetched: the installed `openai@5.12.2` source (`src/client.ts`, `src/internal/utils/sleep.ts`, `src/core/error.ts`).
