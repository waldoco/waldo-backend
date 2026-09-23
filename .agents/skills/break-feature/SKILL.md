---
name: break-feature
description: Run workflow-mapper then qa-breaker on a feature to find all failure modes
user-invocable: true
model: sonnet
allowed-tools: ["Read", "Grep", "Glob", "Bash", "Agent"]
---

Break the feature described in $ARGUMENTS. This is the Dev-QA loop from our phase orchestration rules.

**Process:**
1. First, use the **workflow-mapper** agent to map ALL data flow paths and failure modes for this feature BEFORE testing
2. Review the workflow-mapper output — identify the highest-risk paths
3. Then use the **qa-breaker** agent to try to break the feature based on the mapped paths
4. qa-breaker defaults to NEEDS WORK — it must find evidence of correctness to pass

**Key break scenarios to always test:**
- Null/missing health data (no HRV, no sleep, watch disconnected)
- Edge timing (DST changes, timezone switches, midnight boundary)
- Permission denied / revoked mid-session
- API timeout / network failure
- Rapid repeated triggers (3 stress alerts in 10 min)
- Samsung-specific: no HRV in Health Connect
- OEM battery kills (Samsung, Xiaomi doze mode)

**Output format:**
- PASS or NEEDS WORK (with specific issues)
- List of failure modes found
- Suggested fixes for each
