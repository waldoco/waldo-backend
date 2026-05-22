---
name: run-eval
description: Run the agent eval suite against current code. Use before merging any change to runAgentLoop, promptBuilder, qualityGates, or soul files.
---

# Run Eval Suite

Run the Waldo agent eval suite and check for regressions.

## Steps

1. `cd tools/eval && npx tsx run-suite.ts`
2. Check overall pass rate vs previous run (WIS ratchet — must not regress)
3. For any FAIL: identify which scenario_tag failed and why
4. Check if failure is in: prompt shape, tool call, quality gate, or delivery
5. If prompt-related: fix the prompt first (Fowler SPDD: fix prompt before code)
6. If code-related: apply fix, re-run eval, verify green

## Eval Cases

- 30 cases seeded from 856-day A0 fixture
- 10 hard cases (Form <50, Samsung estimated, simultaneous stress+low-sleep)
- 10 normal cases (all 4 zones)
- 10 edge cases (missing sleep, watch disconnect, first day)

## WIS Ratchet

Overall eval score must match or exceed the score from the last passing run.
A regression means the change made the agent worse. Fix before merging.

## LLM Judge

Gemma 4 9B via CF Workers AI. Criteria-based, not string-match.
Criteria: tone_appropriate, mentions_pillar_drag, has_action, no_raw_values, no_banned_words, length_ok.
