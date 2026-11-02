# Dynamic model and provider routing: evidence for the owner's design

2 Nov 2026. Waldo read at `origin/beta-mvp` 37c647cde and draft PR #1639 head 3e005f12. Tags: [fetched] page read, [snippet] search result only, [inference] my reading.

**Products the owner meant [inference].** The 27 Oct ruling cites TypeSafe's **Jev** (typed choices, calibrated confidence), so "Typeface/Gem" is most likely TypeSafe/Jev. The OpenRouter idea is **OpenRouter Auto** (reportedly Not Diamond) and **Not Diamond**.

## (a) What the external routers do

- **OpenRouter Auto** [fetched, [docs](https://openrouter.ai/docs/guides/routing/routers/auto-router.md)]:
  - A lightweight classifier assigns one of about 30 task types. The router ranks models for that type by trailing-7-day spend share, filters by a `cost_tier` band, and returns a primary plus fallbacks.
  - `allowed_models` takes wildcards such as `anthropic/*`. The response `model` field names the model that ran.
  - No router fee; you pay the chosen model's rate. Stickiness is best-effort: it re-ranks each turn and a new task type can switch models.
  - The Not Diamond link is [snippet] only (an older `openrouter/auto`, deprecated). The current page does not mention it.
- **Not Diamond** [fetched, [overview](https://docs.notdiamond.ai/docs/what-is-model-routing), [training](https://docs.notdiamond.ai/docs/router-training-quickstart)]:
  - Predicts the best model per query, with quality, cost and latency modes.
  - Custom routers train on your prompts, each candidate's response and a numeric score: 15 to 10,000 samples, minutes to an hour.
  - Latency claims conflict: under 40 ms (old package page) versus 100-200 ms (a July 2026 third-party directory) [snippet]. No data-handling terms on the pages read.
- **RouteLLM** [fetched, [paper](https://arxiv.org/abs/2406.18665), [repo](https://github.com/lm-sys/RouteLLM)]: strong-versus-weak routing. Router types are matrix factorisation (recommended), weighted Elo, a BERT classifier and a causal-LLM classifier, trained on preference data. The README reports up to 85% cost reduction at 95% of GPT-4 quality on MT Bench, which is a 2024 chat benchmark, not agent turns.
- **Arch-Router** [fetched, [card](https://huggingface.co/katanemo/Arch-Router-1.5B), [paper](https://arxiv.org/abs/2506.16655)]: a 1.5B model that maps a query to your named domain/action routes and emits JSON. New models need no retraining. No published latency; Katanemo licence.
- **Jev** [fetched, [post](https://typesafe.ai/blog/introducing-system-one-models-and-jev)]: typed answers with calibrated confidence. Claims 70-500 ms and $0.042 per million input tokens. Early access, waitlist, no data handling described. It is a decision primitive, not a routing product.
- **OpenAI Decisions API** [fetched, [guide](https://developers.openai.com/api/docs/guides/decisions)]: `POST /v1/decisions`, `gpt-6-luna` only. `choice` questions return `probabilities` and `confidence`. $0.10 per million input, output free, ZDR for eligible customers, EEA or US regional processing at a premium, "about 10x faster than the Responses API".
- **Others:** Martian's docs show caller-chosen models, not automatic routing [fetched]; Unify and Requesty are directory-level only [snippet]; Portkey conditional routing is deterministic rules on metadata and params [fetched, [docs](https://portkey.ai/docs/product/ai-gateway/conditional-routing)].
- **Mature-product patterns:**
  - Anthropic: routing "classifies an input and directs it to a specialized followup", by an LLM or a traditional classifier; easy questions to Haiku-class [fetched, [post](https://www.anthropic.com/engineering/building-effective-agents)].
  - Claude Code: `opusplan` (Opus plans, Sonnet executes), subagents pinned to smaller models, and a warning that a model switch is a cold-cache event [fetched, [model](https://code.claude.com/docs/en/model-config), [caching](https://code.claude.com/docs/en/prompt-caching)]. Its advisor tool sits after the cache breakpoint, keeping the prefix intact.

## (b) Cache and cost facts

- **Anthropic** [fetched, [docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)]: up to 4 breakpoints, prefix order tools, system, messages. TTL 5 minutes (refreshes on hit) or 1 hour. Writes 1.25x or 2x; reads 0.1x, or 0.05x on Opus 5.5 and Sonnet 5.5. Changing tools invalidates everything after. "Each model has its own cache" (Claude Code caching page).
- **OpenAI 6.x** [fetched, [docs](https://developers.openai.com/api/docs/guides/prompt-caching)]: automatic, 1,024-token minimum. Reads 0.1x (0.05x on Sol and Terra); writes 1.25x (30 minutes) or 2.5x (12 hours). `prompt_cache_key` is for accounting. Per-model scope is not stated.
- **Cross-provider:** no shared cache (ADR-0069 §5, quoted at `contracts/src/runtime/routing.ts:10`).
- **OpenRouter** [fetched, [docs](https://openrouter.ai/docs/guides/best-practices/prompt-caching)]: sticky per account, model and conversation, 10-minute idle expiry. Through router models it is best-effort, so the cache may miss.
- **Waldo arithmetic [inference]** from `pricing.ts:12-21` for a 20k-token prefix. The size is an assumption, since nothing has been measured.

| Model | Cold write | Warm read | Output per 1k tokens |
|---|---|---|---|
| Luna / Haiku | $0.0025 | $0.0002 | $0.0005 |
| Terra | $0.025 | $0.001 | $0.005 |
| Sol / Sonnet | $0.05 | $0.002 | $0.010 |
| Opus | $0.10 | $0.004 | $0.020 |

- A cold write costs 25x a warm read on every model. Moving a conversation up to Sol pays about $0.05 once.
- Output price dominates: a cold Luna turn (about $0.003 with 800 output tokens) beats a warm Terra turn (about $0.006), and Terra runs medium effort with a 25k output cap against Luna's low (`roster.ts` `OPENAI_REASONING`), so 800 tokens likely understates Terra. #1639's `warm_cache` rule favours warm Terra on input cost alone, so retest it with output included.
- Caches sit side by side per model, so a Luna detour does not evict Terra's entry: its cost is one Luna cold write, and a return to Terra inside the TTL reads the old prefix. Escalate-only stickiness therefore matters mainly across long gaps and Anthropic's 5-minute TTL, and for any cross-provider move.

## (c) Waldo today (no router on beta-mvp; `llm/router/` is absent)

- **Static tiers:** `roster.ts:38-39` Terra chat, Luna auxiliary; `:42-43` Sonnet and Haiku mirror them; `:49` code default provider is Anthropic, while `wrangler.jsonc:38,115` set `WALDO_MODEL_PROVIDER=openai`. `owner-routes.ts:62` picks the provider, `:70` enables `anthropic_native` caching (16k cap) for Claude chat turns only, `:85` builds primary, then other provider, then template floor.
- **Per-call choice:** owner turns pass no override (`owner-turn.ts:223`). Side jobs pass `auxiliaryModel` (`:879, :925, :1041, :1118`, via `:276`). Tasks use `brief.effort === 'deep' ? chat : auxiliary` (`worker-loop.ts:230`). Past the USD 25 monthly ceiling (`cost-ledger.ts:4`) every call clamps to auxiliary (`owner-turn.ts:820`, `provider.ts:1240`).
- **Cache:** OpenAI key `waldo:<owner>` (`owner-turn.ts:199,312`, `openai.ts:89`); Anthropic system breakpoint plus 3 rolling message breakpoints (`anthropic.ts:211-222`); write tokens read on both (`openai.ts:250`, `anthropic.ts:111-116`) and carried into the ledger (`billed-attempts.ts:11-13`, sync on in staging).
- **Stable prefix:** the system head (behavior, skill catalog, standing orders) changes only when the owner changes it (`prompt/turn-prompt.ts:4-6,60`). Per-message facts, the clock and recalled memory ride in the owner's message (`turn-prompt.ts:16`, `owner-turn.ts:661`), and the clock is read once per turn. So the cached head is stable by design. How much of a 20k prefix it is, is unmeasured.
- **Escalation seam:** ADR-0069 §3 allows only deterministic pre-call escalation predicates (snapshot and intent/counter classes) and states confidence-based escalation was retired (`contracts/src/runtime/routing.ts:66-104`). `ownerRoutePolicy` sets `escalation: []` (`owner-routes.ts`), so none runs on the owner path; whether `provider.ts:350` executes the default rules was not checked. A classifier-confidence router (options 2, 4) therefore needs an ADR-0069 amendment or an explicit reconciliation with it.
- **Audit:** `HARNESS_SIMPLICITY_AUDIT_2026-10-23.md:48` calls `owner-routes.ts` "a provider table, not a router"; `ADR_RECONCILIATION.md:25` keeps one default route and a bounded ladder.
- **Draft PR #1639** (open, unreviewed, last updated 27 Oct, nothing wired, no flag):
  - Adds `routeTurn`, a pure sticky escalate-only choice among light (Luna), standard (Terra) and deep (Sol).
  - Adds a Luna Decisions adapter: last 4 turns, nothing sent if a secret or canary is present, numeric health redacted, 1.5 s timeout, null on any failure.
  - Adds Sol to Opus fallback, `cost-report.mjs --turns`, a synthetic labelled set and a threshold sweep.
  - Open: no wiring, A/B or measured baseline; thresholds unset; security review not done; tiers are OpenAI-only (`policy.ts` `TIER_MODEL`); `warm_cache` untested against output cost; no ZDR or regional parameter. The guide I fetched now confirms the Decisions shape and `confidence`, which #1639 took from unpinned SDK source.

## (d) Design options

| Option | Quality | Cost | Cache | Latency | Complexity |
|---|---|---|---|---|---|
| 1. Static per-purpose table, mirrored for Anthropic | Predictable, not adaptive | Wins on side jobs | Best | None | Lowest |
| 2. Luna classifier at turn start, sticky escalate-only (#1639) | Misroute risk, thin labels | Pays only if light turns are many | One cold write per escalation | Router time beyond context composition, capped at 1.5 s | Medium |
| 3. Cascade: start on Terra, climb on structured signals | Real signal; silent wrong answers slip | Pays for the failed attempt | Cold write on climb | None up front | Medium |
| 4. Escalation as a tool: Terra calls `think_harder`, one Sol or Opus call on a compact brief | Model decides | Small cold prompt | Best: main prefix stays warm | One extra call, only when used | Medium |
| 5. In-house classifier (Gemma 4 on Workers AI, or tuned Arch-Router) | Needs training; no calibrated confidence | Cheap | As option 2 | Unmeasured | High |
| 6. External router (OpenRouter Auto, Not Diamond, Jev) | Pre-trained, popularity-ranked | No fee, but cache loss | Worst: per-request choice | Extra hop | Low to adopt, high to govern |

**Option 6 and the DPA [inference].** Waldo carries Art-9 health data, so any new processor needs a DPA.
- OpenRouter's privacy policy mentions a DPA only conditionally ("If you have a Data Processing Agreement with us", [fetched, [policy](https://openrouter.ai/privacy)]), offers none, never uses "processor", lists no subprocessors, and cites SCCs for EU transfers. Its data guides do not mention a DPA. `data_collection` defaults to `allow`, so Waldo would have to set `deny` and `zdr`. Terms were not read.
- Not Diamond and Jev publish no data-handling terms; Jev is a waitlist product.
- A router also takes model choice, failover and spend ceilings out of ADR-0069, the provider breaker (`owner-do.ts:4458`) and `guard-model-ids`.
- OpenAI is already a processor, so options 2 to 4 add none. Confirm Decisions ZDR eligibility and EEA processing with OpenAI.

## (e) Recommendation

1. **No external router in the owner path.** A new Art-9 processor needs a signed DPA and review, and none is offered; lost cache control adds to it. Use those products only to benchmark on synthetic data.
2. **Ship option 1 now.** Make the per-purpose table explicit and mirror it for Anthropic so the fallback provider has the same tiers. It is mostly built.
3. **Make option 4 the deep path, after reconciling ADR-0069 §3.** A model-called escalation tool fits "judgment belongs to the model" and keeps the main cache warm. Cap it per turn and gate it on the spend ceiling.
4. **Run option 2 as a measured experiment, not a default.** Before wiring #1639: measure cache share and cold turns with `cost-report.mjs --turns`, re-run the sweep with output cost, add the Anthropic mapping, and finish the security review.
5. **Thresholds (my judgment; the owner sets them).**
   - Proceed with option 2 only if light misroutes stay in the low single digits and the staging A/B saves about 20% per turn at equal quality.
   - If Terra cold-turn share is above about 30%, fix caching first.
   - If light turns are under about 20% of volume, drop option 2.
6. **Falsifiers:** a model change in a warm conversation without a confident escalation; any request body carrying a secret, canary or health number; cold turns rising after the flag turns on.

Unverified: OpenRouter terms, whether `provider.ts` runs default escalation rules, real prompt size and turn mix (no Langfuse access), OpenAI per-model cache scope, Not Diamond and Jev data terms, Workers AI classifier latency.
