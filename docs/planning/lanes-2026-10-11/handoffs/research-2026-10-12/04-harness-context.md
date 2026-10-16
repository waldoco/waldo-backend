# Harness context management: current state, gaps, and the C + A design

Research for the overnight orchestrator, 12 Oct 2026. Read-only; nothing in the repo was edited, run, committed or posted.

- **Code base:** worktree `elastic-rubin-edf46f` at `35b7c21b` (beta-mvp `4bb040f5` plus one docs commit). All file:line references are at that SHA. The long-conversations brief was written at `596706c2`; its line numbers drift by one in three places (section 5).
- **Labels:** **[verified]** means I read it in source or in a fetched primary document this session. It does not mean executed: I ran no tests. **[inference]** means a conclusion I did not observe directly. **[proposed]** means a recommendation.
- **Secondhand data:** the latency and caching numbers come from the owner memory note `latency-baseline-2026-10-10.md`. Another session recorded them from Langfuse and `trace_log` on 10 Oct; I could not re-check them because I have no staging access.
- **Sources:** primary web sources were fetched on 12 Oct 2026 (section 6).

---

## 0. Findings, ranked

1. **Cross-turn tool memory reaches the reply model on neither production path.** [verified by reading; not executed]
   - The tool-output ledger is written every turn (`channels/owner-turn.ts:598`).
   - App turns build their composer with only a `health` source (`channels/telegram-owner-do.ts:2137`), so `tool_outputs` is always `[]` (`context-composer/owner-turn.ts:71`).
   - On Telegram, the composition that does include the ledger is passed as `request.system` (`conversation/joined-path.ts:73`), but the reply callback never reads it. The callback builds its own system prompt (`owner-turn.ts:461-489`) and uses only `request.composition.healthPrompt` (`:466`).
   - So `<recent-tool-results>` is either empty (app) or discarded (Telegram). The brief's "tool observations are already elided" is therefore wrong: they are absent.
2. **History is cut in three places, and none of the cuts tells the model.** [verified]
   - The three cuts:
     - the token window (`conversation/window.ts:44-61`);
     - the provider's own oldest-first trim: a 1,024-item cap, a 400k-char budget, and a bisection trim on soft sanitiser failures (`llm/provider.ts:1428-1460`);
     - the held-topic filter (`owner-turn.ts:417`).
   - Only the first is logged (`owner-turn.ts:243`). The trace field `history_messages` is computed before the provider trim (`owner-turn.ts:219`).
   - The window counts bytes/4 + 8 tokens per message, so average messages under about 358 bytes trip the 1,024-item cap before the 100k-token budget. A chatty owner's effective window can therefore be about 512 exchanges, cut silently. [inference from the two bounds]
   - Counting `context_window` log lines in staging, as the brief proposes, would undercount drops.
3. **App chat is invisible to `search_episodes` and to nightly consolidation.** [verified wiring]
   - Only the legacy KV store is wrapped by the episodes index (`telegram-owner-do.ts:2042`). The canonical app store is not (`:2140`).
   - App turns still offer `search_episodes` (`:2051`), which then searches Telegram history or nothing.
   - Nightly reads only legacy episodes (`:2317`). App setup does not arm it (`:2027`), though a time-zone write can (`:2654`); either way, app chat never reaches it.
   - On the app, an out-of-window fact is unrecoverable unless the model called `remember` in the same turn. [inference]
   - A naive fix would misfile app owner turns. `speakerOf` classifies by id prefix (`channels/episodes.ts:21`), and app ids are `app-N` (`channels/app-inbox.ts:53`), so owner turns would be labelled `system` and dropped from nightly (`episodes.ts:87`).
4. **Nothing carries "what is in flight" across turns: no working set.** [verified]
   - Owner-visible receipts are appended to `appPayload` only (`owner-turn.ts:593-597`), while the model reads `modelPayload` (`joined-path.ts:87`; `contracts/runtime/conversation-entry.ts:149-158`).
   - Pending approvals, artifacts, reminders and background runs never enter the model's view unless they were quoted in a reply that is still inside the window.
   - `ConversationEntry` has no timestamp (`conversation-entry.ts:12-27`), so neither a dated horizon nor "last Tuesday" recall is possible over canonical history.
5. **The prompt layout prevents cross-turn prompt caching.** [verified layout; outcome is inference plus secondhand data]
   - The whole system prompt goes in `instructions` (`llm/openai.ts:71`). It ends in a per-turn tail: the memory profile, REASONS (which embeds the current owner text on app), and a minute-resolution clock (`owner-turn.ts:468-479`; `context-composer/prompt.ts:122-128`; `prompt/messaging-behavior.ts:116-128`).
   - Ordinary prefix caching already implies the result: per-turn bytes come before all history, so no history can sit in a prefix that a later turn reuses.
   - Supporting detail from OpenAI's caching guide (verbatim-checked): top-level `instructions` cannot contain an explicit breakpoint, and implicit mode places one breakpoint at the end of the latest eligible input message. So no breakpoint ends inside `instructions`.
   - Once overflow starts, the oldest-first window also shifts the first history message every turn.
   - The memory note records 23 of 28 first calls with zero cached tokens. Per the same guide, cache writes cost 1.25× on GPT-5.6+ models; the adapter ignores `cache_write_tokens` (`openai.ts:94`) and `modelCost` has no write rate (`llm/pricing.ts:14-19`).
6. **The per-turn capability manifest is not minimal.** [verified]
   - Every eligible handler is offered on every round (`owner-turn.ts:307`).
   - The tool set is rendered three ways: JSON definitions (`openai.ts:77`), a name list in behavior (`messaging-behavior.ts:79`), and the 72-name ACL ceiling inside REASONS (`context-composer/prompt.ts:145`).
   - ADR-0034 (lazy discovery via `search_tools`) is accepted (`docs/foundation/accepted-adrs.json:208-211`), but `search_tools` has a schema (`hooks/registry.ts:213`) and no live handler.

Secondary findings:

- The memory profile is newest-first, and `turnMemoryPrompt` ignores its `question` argument (`memory/claims.ts:1014-1031`).
- A fresh responder per app turn empties `recentOwnerTurns`, so `remember` can ground only on the current message (`owner-turn.ts:160,609-613,636`).
- Every turn lists all canonical rows and reads one witness per row (`conversation/canonical-owner-store.ts:59-90`).
- Tool results are not cleared within a turn below the 400k hard cap.
- Nightly sees only the newest 40k characters of a day.

There are few true "fixed rule makes a judgment call" violations; section 4 lists them honestly.

---

## 1. How a Waldo turn is built today

### 1.1 Two paths, one responder

| Aspect | App (canonical) | Telegram (legacy) |
|---|---|---|
| Run scope | One per inbox record (`telegram-owner-do.ts:749-760`) | Durable path passes one (`:1520`) |
| Responder | Fresh scoped responder per turn whenever the scope differs (`owner-turn.ts:609-613`) | Same |
| History store | `canonicalOwnerConversationStore` via history factory (`owner-turn.ts:123`; `telegram-owner-do.ts:2140`) | Legacy `conv:*` KV wrapped by `indexedConversationStore` (`:2042`) |
| Composer whose prompt reaches the reply | App composer, recomposed every round (`owner-turn.ts:458`), sources `{health}` only (`telegram-owner-do.ts:2137`) | None. The local trusted-brief composer runs at `joined-path.ts:64`, but only its `healthPrompt` is read (`owner-turn.ts:466`) |
| Skills, workspace receipts | Not wired: the skill host is passed only for Telegram (`telegram-owner-do.ts:2080`) | Skill prompt, catalog and workspace receipts (`owner-turn.ts:429-453`) |
| Scenario harness coverage | Only bespoke DO tests (`test/owner-turn-context-shape.test.ts:42-72`) | L1 scenarios (`scenarios/run-l1.ts:118` uses `createTelegramResponder`) |

### 1.2 Pipeline (app path)

1. **Ingress.** The app send creates record `app-N` (`app-inbox.ts:53`). `drainApp` claims it, creates a per-record `RunEffectScope`, and calls `this.turn(…,'app',true,scope)` (`telegram-owner-do.ts:749-760`). The listener then calls `responder.respond` (`:2161-2163`). [verified]
2. **Scoped responder.** `respond` sees a new scope, prepares context through `contextHost` (admission plus `createOwnerTurnContext` with `{health}`), and builds a new responder (`owner-turn.ts:609-613`; `telegram-owner-do.ts:2132-2140`). Per-responder state starts empty: `recentOwnerTurns` (`:160`), `offloadStore` (`:150`), `pendingToolOutputs` (`:147`), `tree` (`:240`) and `restorePromise` (`:555`). [verified]
3. **Restore.** The canonical store lists every `conv:` row, fetches and `stableJson`-compares one witness per row, then appends all rows to an in-memory `ConversationTree` (`canonical-owner-store.ts:59-90`; `owner-turn.ts:556-557`). Pending forget purges run here (`:558-570`). [verified]
4. **Persist input, then submit.** The owner entry is persisted before the model call (`owner-turn.ts:581`). `JoinedConversationPath.submit` (`:582-588`):
   - composes once (`joined-path.ts:64`);
   - takes the ancestor path as model messages (`:68`, `:116-117`), where `modelContext` emits `modelPayload` or the `replace` payload by projection mode (`conversation-entry.ts:149-158`);
   - windows the result (`joined-path.ts:69`; `window.ts:44-61`);
   - calls the model (`joined-path.ts:72-78`). [verified]
5. **Tool loop.** The reply callback:
   - computes eligibility once for all handlers (`owner-turn.ts:307`);
   - wraps each handler with currentness checks and held-topic withholding for retained reads (`:311-361`);
   - adds per-turn `delegate_task` (`:372-404`);
   - runs `runToolLoop` with 25 rounds shared with children (`:61`, `:371`, `:405-511`). [verified]
6. **Each round** (`step`, `owner-turn.ts:411-500`):
   1. Drops history messages that carry a held (forget-pending) topic (`:417`).
   2. Appends the reply quote and steering to the last user message (`:419-420`).
   3. Reads standing orders and open loops live (`:421-427`).
   4. Recomposes REASONS (`:458`).
   5. Assembles the system prompt (`:461-489`):
      - **head:** behavior, skill catalog, orders, loops;
      - **procedures** (Telegram);
      - **tail:** memory profile, REASONS, health (Telegram fallback), clock, task context, connections.
   6. Budgets memory and loops against the sanitiser's whole-prompt cap (`:473-475`, `:519`). [verified]
7. **Provider.** `RuntimeLLMProvider`:
   - sanitises the system prompt and never cuts it (`provider.ts:1414-1421`);
   - cuts history to 1,024 items and a 400k-char derived budget (`:1428-1437`);
   - bisects off the oldest messages on soft sanitiser failure (`:1438-1460`);
   - handles tool turns per item, then in aggregate. On aggregate oversize it compacts the largest turn to a 4,000-character head plus a truthful receipt; if only small turns remain, the largest becomes an omission receipt (code read at `:1568-1612`; rationale in comments at `:1466-1479`).

   `OpenAIResponsesAdapter` then sends `instructions` = full system prompt, `input` = messages plus tool turns with replayed output items, `store:false`, `reasoning.effort:'low'`, `prompt_cache_key: waldo:<owner>` and non-strict tools (`openai.ts:68-79`, `:131-168`; `owner-turn.ts:137`, `:205`). [verified]
8. **Tool results.**
   - Results over 16,000 characters are cut, or offloaded to a 4,000-character head plus a retrievable id (`conversation/tool-loop.ts:7-20`, `:179`).
   - Every prior tool turn of this turn is resent on every round (`:91`, `:180`).
   - Budget notes appear in the last five rounds (`:169-175`). [verified]
9. **Persist output.**
   - The owner entry and the assistant entry are saved; the assistant entry's `appPayload` gets the receipt line on app (`owner-turn.ts:593-597`).
   - Tool outputs go to a 6-row ring, each the first 500 characters of the raw output JSON (`owner-turn.ts:508`, `:598`; `conversation/tool-output-ledger.ts:19-20`, `:105-118`). [verified]
10. **Background.** Nightly runs `claim_ops` over the newest 40,000 characters of the last 24 hours of episodes (`telegram-owner-do.ts:2312-2330`; `episodes.ts:52-62`). It runs on legacy history only (finding 3). [verified]

### 1.3 What fills the window

| Section | Position | Bound | Changes | Evidence |
|---|---|---|---|---|
| Tool definitions (all eligible handlers + `delegate_task`) | Request `tools` | None beyond the handler set | Per turn | `owner-turn.ts:307`; `tool-loop.ts:29-34`; `openai.ts:77` |
| Behavior (identity, voice, vocabulary, doing, health, memory manners, tool-name list) | `instructions` head | ~12.9 KB (~3.2k tokens) [measured from source literals] | Stable | `messaging-behavior.ts:70-85` |
| Skill catalog, standing orders, open loops | Head | Loops get the room memory leaves | Loops change when the loop book changes, re-read every round | `owner-turn.ts:421-427,470`; `channels/loops.ts:117-133` |
| Skill procedures and safeguards | Between head and tail (Telegram) | Skill budget | Per turn | `messaging-behavior.ts:144-153` |
| Memory profile | Tail, first | ≤12,000 chars; newest owner-grounded fact/preference/routine/health/goal claims; omission line | When claims change | `claims.ts:1013-1031`; `owner-turn.ts:474` |
| REASONS (app) | Tail | Prompt ≤400k; staged input ≤4k each; ≤4 workspace fragments; ≤6 tool fragments | Every turn: it embeds the owner text | `context-composer/prompt.ts:111-152`; `materials.ts:39-43` |
| Health zones (Telegram fallback) | Tail | Bounded narrative | Per turn | `owner-turn.ts:466-467`; `prompt.ts:169-188` |
| Clock | Tail | One line | Every minute | `messaging-behavior.ts:116-128` |
| Connections | Tail | One line | Eligibility | `messaging-behavior.ts:131-133` |
| History (user/assistant text only) | `input` | ≤100k est. tokens (bytes/4 + 8 per message) and ≤1,024 items | Grows; slides after overflow | `window.ts:15-32`; `provider.ts:1428-1437` |
| Current message + reply quote + steering + workspace receipts | Last `input` message | Quote ≤ `REPLY_QUOTE_LIMIT`; receipts ≤4,096 bytes | Per turn | `owner-turn.ts:419-420,439-452` |
| In-turn tool turns + replayed output items | `input` tail | 16k chars per output (offload: 4k head); aggregate ≤400k | Grows per round | `tool-loop.ts:179-180`; `openai.ts:148-165` |

Composition of REASONS on the app path [verified]:

- the owner text, duplicating the last user message (`prompt.ts:122-128`; `context-composer/owner-turn.ts:58-67`);
- identity without a profile, since `ownerProfile` is not supplied;
- trigger behaviour;
- the ACL ceiling list;
- a recall stub saying recall is unavailable (`context-composer/owner-turn.ts:103-108`);
- health;
- "No workspace context is available for this headless path";
- "No recent tool results";
- voice and safety.

Much of the app REASONS block is boilerplate and "unavailable" placeholders. [inference]

### 1.4 Every cut, and whether the model is told

| Cut | What goes | Model told? | Logged? | Evidence |
|---|---|---|---|---|
| Token window (100k est.) | Oldest whole messages; current kept | No | Only when `dropped>0`, content-free | `window.ts:44-61`; `owner-turn.ts:243` |
| Provider item cap (1,024) and char budget (400k) | Oldest | No | No; `history_messages` counts pre-cut | `provider.ts:1428-1437`; `owner-turn.ts:219` |
| Provider bisection on soft sanitiser denial | Oldest | No | No | `provider.ts:1438-1460` |
| Held-topic filter | History messages carrying a forget-pending topic | No (tool results do get an explicit withheld receipt) | No | `owner-turn.ts:417`; `held-turns.ts:3` |
| Tool output >16k | Tail of output | Yes, with retrieval id or narrowing hint | Yes | `tool-loop.ts:11-20` |
| Aggregate tool-turn overflow | Largest turn becomes a 4k head + receipt, or an omission receipt | Yes | Yes | `provider.ts:1568-1612` |
| Profile over room | Older claims | Yes: count plus "search memory" pointer | No | `claims.ts:1031` |
| Loops over room | Extra loops | Yes: count plus ledger pointer | No | `loops.ts:123` |
| Job prompts over half budget | Middle lines | Yes: omission marker | No | `prompt/fit-prompt.ts:3,31-41`; `owner-turn.ts:649` |
| Tool ledger | All but first 500 chars; ring of 6 | Moot: never reaches the reply (finding 1) | No | `tool-output-ledger.ts:19-20,106` |
| Nightly input | Older part of a busy day beyond 40k chars | n/a | Day count only | `episodes.ts:52-62`; `telegram-owner-do.ts:2317` |
| Reply length | Text past the 4,096 output pin | Owner is told | Yes | `owner-turn.ts:235` |

The codebase already announces cuts everywhere except the conversation history. The window is the outlier. Option A applies the existing convention, not a new idea. [inference]

### 1.5 Per-turn capability manifest

- **Ceiling.** `TOOL_PERMISSIONS.user_message` lists 72 tools (`contracts/tools/permissions.ts:194` onward). [verified by count]
- **Offered.** All host handlers minus:
  - eligibility failures (not connected or not configured; `tools/eligibility.ts:8-23`);
  - memory writes when the turn may not write (`owner-turn.ts:307`);
  - probe-stripped tools (`:362-364`).
- **Background jobs** pass explicit subsets (`telegram-owner-do.ts:2511`, `:2521`). [verified]
- **Children** get a read-only subset in an isolated context and return a compact report (`conversation/subagent.ts:15-37`). [verified]
- **No relevance narrowing.** There is no `search_tools` handler (finding 6).

### 1.6 Caching

- **Mechanism.** OpenAI automatic caching with a per-owner `prompt_cache_key` (`owner-turn.ts:137`, `:205`; `openai.ts:76`). Routing `cache:'none'` only sets Cloudflare AI Gateway's `cf-aig-skip-cache` (`llm/gateway.ts:140`), and owner chat calls OpenAI directly (`owner-turn.ts:186`). [verified]
- **Intent.** The design puts the stable head first and the per-turn tail last (`messaging-behavior.ts:142-153`). A test asserts the behavior bytes are a shared `instructions` prefix across two app turns (`test/owner-turn-context-shape.test.ts:61-72`). [verified]
- **Provider rules** (OpenAI prompt-caching guide, GPT-5.6+) [verified doc]:
  - implicit mode places one breakpoint at the end of the latest eligible input message (user message, last tool response of a group, or last developer message of the initial group);
  - top-level `instructions` cannot contain an explicit breakpoint;
  - a cached prefix stays reusable for 30 minutes after its latest write or reuse;
  - writes cost 1.25×, reads 0.1×;
  - `prompt_cache_key` no longer drives routing.
- **Consequence.**
  - Across turns: the first breakpoint any later turn could reuse lies after per-turn bytes, so cross-turn reuse is structurally unavailable, not just unlucky. [inference]
  - Within a turn: rounds can reuse up to the previous user message only if `instructions` stay byte-identical. A minute flip of the clock, or a mid-turn `remember` or `open_loop` that changes the profile or loops, breaks that. [inference]
  - The memory note's 10 of 36 zero-cache later calls fit this: a 6-20 s gap crosses a minute boundary roughly 10-33% of the time. [inference; falsifiable from `trace_log`]
- **Is gpt-6-luna a "GPT-5.6+" model for these rules?** [inference: likely, since the guide names GPT-6.1 Sol]
- **Cost accounting.** The adapter reads `cached_tokens` only (`openai.ts:94`); writes are not modelled (`pricing.ts:14-19`). [verified]

### 1.7 Memory and recall

- **`remember`** grounds the evidence quote in the current or recent owner turns, supports `replaces_id`, and stores duplicates as no-ops (`tools/live/memory.ts:50-75`). On scoped responders, "recent" is empty, so grounding uses the current message plus steering only (`owner-turn.ts:160-166`, `:636`). [verified by reading]
- **Reads.**
  - `read_memory` uses FTS over `claim_recall` (`memory.ts:76-87`).
  - `read_owner_context` uses `store.recall` (`tools/live/owner-context.ts:6-16`).
  - Both are retained reads with held-topic withholding (`owner-turn.ts:314-358`). [verified]
- **`forget_memory`** takes ids, a literal topic or a span. It redacts history literally, including canonical rows and their witnesses (`memory.ts:88-136`; `channels/conversation-store.ts:78-140`). Paraphrase remains the documented limit. [verified]
- **Episodes.** FTS5 with BM25 over legacy saves; `ftsQuery` ORs up to 16 terms (`episodes.ts:25-50`). [verified]
- **Composer recall stage.**
  - The app default returns `failed` (`context-composer/owner-turn.ts:103-108`).
  - A `partial` result may not carry episode hits (`context-composer/recall.ts:127-129`).
  - So recall cannot simply be "pushed into context" through that stage without changing its rule. [verified]

### 1.8 What already matches best practice

- **Truthful truncation with retrieval ids and paging** (`tool-loop.ts:11-20`; `tools/read-tool-output.ts`). This matches Anthropic's tool guidance: paginate, filter or truncate with sensible defaults, and steer with truncation messages.
- **Head-plus-receipt compaction of the largest tool output** at the aggregate cap (`provider.ts:1568-1612`). This is a form of tool-result clearing, though only at the hard limit.
- **Sub-agents** in clean contexts with a shared round budget and compact reports (`subagent.ts`; `owner-turn.ts:369-404`). This matches Anthropic's sub-agent architecture.
- **Memory as explicit tools** with provenance and owner-quote grounding. This is close to Letta's agent-edited blocks and the Claude memory tool, with stricter provenance.
- **Omission notes** for the profile and loops. These match "lightweight identifiers plus just-in-time retrieval".
- **Content-free per-section byte telemetry** (`owner-turn.ts:213-223`; `docs/ops/OBSERVABILITY.md:70`).
- **Reasoning items.** Replaying output items, reasoning included, across rounds (`tool-loop.ts:180`; `openai.ts:148-165`) matches OpenAI's current guidance. Reasoning items now carry `encrypted_content` by default in stateless (`store:false`) mode, so the missing `include` is not a gap. [verified doc]

---

## 2. Gaps vs best practice

| # | Gap | Evidence | Best practice | Severity | Label |
|---|---|---|---|---|---|
| G1 | Prior turns' tool observations never reach the reply; follow-ups depend on reply prose | §0.1 | Anthropic context engineering: keep lightweight identifiers and reload just in time. Claude Code restores recently touched files after compaction | Correctness and quality | Verified (reading) |
| G2 | Three silent, miscounted history cuts; no out-of-view signal | §1.4 | Claude context editing puts placeholder text where content was cleared. Anthropic tool guidance: truncation messages that steer. Hermes and OpenClaw keep full history on disk, searchable via `session_search` with a recovery pointer | Correctness (absence read as non-existence) and observability | Verified |
| G3 | App chat absent from search and nightly; id-prefix speaker rule | §0.3 | Letta dreaming consolidates after N steps or at compaction. OpenClaw flushes durable notes before compaction. Hermes archived turns stay searchable | Correctness | Verified wiring; consequence inferred |
| G4 | No working set; receipts invisible to the model; no entry timestamps | §0.4 | Claude Code re-injects plan, memory and rules from disk after compaction. Anthropic's long-running harness reads a progress file and feature list at session start. LongMemEval's temporal reasoning needs time keys | Correctness ("did you send it?", "that one") and quality | Verified |
| G5 | Cache-hostile layout and sliding window; writes unaccounted | §1.6 | OpenAI caching guide (static first, dynamic last; breakpoints at messages; 30-min TTL; 1.25× writes). Claude caching (tools→system→messages; breakpoint on the last stable block). Hermes uses a rolling three-message breakpoint | Cost | Verified layout; outcome inferred |
| G6 | Every tool, every round, three renderings; ADR-0034 unbuilt | §0.6 | Anthropic advanced tool use: deferred loading cut ~77K to ~8.7K tokens and raised Opus 4.5 selection accuracy from 79.5% to 88.1%; recommended above about 10 tools or 10K definition tokens. Writing-tools guidance: fewer, consolidated tools | Cost, latency and quality | Verified; benefit for Waldo inferred |
| G7 | No in-turn tool-result clearing below the 400k cap | `tool-loop.ts:91,180` | Claude context editing (default trigger 100k input tokens, keep 3 tool uses, `clear_at_least`). Hermes phase-1 pruning. OpenClaw per-request session pruning | Cost and latency on long research turns | Verified |
| G8 | Profile chosen by recency; `question` unused | `claims.ts:1014-1031` | The build plan itself asks for actual query relevance rather than latest-N (`WALDO_PERSONAL_AGENT_…BUILD_PLAN…:300`). Letta blocks are curated by the agent | Quality | Verified |
| G9 | O(N) canonical load plus N witness reads per turn | `canonical-owner-store.ts:59-90`; `owner-turn.ts:556,609-613` | OpenAI Agents SDK sessions cap retrieval to the most recent N items. Anthropic just-in-time loading | Latency at scale (unmeasured) | Verified |
| G10 | Fresh responder resets `recentOwnerTurns`; `read_tool_output` description says outputs live for the "current conversation" while the store lives one turn | `owner-turn.ts:150,160,636`; `read-tool-output.ts:19` | Anthropic tools: descriptions must be accurate | Quality (minor) | Verified by reading |
| G11 | Nightly sees only the newest 40k chars per day | `episodes.ts:52-62`; `telegram-owner-do.ts:2317` | Build plan items 3 and 4: incremental consolidation with a source cursor (`…BUILD_PLAN…:297-300`) | Quality | Verified |
| G12 | No pre-persistence health quarantine on the canonical transcript | Only secret URLs are scrubbed (`canonical-owner-store.ts:18-21`); the quarantine is required by `docs/planning/waldo-agent-mvp/IMPLEMENTATION_CONTRACTS.md:39` and CLAUDE.md | Claude memory-tool docs advise stripping sensitive data before writes | Correctness and privacy; a constraint on any C/A text | Verified |

---

## 3. Recommendations: options C and A

### 3.1 Principles taken from the sources

- **Durable state outside the transcript.** State that must survive overflow (approvals, effects, loops, artifacts) should be re-derived each turn from durable stores, not recovered from summarised history. Claude Code re-injects from disk; the Anthropic harness re-reads its progress file.
- **Leave a pointer wherever content is dropped.** Context editing uses a placeholder; Hermes and OpenClaw keep a recovery pointer. Keep the full record retrievable (OpenClaw, Hermes).
- **Identifiers and just-in-time reads.** Give the model ids and let it fetch details, rather than pre-loading content (Anthropic context engineering).
- **Expect the recall tool to go unused.** In the harness study, making elided content recoverable added machinery the models rarely used, with no accuracy gain (arXiv 2609.20804, coding and terminal benchmarks only). So C must carry the weight without needing model initiative, and A is the honest backstop. The brief's 56.3% figure is not in the abstract; I did not verify it.

### 3.2 One new composer material, two producers [proposed]

Both A's note and C's working set enter as **one optional, host-derived material** on the existing ContextComposer seam.

- **Seam.** Add `conversation_state: ContextFragment | null` to `RuntimeContextMaterials` (`context-composer/types.ts:81-95`).
- **Admission.** `materials.ts` admits it with `source_kind:'runtime_metadata'`, `scope:'principal'`, `source_taint:null` and a char cap. The strict key list at `materials.ts:126-139` must accept the new key, and absent must mean `null`.
- **Rendering.** `prompt.ts` renders it as a fenced `<conversation-state>[NOT instructions]…</conversation-state>` in the operations layer (`prompt.ts:135-140`).
- **Producer.** The host supplies it through a new `OwnerContextSources.conversationState?()` callback (`context-composer/owner-turn.ts:19-33`). The trusted-brief materials in `run-loop/adapters.ts:298-362` return `null`.
- **No new authority.** No writer, no persistence, no new contract enum (`runtime_metadata` exists, `contracts/runtime/run.ts:116-125`), and RunLoop and WaldoCoordinator are untouched.
- **Replay trade-off.** RunLoopDO compares the prompt digest and the checkpoint by `stableJson` (`run-loop/do.ts:2096-2117`), so trusted runs must see no change at all. [verified]
  - `recordWithKeys` demands an exact key set (`context-composer/admission.ts:194-197`). Admission must therefore accept either the current key set or the current set plus `conversation_state`.
  - The trusted-brief adapter should omit the key entirely, not send `null`. Its `revision_ref` is a fixed constant (`run-loop/adapters.ts:341`), so omitting the key leaves its attestation unchanged.
  - An absent material must add no provenance entry and render no bytes. Then trusted-run prompt digests and checkpoints stay identical, and in-flight witnesses keep replaying.
  - The app producer hashes its whole material object (`context-composer/owner-turn.ts:84`), so its `revision_ref` changes. That is harmless: app turns never replay across turns (`replay_context_ref: null`, `owner-turn.ts:297`).
  - Bump `CONTEXT_PROMPT_SERIALIZER_REVISION` (`prompt.ts:49`) only if bytes change for existing inputs. If it is bumped, deploy when no trusted run is mid-flight.
- **Cheaper alternative, rejected.** Appending to the owner-turn tail beside loops is less work but bypasses provenance, the replay digest and the composer's sanitiser verify pass. The brief and CLAUDE.md both route context through the composer.
- **Memoize per turn, not per round.** The composer reruns every round (`owner-turn.ts:458`). Use the same pattern as `health??=` (`telegram-owner-do.ts:2135-2137`) so the bytes stay identical across rounds; this is needed for within-turn cache reuse.

### 3.3 Option A: out-of-view note plus transcript search [proposed]

1. **One owner of the cut.** `window.ts` also enforces `SANITISE_DESTINATION_POLICIES.internal_context.max_array_items` (1,024; `contracts/memory/sanitise.ts:61-68`). It returns the stats of what is actually sent. The provider trim (`provider.ts:1428-1460`) becomes a safety net that should never fire, with a content-free counter when it does. Log window stats on every turn, not only when something is dropped (`owner-turn.ts:243`). [Fixes G2's undercount.]
2. **Window before compose.** Reorder `joined-path.ts:64-70` so the joined composition and the published `promptDigest` include the note. On the app path the per-round compose already follows the window; capture the stats with the existing `observers.onWindow` hook (`joined-path.ts:46,70`).
3. **Note content.**
   - Messages out of view, plus messages withheld while a forget completes (counts from the held filter at `owner-turn.ts:417`).
   - The visible horizon.
   - One plain line: out of view is not the same as never said, so search before saying something did not happen.

   A dated horizon needs an **additive optional `createdAt` on new `ConversationEntry` rows** (`conversation-entry.ts:12-27`); legacy rows show as undated, as backfilled episodes already do (`episodes.ts:77`). Coordinate with the app lane: app history reads canonical entries (`telegram-owner-do.ts:668-670`).
4. **Search.** On app turns, bind `search_episodes` to the canonical transcript instead of adding a tool.
   - Keep the same name and argument schema (`tools/live/search-episodes.ts:5-19`). Implement the existing `EpisodeIndex` interface (`episodes.ts:13-19`) over canonical main-chat entries: the second real adapter at that seam.
   - The ref is the entry id. The speaker comes from `role` and `inputOrigin`, never `speakerOf`. Add a date filter once `createdAt` exists, plus paging.
   - Empty results must be truthful: say how many messages were searched over what span, and suggest other terms.
   - Keeping the name keeps it on the `retainedRead` path and reuses the existing held-topic re-read of each hit by ref (`owner-turn.ts:314`, `:328-341`), so forget protection carries over unchanged.
   - Slice 1 scans in memory, with no new persistence. A canonical FTS index is a separate slice because it is a new derived store needing forget scrub coverage.
5. **Prompt.** One guidance line in `MEMORY_MANNERS` (`messaging-behavior.ts:65-68`): when the owner refers to something not in view, search past conversation first; if nothing is found, say so. This is guidance for the model to apply, not a rule.

- **Files:** `conversation/window.ts`, `conversation/joined-path.ts`, `llm/provider.ts` (counter), `channels/owner-turn.ts`, the four context-composer files plus `run-loop/adapters.ts` (shared with C), `channels/telegram-owner-do.ts` (app search binding and source callback), `tools/live/search-episodes.ts` or a new canonical `EpisodeIndex` adapter, `prompt/messaging-behavior.ts`, and optionally `contracts/runtime/conversation-entry.ts` (additive field with zod valid/invalid tests).
- **Cost:** no extra model call. One round (~6 s per the memory note) is added only when the model searches.

### 3.4 Option C: conversation working set [proposed]

- **What.** A bounded list of references derived each turn from the stores that already own them:
  - **pending approvals:** id, kind, status, created, expires, surface shown; from the desk;
  - **last K host receipts:** typed tool, effect, state, ref, time;
  - **open loops:** moved here from the head, so there is one representation;
  - **reminders;**
  - **background runs:** id, status, first line;
  - **recent artifacts:** id, name, time.

  Entries take ADR-0057's entry shape (`entry_id`, `summary` ≤1,000 chars, `source_ref` ≤500 chars, `updated_at`, `source_taint`; `contracts/runtime/working-memory.ts:19-25`) with per-bucket caps. That contract is exported with no runtime consumer. Keep the type runtime-private for slice 1. Persisting a `working_set` table, as the omnipresence design reserves (`docs/planning/OMNIPRESENCE_SEAM_DESIGN_2026-10-10.md:52`), would be the point that needs the ADR-0057 amendment the brief names.
- **Writer.** None. The source aggregates stay the only writers.
- **Privacy and forget.**
  - Ids, kinds, states and times are free to use.
  - Free text may come only from stores that forget already purges (loops, reminders, background runs) or text-free ones (approval presentations), and every row must pass `holdsHeldTopic`, as loops and orders already do (`owner-turn.ts:422-427`).
  - Text from known-gap stores stays out: the ledger summary, artifact names and standing orders (`test/forget-store-table.test.ts:51-60`). Mail-derived titles stay out, following the existing loops rule (`loops.ts:116`).
  - No health values: the free-text health scan is off for null-taint `system_prompt` (`scribe/sanitiser.ts:560-585`), so health must be excluded by construction.
- **Receipts go in the fenced host block, not into assistant history.** Putting the receipt line into `modelPayload` would invite the model to imitate receipt lines in its own replies. [inference]
- **Size.** About 3 KB or less (~750 tokens), with omissions named ("N more; /ledger lists them") as `loops.ts:123` does. At $0.10/M input that is under $0.0001 per call (`pricing.ts:8`). [inference]
- **Files:** new `channels/conversation-state.ts`, a deep module with one function from typed rows, a held filter and caps to text; `channels/telegram-owner-do.ts` (source callback over desk, loops, book, runs and artifacts); `channels/owner-turn.ts` (drop loops from the head); the composer files from 3.2.

### 3.5 Order of work [proposed]

0. **Measure, with no behavior change:**
   - a provider-trim counter;
   - window stats on every turn;
   - `cache_write_tokens` logging;
   - per-section hashes for `tools`, head and tail, to test the minute-clock hypothesis for mid-turn misses;
   - a staging count of owners above 1,024 canonical entries.
1. **A1:** single-owner cut, the note (counts only), canonical-bound `search_episodes`, the prompt line.
2. **C1:** the working set on the app path.
3. **Eval** (3.6). Only then A2 (`createdAt`, dated horizon, temporal search).
4. **Separate tracks, outside C/A:**
   - index canonical entries for nightly with a typed speaker, and arm nightly on first app use;
   - restructure the cache layout: stable head as an initial developer message in `input`, per-turn context after the last reusable breakpoint, block-wise window drops with hysteresis instead of a one-message slide;
   - ADR-0034 `search_tools`;
   - in-turn tool-result clearing;
   - the health quarantine (G12).

### 3.6 Eval that would prove it

**Plumbing tests (CI, scripted gateway).** Run on an app-path harness modelled on `test/owner-turn-context-shape.test.ts:42-60` (workers-pool DO with `createOwnerTurnContext` and a seeded canonical store). L1 cannot see composer fragments because `run-l1.ts:118` drives the Telegram path.

| Test | Asserts |
|---|---|
| P1 note accuracy | Three seeds: (a) 300 long messages over 100k tokens; (b) 1,500 short messages (item cap); (c) a held topic in 3 history messages. The note's dropped and withheld counts equal total minus what the gateway request carried. The provider-trim counter stays 0. |
| P2 working set | A pending approval at turn 3 and receipts at turns 4-6, then 400 filler turns: the reply request still carries the approval id, kind and state and the last receipts. The section stays under its byte cap (`system_sections`). After a forget, a row carrying the topic is gone. Each row cites a real `source_ref`. |
| P3 search | A planted out-of-window fact round-trips through `search_episodes` on app (hit, then ref read). Held-topic hits are withheld, with `withheld_items` reported. Machine entries are never labelled owner. Empty results state the span searched. |
| P4 no persistence | The storage key set before and after a turn differs only by canonical entries and the existing ledger. Neither A nor C writes. |
| P5 stability | With a fixed clock, all rounds of a turn send byte-identical `instructions`, and `conversation_state` is identical across rounds. |
| P6 budget | `request_bytes` grows by less than the note cap plus the working-set cap. |
| P7 replay | An existing trusted-run witness (checkpoint plus prompt digest fixture) still replays through RunLoopDO after the change, and the trusted-brief materials without the new key still pass admission. |

**Quality eval (nightly, live model, LLM judge with reference answers, human spot-check of 10%).** Extend `evals/cases.ts` with a seeded-history field.

- **Seeds:** three synthetic owners with multi-week transcripts over 150k tokens, plus one owner with 1,500 short messages.
  - Synthetic health numbers only.
  - Facts planted at controlled depths: in window, just out, far out.
  - Corrections, temporal anchors, approvals, receipts and artifacts.
  - Forgets, including paraphrased mentions.
- **Arms:** baseline, A, C, A+C on the same seeds.
- **Probes (≥250):** LongMemEval's five abilities (extraction, multi-session, temporal, knowledge update, abstention), plus Waldo cases: "book that one" long after options were listed, "did you send it?", follow-up on a pending approval, forget compliance (literal and paraphrase), and never-said facts.
- **Metrics:**
  - out-of-view recall accuracy;
  - **hallucinated recall**: asserting a specific out-of-view fact with no search call and nothing in view (trace plus judge);
  - search-call rate on out-of-view probes;
  - false "no record" on app;
  - in-window regression;
  - forget leaks in replies and in stored artifacts;
  - stored health numbers (target zero);
  - tokens per turn, p50/p95 latency, cost per turn.
- **Pre-committed bars [proposed]:**
  - A+C against baseline: at least +20 points out-of-view recall;
  - hallucinated recall no higher than baseline and at most 2%;
  - in-window accuracy within 2 points;
  - zero forget leaks over at least 200 probes;
  - tokens per turn up by at most 5%;
  - p50 latency within ±0.5 s.
- **Falsifiers:**
  - A's falsifier: search-call rate below 50% on out-of-view probes.
  - C's falsifier: "that one" and approval-continuity probes still fail after overflow when the referent has a typed record.

### 3.7 Risks

- **A goes unused** (paper finding). C carries continuity; the eval measures the search rate.
- **Lexical search misses paraphrase.** Return truthful empty results; add semantic retrieval only for measured misses, as the build plan already says (`…BUILD_PLAN…:300`).
- **No timestamps** until `createdAt` lands, so temporal probes will fail; slice it explicitly.
- **Stale references.** Derived per turn from authoritative stores; never cached across turns.
- **Prompt growth and cache churn.** Caps, per-turn memoization, and moving loops out of the head.
- **Composer replay.** Render nothing when absent; bump the serializer revision only deliberately.
- **Privacy.** No new persistence in A1 or C1. C's text comes only from purged or text-free stores and passes the held filter. Health is excluded by construction.
- **One caveat on "no new persistence".** Search results return old owner text, which may contain health values the owner typed. That text then flows into the existing tool-event trace logging (`owner-turn.ts:506`) whenever trace text capture is on. The path already exists, but this is a new source of such text. Check the `captureText` setting and `trace_log` persistence in owner environments before shipping A.
- **Scale.** Search adds a second O(N) canonical read per call unless the turn's loaded tree is reused; cache it per turn.

---

## 4. Fixed rules that make judgment calls

I searched runtime `src` for regex and keyword checks over text variables, including `hooks/`, `triage/`, `delivery-gate/`, `loop-governor/`, `channels/reactions.ts` and `channels/task-source-scope.ts`. I found **no regex or keyword classifier deciding tone, intent or topic on owner text in the context path**.

| Rule | Where | Verdict |
|---|---|---|
| Profile selection: newest owner-grounded claims of five kinds; `question` unused | `claims.ts:1014-1031` | **Soft violation**: recency decides relevance. Options: keep a small, stable identity profile (cache-friendly) and leave the rest to the model via `read_memory`, which already exists, or rank by the turn's query. Trade-off: a query-ranked profile changes per turn and costs cache reuse. |
| Oldest-first history drop | `window.ts:44-61` | A budget mechanism, acceptable as a hard bound only if announced (option A) |
| `speakerOf` by id prefix | `episodes.ts:21` | A provenance rule rather than a judgment call, but wrong for `app-N` ids if canonical rows are indexed. Use typed `role` and `inputOrigin`. |
| Per-surface prompt lines filtered by string prefix | `messaging-behavior.ts:87-93` | Not judgment. Brittle coupling: renaming a bullet silently changes the surface prompt. |
| Tool-ledger "summary" = first 500 chars of raw JSON | `owner-turn.ts:508`; `tool-output-ledger.ts:106` | Mechanical truncation, and dead context anyway (G1) |

Allowed under CLAUDE.md's hard-boundary clause, not violations:

- Scribe health patterns. They are scoped off null-taint owner conversation at the `system_prompt`, `internal_context` and `owner_reply` destinations (`sanitiser.ts:53-74`, `:560-585`).
- PII handling. Email, phone and address stay readable at model and owner destinations (`:738-744`); card numbers are always redacted.
- Role-tag escaping on external text only, with no keyword scoring (`:882-905`).
- Forget literal matching.
- Owner-evidence anchoring for task-source transitions, where the decision itself comes from the model (`task-source-scope.ts:100-125`).
- The approval gate (`owner-turn.ts:52-53`).
- Same-call `repeat_refusal` as a bounded-work rule (`tool-loop.ts:114-120`).
- Typed-only receipt checks (`hooks/claim-verify-lint.ts:3-6`; `hooks/receipt-line.ts:3-5`).

---

## 5. Corrections and additions to the brief

1. **"Tool observations are already elided" (brief §1).** They are absent: G1.
2. **"Count real `context_window` drops in staging (`owner-turn.ts:243`)" (brief §4).** That log misses the provider's item, char and bisection cuts, and the item cap likely binds first for short messages. Add the counter (3.5 step 0) before counting.
3. **`cap-history`** is a provider unit test (`test/llm-provider.test.ts:1848`), not a scenario. L1 scenarios run the Telegram path (`scenarios/run-l1.ts:118`), so composer-placed A/C fragments need the app-path harness.
4. **App invisibility.** The brief marked it [I]. It is verified wiring (`telegram-owner-do.ts:2042` vs `:2140`). Nightly is not armed at app setup (`:2027`), though a time-zone write can arm it (`:2654`); either way it reads only legacy episodes.
5. **Caching.** The brief's "history never in a cached prefix" follows from ordinary prefix matching. In addition, `instructions` cannot contain an explicit breakpoint and implicit breakpoints sit at input messages, so the "stable head" gets no breakpoint of its own [doc plus inference]. The sliding window would defeat reuse even after a layout fix.
6. **Line drift:** `telegram-owner-do.ts` 2041→2042, 2139→2140, 2316→2317. `canonical-owner-store.ts:44-61` is now the store factory plus a read at 59-90.
7. **Not a gap.** Reasoning-item replay under `store:false` matches OpenAI's current guidance.
8. **New constraint for A.** `ConversationEntry` has no timestamp, so "last Tuesday" and a dated horizon need an additive field.

---

## 6. Sources (fetched 12 Oct 2026)

- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (29 Sep 2025): context rot and attention budget; just-in-time identifiers; compaction, tool-result clearing as the lightest-touch form, note-taking, sub-agents.
- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (26 Nov 2025): progress file, feature list and git read at session start; compaction alone is not enough.
- Anthropic, [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (11 Sep 2025): fewer, consolidated tools; meaningful identifiers; paginate, filter or truncate with steering messages; 25k-token default in Claude Code.
- Anthropic, [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) (24 Nov 2025): Tool Search with `defer_loading`, ~85% token cut, accuracy gains, compatible with prompt caching.
- Claude docs: [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) (`clear_tool_uses_20250919`: trigger, keep, `clear_at_least`, placeholder, cache invalidation, memory warning); [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) (client-side `/memories`; strip sensitive data; pairs with compaction); [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) (on demand or at a threshold; keeps recent turns; quality degrades with length); [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (tools→system→messages; breakpoint on the last stable block; 5-minute or 1-hour TTL).
- Claude Code docs, [Explore the context window](https://code.claude.com/docs/en/context-window): after compaction, CLAUDE.md, auto memory and the plan are re-injected from disk; MCP schemas are deferred behind tool search.
- OpenAI: [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) (GPT-5.6+, verbatim-checked: implicit or explicit breakpoints, `instructions` cannot contain an explicit breakpoint, 30-minute reuse window, 1.25× writes; also 0.1× reads and `prompt_cache_key` no longer routing, from the fetched summary); [Reasoning](https://developers.openai.com/api/docs/guides/reasoning) (pass reasoning items back; `encrypted_content` by default in stateless mode); [Compaction](https://developers.openai.com/api/docs/guides/compaction) (opaque encrypted item; ZDR-friendly).
- OpenAI Agents SDK, [Sessions](https://openai.github.io/openai-agents-python/sessions/): prepended history, `limit=N`, `OpenAIResponsesCompactionSession`.
- Letta: [Memory blocks](https://docs.letta.com/guides/agents/memory-blocks) (always in context, char-limited, agent-editable); [Dreaming](https://docs.letta.com/guides/agents/architectures/sleeptime) (background consolidation after N steps or at compaction).
- Nous Research Hermes Agent, [Context compression and caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching): compression at 50% (gateway at 85%); protected head and tail; phase-1 tool pruning; iterative summary update; archived turns searchable via `session_search`; `system_and_3` cache breakpoints.
- OpenClaw, [Compaction](https://docs.openclaw.ai/concepts/compaction): summary entry in the transcript with full history on disk; pre-compaction memory flush; `identifierPolicy: strict`; pruning of old tool results per request.
- Fan et al., [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804) (arXiv, 17 Sep 2026; the paper `window.ts` cites).
- Wu et al., [LongMemEval](https://arxiv.org/abs/2410.10813) (ICLR 2025): five abilities; 30% drop over sustained interactions; time-aware query expansion.

## 7. Not verified

- Staging behaviour: real drop counts, cached-token rates, tool-definition bytes and owners above 1,024 entries. The trace fields to read are `context_tools_bytes`, `context_history_messages`, `context_history_bytes` and `context_system_<section>_bytes` (`docs/ops/OBSERVABILITY.md:70`).
- Whether gpt-6-luna follows the GPT-5.6+ caching rules.
- The 56.3% recall-tool figure from the brief.
- ADR-0057, ADR-0034 and ADR-0077 bodies, which live in waldo-brain; I read only titles from `accepted-adrs.json`.
- The Claude Agent SDK compaction reference page (only the SDK overview was reached).
- No test was run; G1 and G10 are code-reading conclusions with stated falsifiers. For G1: record a ledger row, run one app turn and one Telegram turn, and assert the reply `instructions` contain the summary. I expect that to fail today.
