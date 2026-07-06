---
name: diagnose
description: Disciplined diagnosis loop for hard bugs and performance regressions. Reproduce → minimise → hypothesise → instrument → fix → regression-test. Use when user says "diagnose this" / "debug this", reports a bug, says something is broken/throwing/failing, or describes a performance regression.
---

# Diagnose

A discipline for hard bugs. Skip phases only when explicitly justified.

When exploring this repo, use `.claude/rules/INDEX.md`, `docs/foundation/*`,
accepted ADRs, and the relevant `packages/contracts` module for the domain
vocabulary and locked decisions in the area you're touching.

This skill formalizes Waldo's RCA framework (see memory: rca_framework). The contract: 1-sentence root cause with 1 "because", 3+ alternatives ranked by confidence, failing test BEFORE fix.

## Phase 1 — Build a feedback loop

**This is the skill.** If you have a fast, deterministic, agent-runnable pass/fail signal for the bug, you will find the cause. Without one, no amount of staring at code helps.

Spend disproportionate effort here. Be aggressive. Be creative. Refuse to give up.

### Ways to construct one (try in roughly this order)

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **`curl` / HTTP script** against the local DO worker (`wrangler dev`) or Edge Function (`supabase functions serve`).
3. **CLI invocation** with a fixture input from `tools/health-parser` golden CSVs.
4. **Replay a captured trace** — pull a real `agent_logs` row from Supabase, replay through the agent loop in isolation.
5. **Throwaway harness** — minimal subset: one DO method, mocked Supabase, single message.
6. **Differential loop** — run the same input through old commit vs new commit, diff outputs.
7. **Observability dive** — query `agent_logs` for `error_class`, `wis_components`, `connectors_stale` to narrow the failure.
8. **HITL last resort** — only if a real wearable/phone interaction is required.

A 30-second flaky loop is barely better than no loop. A 2-second deterministic loop is a debugging superpower.

### Iterate on the loop itself

Treat the loop as a product. Once you have *a* loop, ask:
- Can I make it faster? (Cache setup, skip unrelated init, narrow the test scope.)
- Can I make the signal sharper? (Assert on the specific symptom, not "didn't crash".)
- Can I make it more deterministic? (Pin time, seed RNG, isolate filesystem, freeze network.)

### Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**. Loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50%-flake bug is debuggable; 1% is not — keep raising the rate until it's debuggable.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for: (a) a captured `agent_logs` trace_id, (b) a Cloudflare DO log dump, or (c) permission to add temporary instrumentation. Do **not** proceed to hypothesise without a loop.

## Phase 2 — Reproduce

Run the loop. Watch the bug appear. Confirm:
- [ ] The loop produces the failure mode the **user** described — not a different failure that happens to be nearby.
- [ ] Reproducible across multiple runs (or for non-deterministic bugs, at a high enough rate to debug against).
- [ ] Exact symptom captured (error class, wrong WIS component, latency, missing tool call).

## Phase 3 — Hypothesise

Generate **3-5 ranked hypotheses** before testing any. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen it.

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly. Cheap checkpoint, big time saver.

## Phase 4 — Instrument

Each probe maps to a specific prediction. **Change one variable at a time.**

Tool preference:
1. **DO logs / Supabase Edge Function logs** if the env supports it.
2. **Targeted logs** at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with `[DEBUG-<short-id>]` so cleanup is one grep. Tagged logs die at end of session; untagged survive accidentally.

**Health-data redaction still applies** — never log raw HRV, HR, sleep hours, or CRS. Log the trace_id, error_class, tool name, and structural data only.

## Phase 5 — Fix + regression test

Write the regression test **before the fix** — but only if there is a **correct seam** for it.

A correct seam exercises the **real bug pattern** as it occurs at the call site. If the only seam is too shallow (single-caller test when the bug needs multiple callers, mock test when bug needs real Supabase round-trip), a regression test there gives false confidence.

**If no correct seam exists, that itself is the finding.** Note it. The codebase is preventing the bug from being locked down. Flag for the architecture-improvement phase.

If a correct seam exists:
1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.

## Phase 6 — Cleanup + post-mortem

Required before declaring done:
- [ ] Original repro no longer reproduces.
- [ ] Regression test passes (or absence of seam is documented).
- [ ] All `[DEBUG-...]` instrumentation removed.
- [ ] Throwaway prototypes deleted.
- [ ] The hypothesis that turned out correct is stated in the commit / PR message.
- [ ] If the bug touched memory, soul files, or agent identity → escalate to security-reviewer agent.

**Then ask: what would have prevented this bug?** If the answer involves architectural change (no good test seam, tangled callers, hidden coupling), record it as a future architecture improvement. Make the recommendation **after** the fix is in.
