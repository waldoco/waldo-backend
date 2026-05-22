---
name: phase-handoff
description: Generate a phase handoff document when completing a build phase
user-invocable: true
model: sonnet
context: fork
allowed-tools: ["Read", "Grep", "Glob", "Bash"]
---

Generate a phase handoff document for $ARGUMENTS.

Use this template (from `.claude/rules/phase-orchestration.md`):

## Phase [X] → Phase [Y] Handoff

### What Was Built
- List all features/modules completed in this phase

### What Works (with evidence)
- [Feature]: tested via [method], result: [PASS/FAIL]

### What Doesn't Work Yet (known issues)
- [Issue]: severity [CRITICAL/HIGH/MEDIUM], deferred to Phase [Z]

### Architecture Decisions Made During This Phase
- [Decision]: [why] — flag if this changes the Master Reference spec

### Hard-Won Lessons
- Things learned that weren't in the spec

### Prerequisites for Next Phase
- What the next phase needs from this phase to start

### Files Changed
- List all new/modified files for easy context loading

**Steps:**
1. Read `Docs/WALDO_MASTER_REFERENCE.md` to understand the phase scope
2. Run `git log --oneline` to see what was committed
3. Run `git diff main --stat` to see all changed files
4. Check for any failing tests or known issues
5. Generate the handoff document
6. Save to `Docs/handoffs/phase-[X]-handoff.md`
