---
name: run-eval
description: Run or triage the Waldo backend eval gate. Use before merging prompt, routing, LLM, delivery, memory, or agent-loop changes; if the eval suite is not present, record the gap and run the current verify wall.
---

# Run Eval Suite

Run the Waldo backend eval suite and check for regressions.

Current foundation note: this checkout does not yet contain a `tools/eval`
suite. Until that lands, this skill is a gate triage skill: prove whether an
eval suite exists, then either run it or record the missing suite as an open
foundation/runtime gap.

## Steps

1. Check whether an eval command exists:

```bash
test -f tools/eval/run-suite.ts
rg -n "\"eval\"|run-suite|WIS|judge" package.json packages scripts tools 2>/dev/null
```

2. If the suite exists, run the documented eval command and compare against the last passing score.
3. If it does not exist, say so explicitly and run the current merge wall:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

4. For any eval failure, classify it as prompt/context, tool call, quality gate, delivery, memory, routing/model, or test fixture.
5. Fix regressions with a failing case first; do not loosen the judge or fixture to get green.

## Target Eval Coverage

- Trace-native harness replay.
- Prompt/context REASONS coverage.
- Tool ACL and taint-gate scenarios.
- Memory recall/sanitiser/promotion scenarios.
- DeliveryGate, outbox, crash/resume, and idempotency scenarios.
- Model routing, escalation, cost, and latency scenarios.
- Synthetic health fixtures only.

## Ratchet

When the suite exists, overall eval score must match or exceed the last passing
run unless the user explicitly accepts a documented trade-off.

## LLM Judge Boundary

LLM judges are allowed only when calibrated against human criteria or when a
deterministic assertion cannot capture the behavior. They must not receive raw
health values, secrets, or production user data.
