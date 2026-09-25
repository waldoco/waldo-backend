# Waldo-Brain Archive Audit (2026-09-25)

Owner ask (12:44 iMessage): deep-dive the old waldo-brain research archive
(github.com/Pin4sf/waldo-brain, 01-Waldo/engineering + planning) against the current
implementation - forgotten strong points, things better thought-out before, anything to
adopt for architecture, infra, capabilities, creativity.

Method: full clone, read of the engineering corpus (agent-os, agent-intelligence,
agent-workspace-vision, security-reliability, second-brain-architecture, agent-os-deep-dive,
connector-*, messaging/scaling/data-architecture) with current-code verification for each
claim (greps against packages/runtime + packages/contracts, not memory of the build).
Per idea: ALREADY BUILT / PLANNED / ADOPT (genuinely worth taking now) / DROPPED-CORRECTLY.

## The headline

The archive's March 31 thesis - "workspace-level agent power at consumer scale is the
unsolved moat" (agent-workspace-vision.md) - is the SAME gap this morning's Cloudflare
audit found independently from the other direction (agent working artifacts). Two
investigations, six months apart, same answer. The A5 artifact store is the first build
step on it; the audit below adds the archive's forgotten half: the agent needs not just
an artifact store but a nightly consolidation cycle and decay-aware recall.

## ALREADY BUILT (verified in current code)

| Archive idea | Current state |
|---|---|
| DO-per-user brain (the Option E decision) | TelegramOwnerDO + run-loop DOs, exactly this |
| 5 typed memory halls | do-schema halls with trust/taint classes (beyond archive spec) |
| Temporal fact invalidation (valid_from/valid_to/superseded_by, mempalace) | claims table carries all three, with CHECK constraints |
| REASONS prompt assembly / 25-field context | context-composer 7-layer canvas + reasons |
| Per-trigger tool ACLs + lazy discovery | TOOL_PERMISSIONS + formatToolDefinitions + LAZY_DISCOVERY_TRIGGERS |
| Hook pipeline (7 events) | hooks registry; Pre/PostToolUse live in dispatcher (fewer events, same pattern) |
| Scribe sanitiser + memory poisoning defense | Scribe-staged writes, trust-filtered recall |
| Skills progressive loading (SKILL.md format) | skills/loader.ts, R2-backed playbooks |
| LLM fallback chain | gateway fallback_step receipts |
| Memory fencing (<memory-context>) | composer renderMemoryContext (Hermes pattern) |
| FTS5 on episodes | live, plus hall recall at compose time |

## ADOPT - forgotten strong points worth building now

1. **Daily compaction (the archive's "missing link", marked Phase D = now).** Episodes
   accumulate; nothing currently summarizes yesterday into a diary row or marks episodes
   consolidated. Weekly-only thinking drifts. Build: patrol-triggered nightly job
   (DO alarm): yesterday's episodes -> diary summary row -> promote validated patterns ->
   mark consolidated. Cheap model call, ~50 tokens/day. The archive even specifies the
   function shape. This is the dreaming-mode core minus the self-evolution ambitions.
2. **Memory decay (HOT/WARM/COLD) with validation_count resisting decay.** Current recall
   has trust filtering but no recency weighting: a pattern validated 15x and one seen once
   rank alike. Build: recall ranking gains recency+validation factors (pairs naturally
   with V1's vector leg - decay becomes one ranker input).
3. **Pending-followups register.** "Suggested X, check metric Y after Z" as typed rows with
   outcomes. Current open_loop/close_loop covers conversations; followups are
   outcome-tracked suggestions (intervention effectiveness = hall_advice's actual fuel).
   Small table + patrol check. Makes the proactive loop measurably learn.
4. **Proactive recording rule (CoPaw pattern).** When the owner volunteers a fact
   ("started magnesium"), update memory BEFORE replying. This is a prompt/behavior rule
   over existing update paths, not new infra - add to the messaging behavior prompt with
   a scenario test.

## PLANNED ALREADY (archive idea matches the current roadmap - no action)

- Vector/semantic recall (archive Tier 3 pgvector) -> V1 Vectorize ranker, pulled into alpha today.
- User-configurable routines -> A7 standing orders (typed scope/trigger/gate/escalation).
- Webhook/event ingress -> A8.
- Workspace files for the agent -> A5 artifact store (typed, provenance-carrying - the
  archive's Option A/C shape superseded by DO SQLite + R2, consistent with its own Option E).
- Nudge system phases -> the existing proactivity/dial work (set_proactivity live).

## DROPPED-CORRECTLY (stale, and the current build is better)

- Supabase-edge invoke-agent runtime: superseded by DO-only intelligence (archive itself
  records this refresh).
- Postgres virtual filesystem (Option A) as the workspace end-state: DO SQLite + R2 bodies
  is the same idea without the impersonation overhead; per-owner DO isolation is stronger
  than RLS for the threat model that matters (prompt injection reaching another tenant).
- Raw file-tree workspace UI as the transparency surface: today's transparency spec goes
  trust-first (what Waldo knows/can touch/did) over folder dump. (Muse screenshots
  confirm the tree is the weak version.)
- 13-tool/6-hall/Haiku prototype numbers: superseded by the contracts toolchain.

## Sequencing note

Adopts 1-3 fold into A5's neighborhood (all are patrol/alarm + typed rows, no new infra):
daily compaction rides A5's background-task table as its first real task; decay rides V1's
ranker; followups is one table + patrol check. Adopt 4 is a prompt rule with a scenario
test, no slice needed. Suggest: A5 scope line gains "daily compaction (archive adopt #1)";
V1 gains "decay-aware ranking (adopt #2)"; A7 or A9 gains followups (adopt #3).

Compared against: the owner's own archive (primary source, cloned and read this run) +
current code verification per claim.
