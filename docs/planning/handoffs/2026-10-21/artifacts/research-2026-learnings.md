# What 2026 taught about building agents like Waldo (21 Oct 2026)

[n] is the list in (c). [unverified] means I could not open the primary page.

## (a) Learnings

1. **Message metadata is an injection channel.** [1] 10 Jun 2026: OpenClaw was injected through WhatsApp contact names, vCard name fields and location labels, and default memory made a single injection persist. The fix moved those fields into a structured untrusted-metadata channel. *For Waldo:* every webhook field the owner did not type (profile name, vCard, location, quoted message, email sender name) enters context as delimited untrusted data; memory it produces carries provenance.
2. **Persistence comes from configuration the agent can change.** [2] 4 Feb 2026: a document with a zero-click injection made OpenClaw add an attacker's chat integration, rewrite its always-loaded context file, and schedule a task that kept rewriting it. *For Waldo:* no turn that has read untrusted content may create channel relinks, grants, schedules or self-instructions without out-of-band owner approval.
3. **Deterministic out-of-band policy beats detection, so far.** [3] 25 Jun 2026: Progent cut AgentDojo attack success from 25.8% to 4.2%, and an adaptive attack did not raise it. The study is small, on a 7B model. OpenAI's Lockdown Mode [4] (13 Feb 2026, [unverified]) cuts live web and connectors yet doesn't eliminate risk. *For Waldo:* confirms grant rechecks at dispatch. Consider a per-owner lockdown switch that drops the fetch and browser rungs.
4. **iMessage distribution has trust conditions.** [5] 4 Jun 2026: Apple approved Poke for Messages for Business only after Poke proved live human support and clear AI labelling. It has relayed ~100M messages since March. *For Waldo:* the "human" rung and AI disclosure must ship as features.
5. **Personal context is opt-in, and over-personalization is a named failure.** [6] 14 Jan 2026: Google keeps app connections off by default, with a choice per app. It admits that it links unrelated topics, and avoids proactive assumptions about health. *For Waldo:* add an over-personalization eval and an "answer without memory" path.
6. **Health gets its own memory boundary.** ChatGPT Health [7] (pilot Jan 2026; open to US users 23 Jul 2026 [8]; OpenAI pages [unverified]) keeps separate memories, makes cross-chat use opt-in, and creates no memories directly from Apple Health data. Claude [9] (25 Aug 2026) keeps health out of memory unless the user opts in, then notifies on each save. *For Waldo:* see (b)3.
7. **Timing is its own problem.** ProAgentBench [10] (4 Feb 2026): memory and real data improve timing prediction. Liu et al. [11] (28 May 2026): a small graph-based trigger had the best AUC among nine trigger designs (its own included) and added 16.7 F1 points across 14 LLMs. *For Waldo:* score "should Waldo speak now?" on real traces by false-interrupt and missed-moment rates.
8. **One brain, disposable hands, separate evaluator.** [12] 8 Apr 2026: a stateless harness resumes from an append-only log, and credentials never enter the sandbox. [13] 24 Mar 2026: generators overrate their own work, a separate skeptical evaluator helps, and scaffolding was dropped as models improved. *For Waldo:* confirms OwnerDO plus workers. Test that a worker crash mid-errand causes no duplicate effect; re-justify rules per model upgrade.
9. **Cache-stable prefixes are now in the spec.** MCP [14] says servers SHOULD order tools deterministically for cache hits. OpenAI's Codex post [15] (23 Jan 2026, [unverified]): each prompt must exactly extend the last. Server-side compaction is in beta [16]. *For Waldo:* add a test that prefix bytes stay identical across turns, including after tool discovery.
10. **Cheap executor, strong advisor.** [17] 9 Apr 2026: Haiku with an Opus advisor scored 41.2% on BrowseComp, against 19.7% alone. *For Waldo:* confirms the router. Cap calls with `max_uses`.
11. **pass^k and outcome grading.** [18] 9 Jan 2026: grade the end state rather than the path, and calibrate judges against humans. Give each judge one dimension and an "Unknown" option. *For Waldo:* confirmed.
12. **Judges miss state that spans turns.** [19] 9 Jun 2026 (one production agent): the judge caught under a quarter of the defects humans found, missed confirm-gate lockout, and filed 113 of 114 state defects as "brand voice". [20] 17 Jun 2026: exact-match agreement overstated judge quality by 33–41 points against kappa. *For Waldo:* add judge axes for approval state, open loops and recovery, wired to hard assertions. Report kappa against owner labels.
13. **Multi-part requests break agents.** τ³-bench [21] (18 Mar 2026): agents scored about 25% on knowledge tasks and 26–38% on voice, against about 85% on text. They complete part of a request and drop the rest. *For Waldo:* errand evals need multi-part asks, voice notes and forced-failure recovery.
14. **Stale memory is the hard problem.** STALE [22] (7 May 2026): the best model scored 55.2%, and models accept stale premises. MemDelta [23] (29 Jun 2026): agent-written memory scored 42% against 47% for basic retrieval, and an embedding swap moved accuracy 6.2 points. LongMemEval-V2 [24] (12 May 2026): agentic file search scored 72.5% against 48.5% for RAG. *For Waldo:* supersede memories at write time, test premise resistance, baseline against raw-history search.
15. **MCP went stateless.** [14] 28 Jul 2026: sessions are gone and elicitation works by `input_required` retries. Dynamic Client Registration is deprecated, and `iss` validation is required. *For Waldo:* audit connectors, and map approvals onto `input_required`.
16. **Regulation.** FDA's 6 Jan 2026 guidance loosens rules for wellness-only wearable claims [25] (summary and FDA text [unverified]). EU Omnibus [26]: Annex III to 2 Dec 2027; final publication and Art 50(1) timing [unverified]. DPDP: consent managers 13 Nov 2026 [27]; main duties 13 May 2027, with an unconfirmed proposal to pull them to Nov 2026 [28]. *For Waldo:* wellness-only claims, AI disclosure on every channel now, erasure ready by Nov 2026.

## (b) Contradictions

1. **WhatsApp.** Meta's terms barring general-purpose AI assistants from the Business API took effect 15 Jan 2026 [29]. Italy ordered a suspension [30], and Europe reportedly got paid access [31] (date [unverified]). I found no India exemption and nothing dated after March. Waldo's Indian WhatsApp presence is exposed [inference].
2. **Memory.** 2026 evidence favors agentic search over raw history [24][21] and puts model-written memory below retrieval [23].
3. **Health memory.** The industry default is opt-in health memory with notice [9][7]. Are Waldo's pattern writes opt-in and visible to the owner?
4. **Judge-only pass^k** lets approval-state defects through [19].
5. **Connectors** that use DCR or session ids are on deprecated or removed paths [14].

## Tool engineering

**Shape.** Build task-shaped tools and namespace them by service [32]. Merge calls that always run in sequence, and never ask the model for values the code already knows [33].

**Inputs.** Make schemas strict (`additionalProperties:false`, every field required, enums) [33]. 1–5 examples lifted complex-parameter accuracy 72%→90% [34], though examples can hurt reasoning models [33].

**Outputs.** Return names rather than UUIDs, and offer a concise mode (72 tokens against 206 for detailed). Paginate and cap output with guidance on narrowing [32]. Authorize state handles on every call [14].

**Errors.** Return `isError` with the fix [14][32].

**Writes.** A broken stream must be re-issued with a new id [14], so deduplication needs an application key [inference]. Clients SHOULD show the inputs before a call [14]. I found no 2026 source on dry-run.

**Annotations.** These are hints only. Never decide on hints from untrusted servers [14].

**Tool count.** Tool search raised Opus 4 tool selection from 49% to 74%; use it above about 10 tools, and keep 3–5 loaded [34]. OpenAI's soft limit is under 20 [33].

**Code mode.** Cloudflare fits 2,500 endpoints into 2 tools (~1,000 tokens), running code in an isolate with no env, no filesystem and egress off [35, 20 Feb 2026]. It wins on chained calls. Security cost: generated code runs with connector credentials, so one injection steers a whole program [inference]. A lead for the sandbox rung.

**Evaluation.** Held-out real tasks, read transcripts, let the model refactor tools [32].

**Parallel calls.** Use `parallel_tool_calls:false` to allow at most one call per turn [33]. I found no 2026 source on failure modes.

**Checklist**
1. Every write takes an application idempotency key rather than the transport id; a replay returns the original receipt [14][inference].
2. The approval card shows the frozen arguments, and dispatch rejects a changed digest ([14] + Waldo rule).
3. Approval decisions ignore third-party annotations [14].
4. Schemas are strict, with a Zod pair of a valid and an invalid case ([33] + ADR-0029).
5. No tool asks the model for owner id, time zone or tokens [33].
6. List tools paginate and cap at 25k tokens [32].
7. Outputs show names, not ids [32].
8. Validation errors carry a fix, and a test proves the retry succeeds [14][32].
9. Tool order is deterministic, with no more than 10–20 tools loaded [14][34].
10. Ship only after a held-out pass^k eval with transcripts read [18][32].

## (c) Sources
1 imperva.com/blog/compromise-openclaw-with-prompt-injections-in-message-objects/
2 labs.zenity.io/p/openclaw-or-opendoor-indirect-prompt-injection-makes-openclaw-vulnerable-to-backdoors-and-much-more
3 arxiv.org/abs/2606.26479
4 openai.com/index/introducing-lockdown-mode-and-elevated-risk-labels-in-chatgpt/
5 techcrunch.com/2026/06/04/apple-approves-poke-as-the-first-ai-agent-on-its-messages-for-business-platform/
6 blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/
7 openai.com/index/introducing-chatgpt-health/; help.openai.com/en/articles/20001036
8 iclarified.com/101568/openai-launches-chatgpt-health-to-all-us-users-with-apple-health-integration
9 claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it
10 arxiv.org/abs/2602.04482
11 arxiv.org/abs/2605.30152
12 anthropic.com/engineering/managed-agents
13 anthropic.com/engineering/harness-design-long-running-apps
14 modelcontextprotocol.io/specification/2026-07-28/changelog (+ /server/tools, /schema)
15 openai.com/index/unrolling-the-codex-agent-loop/
16 platform.claude.com/docs/en/build-with-claude/compaction (docs, accessed 21 Oct 2026, [unverified])
17 claude.com/blog/the-advisor-strategy
18 anthropic.com/engineering/demystifying-evals-for-ai-agents
19 arxiv.org/abs/2606.10315
20 arxiv.org/abs/2606.19544
21 sierra.ai/blog/bench-advancing-agent-benchmarking-to-knowledge-and-voice
22 arxiv.org/abs/2605.06527
23 arxiv.org/abs/2606.29914
24 arxiv.org/abs/2605.12493
25 cooley.com/news/insight/2026/2026-01-20-fda-opens-aperture-for-wearables-in-latest-general-wellness-guidance (20 Jan 2026, [unverified])
26 datamatters.sidley.com/2026/06/22/eu-lawmakers-reach-provisional-agreement-to-delay-key-eu-ai-act-obligations/
27 mondaq.com/dpdp-act-and-rules-2025-the-2026-compliance-milestones-businesses-cant-afford-to-miss/1830402 (14 Aug 2026)
28 takshashila.org.in/content/blogs/20260126-meity-considers-reducing-dpdpa-compliance-timelines.html (26 Jan 2026, [unverified])
29 techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform (18 Oct 2025; update says effective 15 Jan 2026)
30 techcrunch.com/2025/12/24/italy-tells-meta-to-suspend-its-policy-that-bans-rival-ai-chatbots-from-whatsapp/ (24 Dec 2025, [unverified])
31 storyboard18.com/brand-makers/meta-to-allow-rival-ai-chatbots-on-whatsapp-in-europe-for-12-months-amid-eu-probe-2-91405.htm ([unverified] date)
32 anthropic.com/engineering/writing-tools-for-agents (11 Sep 2025)
33 developers.openai.com/api/docs/guides/function-calling (docs, accessed 21 Oct 2026)
34 anthropic.com/engineering/advanced-tool-use (24 Nov 2025)
35 blog.cloudflare.com/code-mode-mcp/

Not covered: 2026 posts from Google ADK, LangChain, Cognition, HumanLayer, Manus; primary 2026 browser-agent reliability numbers (only vendor/aggregator figures found); Oura/WHOOP release notes.
