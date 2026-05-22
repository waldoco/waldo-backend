---
name: review-all
description: Run security, health-data, and native-module reviewers in parallel on recent changes
user-invocable: true
model: sonnet
allowed-tools: ["Read", "Grep", "Glob", "Bash", "Agent"]
---

Run a comprehensive multi-perspective review on $ARGUMENTS (or recent changes if no argument given).

**Launch these 3 review agents in PARALLEL (use the Agent tool with multiple calls in one message):**

1. **security-reviewer** — encryption, RLS, secrets, prompt injection, privacy compliance
2. **health-data-reviewer** — null handling, personal baselines, Samsung HRV gap, data freshness
3. **native-module-reviewer** — Kotlin/Swift correctness, Expo Modules API, platform quirks (only if native code changed)

**After all 3 complete, synthesize:**
- Combined PASS/NEEDS WORK verdict
- Grouped findings by severity (CRITICAL > HIGH > MEDIUM > LOW)
- Action items with specific file:line references
- Any conflicts between reviewers (e.g., security wants more validation, health-data wants less latency)
