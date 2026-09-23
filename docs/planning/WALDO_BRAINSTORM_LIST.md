# Waldo brainstorm list (working draft v1)

Working list for a live session with the owner. It comes from a deep pass over waldo-brain (Mac clone at origin/main 9d3e491, Sep 15, which is 6 commits behind). It is checked against the code on `beta-mvp` (eab3c7b).

What this draft covers:
- 04-Agent-Harness finalization docs
- the per-repo "what Waldo adopts" sections of the 92 repo deep dives in 03-References/repos
- ADR nomenclature
- the earlier reconciliation in `WALDO_BRAIN_RECONCILIATION.md`

Still to read for v2: the 12 HTML pages in full, 03-References/research product dissections, and the ADR index.

Status words:
- **Live**: proven on staging.
- **Built**: code exists, no live proof.
- **Vault only**: designed in waldo-brain, not in code.
- **Open**: no decision yet.

## 1. Missing now (vault decided it, code does not have it)

| # | Item | Vault source | Code state | Why it matters |
|---|---|---|---|---|
| 1 | Episode search (FTS5 over past conversations) | ADR-0033 storage map, hermes, gbrain | Vault only (no fts5 in runtime) | "Remember when…" recall and Monday-pattern questions need keyword search over history |
| 2 | Nightly consolidation ("Dreaming") | openclaw 3-phase dreaming, hermes, kairos tick-and-decide | Vault only (no consolidation module) | Memory grows raw; nothing promotes or decays facts |
| 3 | Memory promotion gates (min score, recall count, unique queries) | openclaw (0.80 / 3 / 3) | Vault only | Guards against one bad day becoming a "fact" |
| 4 | Recency decay and salience in recall | gbrain, paperclip PARA TTLs | Vault only | Old baselines outrank fresh ones |
| 5 | Automated memory-vs-memory contradiction pass | memory-os | Partial (contradiction handling exists; no nightly pass) | Confidence only moves on user feedback today |
| 6 | Interrupted-run truth (mark interrupted, do not pretend done) | deepseek-harness, drover, openharness pending-continuation | Vault only | Silent Morning Brief failures |
| 7 | Context compaction cascade for long threads | ADR-0028, openharness 5-stage | Minimal | Long Telegram threads will hit limits |
| 8 | Degraded-state types (stale, partial, unavailable) surfaced to the user | drover, deepseek-harness | Vault only | Waldo should say "watch data is 9h old" rather than guess |
| 9 | Undo last action | google-adk session rewind | Vault only | Trust for Copilot writes |
| 10 | Steer/interrupt mid-run | pi-mono dual queue, hermes /steer | Partial | User corrections while a run is in flight |
| 11 | MCP client (`call_mcp_tool`) | ADR-0049 | Typed only | Escape hatch for integrations |
| 12 | Privacy proof gates: ADR-0055 deletion walk, ADR-0073 DPIA/consent/subprocessors, ADR-0066 ES256 spike | finalization blockers P0 | Not proven | Needed before real beta users |
| 13 | Voice-in live | this branch | Built, waiting on STT key | Owner's main input mode |
| 14 | Photos/docs live | this branch | Built, needs 4 test messages | Multimodal claim |

## 2. Add or do next (proposal, ranked)

1. Activate voice-in (key → Worker secret → English and Hinglish test).
2. Run the multimodal live proof.
3. Episode FTS search plus a `search_history` tool (small, high value).
4. Nightly consolidation v0: summarise the day's episodes, promote only through gates, and record rationale per promoted fact (agentic-stack, sia).
5. A "recalled memory is authoritative, do not re-derive" line in the prompt (memory-os). This is cheap, but it is a prompt change, so owner review is needed first.
6. Interrupted-run marking plus resume on the next wake.
7. Freshness/degraded flags in the context the model sees, so it can state data age.
8. Wakeup coalescing check: several health events inside 15 min become one message (paperclip). Code has coalescing references; confirm it covers alerts.
9. Undo for Copilot writes (calendar moves) before widening write scope.

## 3. Finalize (decided in principle, needs a final number or text)

- ADR-0009 daily push cap value (proposed 3).
- Delivery policy table values (ADR-0068).
- Personality/prompt proposal (reconciliation doc section 3), pending owner review.
- The Form/Readiness metric, including the Recovery formula (ADR-0081 authority and the Form/Recovery/Weight metric map page).
- Engagement metrics: ADR-0070 KeepRate/WIS, with Telegram reply/tap as the proxy.
- Telegram product residue: blocked-bot policy, onboarding placement, residual-history copy.

## 4. Decide (open)

1. Chat transport for the app: command POST + SSE, or WebSocket (HEY-126; evidence-gated, app parked).
2. Feed: keep Home as composition, or build a persistent Feed (HEY-127).
3. Google restricted-scope verification: start now or after beta? It gates Copilot writes.
4. Default STT provider once keys exist: ElevenLabs Scribe v2 (research winner), or smallest.ai Pulse (free credits).
5. Self-evolution: keep it offline and human-gated (vault stance), or run nothing until evals are un-parked?
6. Sub-agents ("Facets"): Phase 2 or never? Three repos (clawteam, openai-agents-sdk handoff, pipecat-subagents) point at it; the current loop is single-agent.
7. MCP server: stays deferred post-V1 (closed founder call). Confirm it is still deferred.
8. Code execution (`execute_code`): deferred to Phase 3 by ADR-0023/0050. Confirm.

## 5. Vocabulary

### 5a. Conflicting (must settle)

| Term | Conflict | Proposal |
|---|---|---|
| Form vs Readiness Score vs CRS | Handoff v2 says Form, and the same doc also says "Form is dead". Brand standards say Readiness Score. Code and ADR-0081 say CRS/Form. | Pick one user-facing word; keep CRS internal only |
| Patrol | Background analysis vs action log vs brand term | Patrol = the user-visible log of what Waldo did and checked |
| Handoff | Day-plan approval vs any taken-on task | Broader meaning: something Waldo took on, plus its next step |
| Recovery | Formula unconfirmed | Do not surface until confirmed |
| Pup / Pro / Pack | Tier names vs social feature | Owner call |

### 5b. Overloaded (one word, several meanings)

- **Compaction**: context compaction (in-prompt), memory consolidation (nightly), and DO storage compaction (ADR-0056). The vault itself flags this. Proposal: "compaction" = in-prompt only, "consolidation" = nightly, "storage cleanup" = ADR-0056.
- **Dreaming / Dreaming Mode / AutoDream / REM phase**: all mean nightly consolidation. Proposal: one name.
- **Heartbeat**: paperclip (scheduled Hand run), letta (continue-loop flag), 15-min DO alarm. Proposal: drop it from Waldo vocabulary and use "wake".
- **Brief / Morning Wag / Morning Brief**: the same thing under older and newer names.
- **Hands / skills / playbooks / Facets**: proactive features, markdown instructions, exported learnings, and sub-agents. They blur in docs.
- **Hooks**: 10-hook pipeline (openclaw) vs Claude Code hooks vs the runtime `hooks/` directory.
- **L0/L1/L2**: health data layers (openclaw), context tiers (openviking), skill loading (picoclaw), autonomy levels (L2 approval). Four meanings.

### 5c. Dog-themed names to confirm keep or cut

Morning Wag, Fetch Alert, Spots, Woof (auth), Kennel (local repo), Constellation, Pack, Pup. For each: keep as user-facing, internal only, or retire.

### 5d. Likely unnecessary

- The "Facet" family, until sub-agents are decided.
- "Hands", if proactive features are just scheduled wakes plus skills.
- Duplicate phase labels: Phase D/E/F/G vs V1/Alpha/beta vs "Phase 2". Proposal: one release ladder.

## 6. Benchmark against current agents (from the repo deep dives)

| Capability | Leading reference | Waldo now | Gap |
|---|---|---|---|
| Durable run loop + journal | project-think fibers, deepseek-harness | Run journal + loop governor | Interrupted-run truth |
| Loop guard | openfang SHA256 triplets, mercury loop detector | sha256 dedup present | Cross-run no-progress check (ADR-0074) to verify |
| Memory: typed, temporal, confidence | hindsight 4-network, mem0 ADD-only, mempalace halls, zep temporal | Halls, valid_to, confidence | Consolidation, decay, contradiction pass |
| Episode recall | hermes FTS5, gbrain hybrid RRF | Recall module, no FTS | Keyword and hybrid search |
| Pre-reply memory sub-pass | openclaw Active Memory (NONE-or-summary) | Recall-before-act | Comparable |
| Per-turn context injection | openharness, copaw | Context composer | Comparable |
| Compaction | openharness 5-stage, pi-mono auto | Minimal | Build when threads grow |
| Steer/interrupt | pi-mono, hermes | Partial | Finish |
| Scheduling | project-think DO alarms, kairos | Scheduler | Adaptive wake intervals (alive) |
| Voice | Wispr Flow-class dictation | Voice-in built | Live key |
| Self-evolution | hermes-self-evolution, GEPA, hyperagents | None (parked) | Deliberately parked |
| Undo / rewind | google-adk | None | Add before wider writes |
| MCP | pi-mono argues against MCP in core | Typed client only | Fine for V1 |

## 7. Parked by owner (not on this list)

Datasets, evals, experiments, judge model, CI secrets, mobile app, voice out, and Langfuse prompt management.
