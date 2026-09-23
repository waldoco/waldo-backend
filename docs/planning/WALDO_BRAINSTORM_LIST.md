# Waldo brainstorm report (final, decision-ready)

This is the working doc for the live brainstorm. Every item is a card with the same fields, so you can answer **Yes / No / Park** fast.

Card fields:
- **What**: the item.
- **Now**: code state on `beta-mvp`.
- **Standard, fitted to us**: how the leading agents do it, mapped onto our architecture (one Durable Object per owner, Telegram first, Supabase, R2, prompts in the repo).
- **Tradeoff**: what we give up or risk.
- **Payoff**: what it buys, tagged:
  - UX: user experience
  - COORD: agent coordination, understanding and orchestration
  - LOOPS: open-loop management
  - LIFE: life management
  - KENNEL: work orchestration through Kennel
- **Harness gain**: the agent capability we get.
- **Brand**: how it fits the Waldo voice and principles.
- **Rec**: my recommendation.

Sources:
- waldo-brain at origin/main 9d3e491 (Sep 15, 6 commits behind; the Mac gh token is invalid):
  - the 12 01-Waldo HTML pages
  - 04-Agent-Harness (finalization blockers, decided-vs-gap)
  - the per-repo adoption sections of the 92 repo deep dives
  - 03-References/research product dissections (Folk, Town, Manus/Lindy/Gumloop/Dust, Paxel, OpenClaw use cases, whole-product convergence)
  - brand-standards.md and the ADR nomenclature handoff
- Code: `packages/runtime/src` on beta-mvp.
- Repo plan: `docs/planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md`.
- Reference repos for agent loops and tool surfaces (reference only, no feature import): Hermes Agent, pi, OpenClaw, and superset-sh/superset (https://github.com/superset-sh/superset), which the owner added on Sep 23. Superset is a local orchestrator for parallel CLI agents over isolated git worktrees, Elastic License 2.0.

## 0. Where we actually stand

The product direction comes from waldo-brain's Technical Brief (July), the whole-product convergence note and the 18 Sep build plan. Waldo is one private personal agent. It understands the person (health is context, not the boundary), acts within permission, verifies what became true, and carries forward what remains. It keeps three states separate:
- **Agent Session**: what a delegated process is doing.
- **Outcome Verification**: whether the evidence meets the goal.
- **Open Loop**: whether the person still owes attention.

Kennel is the specialist-work surface. Waldo proposes, the user authorizes, and Kennel executes and proves.

**Live on staging:**
- Telegram chat with personality.
- Correctable memory files (the model proposes `memory_edits` after each turn).
- Reactions.
- Langfuse tracing.
- Owner-bound DO.
- Delivery gate.
- Scheduler multiplexer.
- Run journal/outbox.
- Loop governor, including a no-progress check.
- Coordinator tables for outcomes, missions, work units, judgment requests and authority grants.

**Built, not proven live:**
- Photos/docs: the owner needs to send 4 test items.
- Voice-in: needs an STT key.

**The biggest gap:** the live Telegram turn cannot call tools. `channels/telegram-turn.ts` lists tool names in the system prompt, but the turn only asks the model for a reply, `memory_edits` and a reaction. It has no tool-call loop. So on Telegram today Waldo can talk and remember, but it can't look anything up, schedule, remind, or touch Calendar/email.

This comes from reading that file; the tool dispatcher exists for the ACL/sanitise checks. The build plan's first release ("real Calendar/email actions, proactive follow-through") depends on closing this gap.

## 1. Decision cards

### A. Capability: let Waldo act

**A1. Tool-calling loop in the chat turn**
- What: the Telegram turn runs a bounded ReAct loop over a small tool set, using the existing ACL, Zod validation, sanitise and loop-governor checks.
- Now: no tool loop in the chat path. The guards exist.
- Standard, fitted to us: Hermes, OpenClaw and pi all run a flat loop with per-trigger tool allowlists. Ours plugs into `tools/dispatcher.ts` checks plus `loop-governor/governor.ts` (SHA256 dedup + no-progress), and journals every call through `run-journal`.
- Tradeoff: more tokens and latency per turn, and a larger prompt-injection surface (recalled content and tool results must stay fenced).
- Payoff:
  - UX: "Already on it" becomes true instead of aspirational.
  - COORD: the precondition for every other card.
  - LIFE: reminders and planning become real.
- Harness gain: an acting agent rather than a chatting one.
- Brand: the resting state "Already on it" and "Waldo did a thing" need actions behind them.
- Rec: **Yes, first.**

**A2. First tool set (proposal: 6)**
- What:
  - `web_search` / `web_fetch` for public research
  - `set_reminder` / `schedule_followup` on the DO scheduler
  - `search_history` (see B1)
  - `calendar_read`
  - `calendar_propose_change`, which asks for approval before writing
  - `draft_message`, a draft only with no send
- Now: none are callable. The 29-name `ToolName` union exists as contract.
- Standard, fitted to us: Folk, Town and Lindy all lead with research, reminders/routines and Calendar/email. Per-trigger ACL (the blueprint lists this as a place Waldo is ahead) keeps the proactive paths narrow.
- Tradeoff:
  - Calendar needs Google OAuth, and restricted scopes need verification (ADR-0075).
  - Search needs a provider key (the blueprint names Brave+Exa).
  - Each tool is an eval surface we haven't built (evals are parked).
- Payoff:
  - LIFE: realistic day planning.
  - LOOPS: follow-ups actually fire.
  - UX: answers backed by current facts.
- Harness gain: grounded answers plus time-based initiative.
- Brand: "always give the reason" means tool results give Waldo reasons to cite.
- Rec: **Yes.** Which search provider is your call.

**A3. Approval step for any external effect (the "door")**
- What: writes and sends go through a Telegram inline button (approve/edit/skip) that records a judgment_decision.
- Now: `judgment_requests`/`authority_grants` tables exist. No Telegram button flow.
- Standard, fitted to us: Google ADK tool confirmation, Kennel's "user alone Accepts", Claude Code permissions.
- Tradeoff: an extra tap per action. Standing grants reduce taps but need a clear scope record.
- Payoff:
  - UX: trust.
  - COORD: a single authority path shared by chat, proactive runs and Kennel.
- Harness gain: human-in-the-loop that is durable and auditable.
- Brand: literally Golden Rule 4, "Always offer the door".
- Rec: **Yes, with A2.**

**A4. Undo last action**
- What: a 10-minute "undo" on calendar moves and sends where the provider allows it.
- Standard: ADK session rewind.
- Tradeoff: not every effect can be reversed (a sent email can't). The honest UI says so.
- Payoff: UX trust. It lowers the cost of saying yes to A3.
- Rec: **Park until A2 writes exist.**

**A5. MCP client**
- What: `call_mcp_tool` as an escape hatch for long-tail integrations (ADR-0049).
- Now: typed only.
- Standard: pi deliberately keeps MCP out of core. Hermes/OpenClaw support it as optional.
- Tradeoff: a supply-chain and injection surface, since MCP servers are unaudited.
- Payoff: COORD breadth without per-provider adapters.
- Rec: **Park.** Direct adapters first. The MCP server stays deferred (closed founder call).

### B. Memory and understanding

**B1. Search over past conversations (FTS5 on episodes)**
- What: SQLite FTS5 over the DO `episodes` table, exposed as `search_history`.
- Now: the `episodes` table exists. No FTS.
- Standard, fitted to us: Hermes FTS5 on the session DB. gbrain hybrid RRF (K=60) comes later. DO SQLite supports FTS5 natively.
- Tradeoff: storage growth, and ADR-0056 compaction eventually.
- Payoff:
  - UX: "what did I say about X" works.
  - COORD: grounded recall.
  - LOOPS: finds commitments you mentioned in passing.
- Rec: **Yes.** Small slice.

**B2. Nightly consolidation ("Dreaming")**
- What: a DO alarm at a local night hour runs tick-and-decide (skip when there's nothing new). It summarises the day's episodes into facts, with a promotion gate (seen more than once, rationale recorded) and a decay rule.
- Now: not built. Memory is markdown core files edited per turn.
- Standard, fitted to us:
  - OpenClaw Light/Deep dreaming with promotion gates 0.80 / 3 recalls / 3 unique queries
  - Kairos tick-and-decide
  - Hermes structured compression
  - Hindsight's separation of world/experience/opinion/observation, with confidence
- Tradeoff: nightly model cost per user. A bad promotion bakes in a wrong "fact", so every promoted fact needs rationale plus correction.
- Payoff:
  - COORD: Waldo understands patterns ("your Mondays run long").
  - LIFE: weekly patterns.
  - UX: less repetition.
- Harness gain: learning over time without self-evolution.
- Brand: "Silence is the default" means consolidation is invisible unless it changes a recommendation.
- Rec: **Yes, v0 after A1/A2.**

**B3. "Recalled memory is authoritative" prompt line**
- What: one prompt line (from memory-os). The fence stays.
- Tradeoff: a stale memory gets believed. Needs B2 or correction to keep memory fresh.
- Rec: **Yes, but it's a prompt change: needs your review.**

**B4. Contradiction pass**
- What: nightly check of memory against memory. Contradicting facts lower confidence or get a short question to you.
- Now: confidence only moves from feedback.
- Tradeoff: an extra call. Asking too often breaks "silence is the default".
- Rec: **Fold into B2.** Ask at most once a week.

**B5. Health context in planning**
- What: Readiness/Form feeds the plan and the Brief, with self-report fallback when there's no wearable (per the build plan).
- Now: `get_crs` exists as a tool name. The Form/Recovery/Weight formula map is in waldo-brain. The Recovery formula is unconfirmed.
- Tradeoff: low-SNR signal. The Build Architecture page names trust as the #1 quality attribute (<1 bad proactive message per user per week), and "one false alarm > ten correct silences".
- Payoff: LIFE is the differentiator. This is the "body as universal context" thesis.
- Brand: health-forward, never clinical. The brand bans clinical language.
- Rec: **Decide: self-report first (cheap, now), or wait for the app's HealthKit.**

### C. Harness reliability

**C1. Honest interrupted runs**
- What: when a DO dies mid-run, mark the run `interrupted`, resume or tell the user on the next wake, and never pretend it completed.
- Standard: deepseek-harness, Drover, openharness pending-continuation.
- Now: journal/outbox exist. No interrupted state.
- Tradeoff: one more lifecycle state in every consumer.
- Payoff: UX (no silent missed Briefs), LOOPS (nothing drops).
- Rec: **Yes, with A1** (tool runs make interruptions likelier).

**C2. Freshness and degraded flags**
- What: every context block carries its age and source state. The model says "watch data is 9h old" instead of guessing.
- Standard: Drover's "degraded mode as a type".
- Tradeoff: prompt tokens.
- Payoff: trust.
- Brand: "always give the reason".
- Rec: **Yes.**

**C3. Alert coalescing**
- What: several events inside a window become one message.
- Now: not built. The v1 list was wrong here: the grep hit was SQL `coalesce`.
- Standard: Paperclip wakeup coalescing, 15 min.
- Tradeoff: slight delay on the second event.
- Payoff: UX, and respects the ADR-0009 push cap.
- Brand: silence default.
- Rec: **Yes, when proactive alerts ship.**

**C4. Thread compaction**
- What: in-prompt compaction for long Telegram threads.
- Standard: openharness 5-stage, pi auto-compaction.
- Tradeoff: a summary loses detail.
- Rec: **Park until threads get long.** Track token size in Langfuse.

**C5. Steer/interrupt mid-run**
- What: a new Telegram message while a run is active steers or cancels it.
- Now: the execution-environment port has `steer`, but work units mark it unsupported.
- Standard: pi dual queue, Hermes `/steer`.
- Tradeoff: concurrency complexity in the DO.
- Payoff: UX, COORD.
- Rec: **Yes, after A1.**

**C6. Model routing / escalation**
- What: a cheap model for routine turns, escalating on hard ones (ADR-0069 route policy).
- Now: roster and gateway exist.
- Tradeoff: quality variance.
- Payoff: cost per completed task (Founder Canvas metric).
- Rec: **Decide the default live model and escalation rule.**

### D. Open loops and life management

**D1. Open-loop ledger**
- What: a durable list of what you still owe or are waiting on (commitments from chat, pending approvals, unanswered follow-ups). Each item has a next step and a stop condition.
- Now: coordinator `outcomes` and `judgment_requests` tables exist. No user-facing ledger in chat.
- Standard, fitted to us: Town Tasks and "Need to Know", Kennel's separate open-loop contract, OpenClaw commitments (max 3/day).
- Tradeoff: capture precision. Too many loops is nagging.
- Payoff: LOOPS is the core. LIFE. KENNEL shares the same shape as Kennel outcomes.
- Harness gain: Waldo carries things forward.
- Brand: this is what "Handoff" should mean (see vocabulary).
- Rec: **Yes.** It's the product's spine per the Technical Brief.

**D2. Daily Brief (morning)**
- What: one proactive morning message covering plan, energy, open loops and the one decision needed.
- Now: the delivery gate and scheduler exist. No live Brief on Telegram.
- Tradeoff: one push per day of the cap. It has to be right most days.
- Payoff: UX and LIFE daily habit.
- Brand: "Good morning", reasons given, wit once.
- Rec: **Yes, after A2+D1.**

**D3. Weekly review ("A Good Week")**
- What: a weekly recap of closed loops and patterns.
- Rec: **Park until B2.**

**D4. Real follow-up handling**
- What: prepare the follow-up, get exact send approval, send, watch the thread, stop on reply. This is the build plan's showcase row.
- Tradeoff: needs Gmail OAuth plus the send-approval flow (A3).
- Payoff: LOOPS, UX.
- Rec: **Yes, after A3.**

### E. Work orchestration through Kennel

**E1. Waldo → Kennel handoff (K0 bounded proof)**
- What: Waldo turns a stated work goal into a Kennel Outcome. Kennel runs the Contract → Plan → authorize → Attempt → checks cycle. Only the decisions come back to Telegram, and the run survives the laptop disconnecting.
- Now: backend has `outcomes`/`missions`/`work_units`/`planning_*`/`execution_*` tables and the coordinator modules. Kennel is on `outcome-loop`, pre-launch.
- Standard, fitted to us: Medley `/mission`, Factory Missions, AO reactions. The line you accepted: collaboration between providers goes through artifacts (Contract, Plan, receipts, proof), never private agent-to-agent chat.
- Tradeoff: two moving products. The build plan's H2 warns that users may mostly value personal follow-through, with Kennel adding little outside technical users.
- Payoff: KENNEL is the unique joint loop. COORD. LOOPS: one ledger across life and work.
- Harness gain: specialist execution with proof.
- Brand: "The provider never accepts the Outcome": Waldo verifies before it says done.
- Rec: **Decide scope: showcase-only K0, or a first-class beta feature.**

**E2. Shared outcome/open-loop contract across both repos**
- What: one typed Outcome / OpenLoop / JudgmentRequest schema in `packages/contracts`, consumed by Kennel.
- Tradeoff: cross-repo versioning.
- Payoff: COORD. No translation layer.
- Rec: **Yes, if E1 is Yes.**

### F. UX, channels and delivery

**F1. Voice-in live**
- Built; needs `ELEVENLABS_API_KEY` or `SMALLEST_AI_API_KEY`.
- Rec: **Yes. Pick the default key** (Scribe v2 for Hinglish accuracy, or smallest.ai for the free credits).

**F2. Photos/docs live proof**
- Built. You send a photo, a screenshot, a PDF and an image with a caption.
- Rec: **Yes.**

**F3. Push cap and delivery policy numbers**
- ADR-0009 proposes 3 per day. ADR-0068 has the table.
- Tradeoff: fewer pushes is higher trust but more misses.
- Rec: **Finalize: 3 per day, Brief counts as 1.**

**F4. Web dashboard**
- In the build plan's destination.
- Rec: **Park.** The mobile app is also parked.

**F5. Waldo-to-Waldo coordination**
- What: people's Waldos coordinate with each other. Folk does this with consent.
- Rec: **Park.** Destination item.

### G. Trust, privacy, safety

**G1. Privacy proof gates**
- ADR-0055 deletion walk, ADR-0073 DPIA/consent/subprocessors, ADR-0066 ES256 staging proof. All P0 in the finalization board.
- Tradeoff: time with no feature payoff.
- Payoff: required before invited users.
- Rec: **Yes, before external users.** Not needed for owner-only use.

**G2. Injection containment**
- Fence recalled memory and tool results, and follow the deny-by-default egress allowlist (already a dispatcher check).
- Rec: **Yes, part of A1.**

**G3. Self-evolution**
- Hermes-self-evolution, GEPA, hyperagents. The vault says offline and human-gated.
- Rec: **Park** (evals are parked).

## 2. Brand policies applied to every card

These come from brand-standards.md plus your standing rules:

1. Always give the reason.
2. Wit once, then stop.
3. Never self-congratulate.
4. Always offer the door.
5. "Good morning", not "Morning".
6. Silence is the default.

Mandates:
- The core notification is "Waldo did a thing."
- The resting state is "Already on it."
- The dog never speaks.
- Casing is "Waldo"/"waldo", never "WALDO".

Never sound like a productivity app, doctor, wellness brand, tech startup or coach.

Your rules:
- Health-forward; gate only clinical acts.
- No regex or rigid rules for judgment; the model decides, and deterministic rejects cover hard security lines only.
- Prompts live in the repo, and personality changes get your review.

## 3. Vocabulary decisions

| Term | Conflict | Proposal (say yes/no) |
|---|---|---|
| Daily Brief / Morning Wag / Morning Brief | Brand renamed Wag to Daily Brief; old ADRs still say Morning Wag | **Daily Brief** everywhere |
| Readiness Score / Form / CRS | Brand says Readiness Score; the handoff says Form and also "Form is dead"; code says CRS | **Readiness** user-facing; CRS internal only |
| Patrol | Brand: "24/7 watch". Handoff: action log | **Patrol = the visible log of what Waldo watched and did** |
| Adjustment / Fetch / Fetch Alert | Brand renamed Fetch to Adjustment; code/ADRs keep Fetch Alert | **Adjustment** for changes Waldo makes; a plain "alert" for warnings |
| Handoff | Day-plan approval vs anything Waldo took on | **Handoff = a loop Waldo took on, with its next step** (D1) |
| Open loop / Outcome / Session | Clear in the Technical Brief, not used in the bot | Adopt the three-state split internally. Surface only "open loops" |
| Recovery | Formula unconfirmed | Don't show until confirmed |
| Pup / Pro / Pack | Tiers | Keep (brand locked) |
| A Good Week | Weekly recap | Keep for D3 |
| Compaction | 3 meanings | compaction = in-prompt; consolidation = nightly; storage cleanup = ADR-0056 |
| Dreaming / AutoDream / REM | Same thing | **Nightly consolidation** internally. Never user-facing |
| Heartbeat | 3 meanings | Drop; use "wake" |
| Hands / skills / playbooks / Facets | Blur | Keep **skills** (markdown). Drop Hands and Facets until sub-agents are decided |
| L0/L1/L2 | 4 meanings | Rename: data tiers, context tiers, autonomy levels |
| Phases D/E/F/G vs V1/Alpha/beta vs Phase 2 | 3 ladders | One ladder: owner → invited beta → public |
| Spots, Constellation, Woof, Kennel | Dog names | Keep Kennel (product) and Spots. Woof internal. Constellation: park |

## 4. Benchmark against current agents

| Capability | Best reference | Waldo now | After Yes-cards |
|---|---|---|---|
| Acting on tools | Hermes, OpenClaw, Folk, Lindy | Talk + memory only | A1-A3 |
| Durable per-user runtime | project-think (DO), Folk per-user computer | DO per owner: ahead | same |
| Memory: correctable, typed | Town editable profile, Hindsight, mem0 | Correctable files | + B1, B2 |
| History recall | Hermes FTS5 | None | B1 |
| Proactive routines | Town routines, OpenClaw commitments | Scheduler, no routine live | D2, D4 |
| Open-loop tracking | Town Tasks, Kennel | Tables only | D1 |
| Human approval | ADK, Kennel Accept | Tables only | A3 |
| Loop guard | OpenFang, Mercury | Built: on par | same |
| Multimodal in | Folk, Town | Built (voice + photos) | live proof |
| Work orchestration with proof | Medley, Factory, AO | Coordinator tables; Kennel pre-launch | E1 |
| Cross-person agents | Folk | None | Park |
| Health as context | none of them do it well | Formula mapped, not live | B5 is the differentiator |

The honest position: most primitives exist elsewhere (OpenClaw use-case note). The edge is combining them into one governed continuity service: health-aware planning, one open-loop ledger across life and work, and verified Kennel outcomes. Each piece on its own is not an edge.

## 5. Quick yes/no list

1. A1 tool loop in chat: yes / no
2. A2 first 6 tools; search provider?
3. A3 approval buttons: yes / no
4. B1 history search: yes / no
5. B2 nightly consolidation v0: yes / no
6. B3 prompt line (review the text)
7. B5 health: self-report now, or wait for HealthKit?
8. C1 + C2 honest states: yes / no
9. C6 default model + escalation rule
10. D1 open-loop ledger: yes / no
11. D2 Daily Brief: yes / no
12. E1 Kennel: showcase-only, or beta feature?
13. F1 STT default key
14. F3 push cap 3 per day
15. G1 privacy gates before invited users: yes / no
16. Vocabulary table: accept row by row

## 6. Proposed build order (if the above are Yes)

1. F1/F2 live proof (needs your key and test messages).
2. A1 + G2 + C1.
3. A2 read tools (search, history, reminders, calendar read) + A3.
4. D1 open-loop ledger.
5. D2 Daily Brief + C2 + C3.
6. B2 nightly consolidation v0 + B4.
7. A2 write tools (calendar change, drafts) + D4 follow-ups.
8. E1 Kennel K0 + E2 contract.
9. G1 before any invited users.

## 7. Parked by you

Datasets, evals, experiments, judge model, CI secrets, mobile app, voice out, and Langfuse prompt management.

## 8. Caveats

- waldo-brain snapshot is 6 commits behind origin (Mac gh token invalid).
- Code states come from reading the named files and targeted greps, not an exhaustive audit.
- Nothing here changes the live worker. The prompt proposal in `WALDO_BRAIN_RECONCILIATION.md` section 3 is still unapplied, pending your review.
