# Long conversations and compaction: design brief

Base `origin/beta-mvp` @ `596706c2`; ADRs from waldo-brain@`be08c4af`. Labels: **[V]** verified-source, **[C]** cited, **[I]** inference. Undated doc pages were fetched 12 Oct 2026.

## 1. What Waldo does today

- **Window:** newest messages within 100k tokens (400k-char ceiling ÷ 4); oldest dropped, never summarised; current turn always kept (`conversation/window.ts:15-27,44-61`). It runs after, and outside, ContextComposer (`conversation/joined-path.ts:64` then `:68-69`); a drop leaves only a content-free log (`channels/owner-turn.ts:242-243`). [V]
- **Stores:** app turns load the whole canonical transcript every turn (`owner-turn.ts:123,557`; `conversation/canonical-owner-store.ts:44-61`). Telegram/WhatsApp use legacy `conv:*`, indexed into FTS5 `episodes` (`channels/telegram-owner-do.ts:2041`; `channels/episodes.ts:66-75`). The canonical store is not wrapped (`telegram-owner-do.ts:2139`) [V], so app chat looks invisible to `search_episodes` and nightly consolidation [I].
- **Saved:** owner text and final reply only (`owner-turn.ts:596-597`). Tool outputs go to a ledger and return as composer fragments (`:598`; `context-composer/types.ts:93-94`), so tool observations are already elided. [V]
- **Prompt/cache:** stable head, then a per-turn tail: memory profile ≤12k chars, REASONS, health zones, clock (`owner-turn.ts:469-479`; `memory/claims.ts:1013-1031`). The clock changes each minute (`prompt/messaging-behavior.ts:116-127`) and rides in `instructions` with `store:false` (`llm/openai.ts:71-76`) [V], so history never sits in a cross-turn cached prefix [I; check `usage.cached`].
- **Memory:** in-turn `remember` (verbatim owner-quote grounding, `replaces_id`), `read_memory`, `forget_memory` (`tools/live/memory.ts:50,76,88`); nightly claim_ops over the newest 40k chars of 24 h (`telegram-owner-do.ts:2316`). Forget redaction is literal and misses paraphrase (`channels/conversation-store.ts:78-82`). [V]
- **Health:** transcript save scrubs only secret URLs (`canonical-owner-store.ts:18-21`); I found no pre-persistence health quarantine on this path, though `docs/planning/waldo-agent-mvp/IMPLEMENTATION_CONTRACTS.md:39` requires one. The `memory_block` and `r2_summary` destinations reject raw and numeric-derived health (`contracts/src/memory/sanitise.ts:349-361`). [V]
- **Planned:** a recap is a cache, never permission; forget invalidates dependent views before the next step; consolidation runs off-path with a source cursor (`docs/planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md:285,297,299`). Overflow should compact into a receipt-keeping summary entry, with a cross-surface working set and `message_refs` (`docs/planning/OMNIPRESENCE_SEAM_DESIGN_2026-10-10.md:44,67`). Thread delete erases transcript and recall index (`contracts/src/app/threads.ts:7-9`; no route yet). [V]

## 2. How others handle it [C]

- **Claude Code:** auto-compacts near the limit; CLAUDE.md, auto memory and plan are re-injected verbatim; recent files re-read ([docs](https://code.claude.com/docs/en/context-window)).
- **Anthropic API:** server compaction returns readable but signed summary text (edits rejected), keeps recent turns, runs in background; context editing clears old tool results ([compaction](https://platform.claude.com/docs/en/build-with-claude/compaction), [on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand), [editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
- **OpenAI:** Responses compaction emits an encrypted item, "not intended to be human-interpretable", ZDR-friendly with `store=false`; Agents SDK sessions prepend history and one variant compacts ([compaction](https://developers.openai.com/api/docs/guides/compaction), [sessions](https://openai.github.io/openai-agents-python/sessions/)).
- **Letta/MemGPT:** always-in-context memory blocks the agent edits by tool; background dreaming consolidates after N steps or on compaction ([MemGPT](https://arxiv.org/abs/2310.08560), [blocks](https://docs.letta.com/guides/agents/memory-blocks), [dreaming](https://docs.letta.com/guides/agents/architectures/sleeptime)).
- **Mem0 (Apr 2025):** extraction reads an async-refreshed summary plus the last 10 messages; the LLM picks ADD/UPDATE/DELETE/NOOP; full context still scored higher (J 72.9 vs 66.9) ([paper](https://arxiv.org/abs/2504.19413)).
- **Zep/Graphiti (Jan 2025):** non-lossy episode store beside a bi-temporal entity graph; LLM-decided invalidation ([paper](https://arxiv.org/abs/2501.13956)).
- **LangMem:** running summary kept in graph state so earlier turns aren't re-summarised; recent messages verbatim ([guide](https://langchain-ai.github.io/langmem/guides/summarization/)).
- **Google ADK:** background compaction every N events with overlap, or at a token threshold keeping recent events; Memory Bank consolidates with an LLM ([compaction](https://adk.dev/context/compaction/), [memory](https://adk.dev/sessions/memory/)).
- **Meta Muse (Sep 2026):** editable Memory.md; forget is best-effort; Meta warns learned information can survive deletion ([help](https://www.meta.com/help/artificial-intelligence/2225571704857152/), [launch](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)).
- **Instinct:** only a competitor's teardown: always-loaded profile, compaction recap, grep retrieval, daily consolidation ([third-party](https://supermemory.ai/blog/reverse-engineering-instinct-memory/)).
- **Research:** in the paper `window.ts` cites, every managed tier removed overflow, elide-then-summarise was cheapest, and 56.3% of recall-enabled settings never called the recall tool, which gave no gain; coding benchmarks only ([2609.20804](https://arxiv.org/abs/2609.20804)). LongMemEval measures a 30% drop over sustained chats ([2410.10813](https://arxiv.org/abs/2410.10813)); ACE finds repeated rewriting erodes detail ([2510.04618](https://arxiv.org/abs/2510.04618)).

## 3. Options

**Rejected up front.** Provider-native compaction: OpenAI's item is opaque to Scribe and forget redaction, and ADR-0077 Option D rejects provider state as authority; Anthropic's signed block can't be redacted in place [I]. Raising the 100k ceiling: needs real token counting (`contracts/src/model/context-budget.ts:17-22`), bills linearly ($0.10/M, 2× past 272k; `llm/pricing.ts:6-8`) [V], and quality falls with length ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/compaction)) [C].

Every option enters through ContextComposer as fenced, typed fragments (context, not instructions or permission); the window must run before compose so its stats reach the composer [I].

| | **A. Visible window + recall** | **B. Model-written recap** | **C. Conversation working set** |
|---|---|---|---|
| Stored where | Nothing new. Fragment: "N earlier messages (dates) out of view"; read-only search tool over the transcript the turn already loads | Append-only, witnessed recap records keyed (conversation, covered-through entry, source digest) in the canonical namespace; raw recent window follows | Bounded refs: cross-surface referents, open loops, pending approvals, verified receipts, each with `source_ref` |
| Writer | None | Canonical-history writer, same run-scope fence; off-reply, idempotent, tool-free `memoryModel` job past a size threshold; what to keep is the model's call | Derived per turn; source aggregates stay the writers. Cross-surface referents need the planned `message_refs` |
| Health, secrets | No new persistence; results reach only owner-channel model context (beta ruling) | Instruction excludes numbers; deterministic `HEALTH_DESTINATION_RULES` reject plus Scribe canary/secret checks on write: hard boundaries, not judgment. On reject keep the prior recap. Never owner-grounding evidence | Refs, not values; any free text passes the same gate |
| Cost, latency | No extra call; +1 round (~6 s) only when the model searches | ~$0.01 and one ~6 s call per compaction, off-path [I]. A missing or invalidated recap falls back to A's view; never blocks a reply | No model call; a few hundred tokens [I] |
| ADR | None; tool schema with valid/invalid tests | New ADR or ADR-0077 amendment (conversation-body storage; ADR-0077 puts the graph in Supabase); sanitiser destination; erase on thread delete; any forget invalidates and regenerates recaps; scope note on ADR-0034:221 | Reuses the ADR-0057 contract shape, but ADR-0057 is per-task and in-run, so it needs an amendment |
| Falsifier | On out-of-window questions the model doesn't search, or answers from absent context | A fabricated owner fact, forget leak, stored number, stale preference beating a correction, decay after ≥3 re-compactions, or no gain over A+C at matched cost | "What did we decide about X?" still fails after overflow when X has no typed record |

## 4. Eval

Synthetic owner, multi-week transcripts over 150k tokens, synthetic health numbers; the same seeds run today's behaviour, A, A+C and A+C+B. Probes, LongMemEval-style plus Waldo cases: cross-window recall, corrected preference, temporal ("last Tuesday"), "book that one" across surfaces, approval and receipt continuity, forget compliance (paraphrase included) in replies and stored artifacts, zero stored numbers, abstention, irrelevant context, an injected "remember X". Plumbing runs in CI on the scripted gateway, extending #915's `cap-history` scenario; quality runs nightly on the live model with an LLM judge and human spot checks. Pre-committed bar for B: ≥10 points over A+C on recall, update and temporal combined; zero leaks over ≥200 probes; no rise in fabrication; unchanged reply latency. First, count real `context_window` drops in staging (`owner-turn.ts:243`); unverified, no staging access.

## 5. Recommendation

C and A now; draft B's ADR now; build B only past the bar.

- The paper `window.ts` cites predicts A's falsifier: in over half the recall-enabled settings, the model never used recall [C]. So C carries the weight because it needs no model initiative, and A is cheap instrumentation, not the answer [I].
- Overflow frequency is unknown. At a few dozen ~1k-char exchanges a day, an active owner crosses 100k tokens in one to three weeks [I].
- B carries the most obligations: paraphrase defeats literal forget, so every forget means regeneration; its summariser reads numeric health; and it needs an ADR [V/I].
- Whether C alone fixes "that one" is unknown [I].

Confidence: about 65% that this order is right; about 45% that A+C alone carries the beta, so B probably follows. About 80% that provider-native compaction is wrong for Waldo.
