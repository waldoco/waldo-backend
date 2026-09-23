---
name: phase-handoff
description: Generate a bounded workstream handoff for the next implementation session
user-invocable: true
model: sonnet
context: fork
allowed-tools: ["Read", "Grep", "Glob", "Bash"]
---

Generate a bounded workstream handoff for $ARGUMENTS.

Use this template for backend, protocol, Kennel, presence, connector, or runtime handoffs:

## [Workstream / issue] handoff

### What Was Built
- List the exact capability, contracts, modules, and repositories changed

### What Works (with evidence)
- [Feature]: tested via [method], result: [PASS/FAIL]

### What Doesn't Work Yet (known issues)
- [Issue]: severity [CRITICAL/HIGH/MEDIUM], disposition, owner, and named dependency

### Architecture decisions or conflicts
- [Decision]: [why] — flag if this changes the Master Reference spec

### Hard-Won Lessons
- Things learned that weren't in the spec

### Next-session prerequisites
- What the next session needs, without inventing a product phase or scope cut

### Files Changed
- List all new/modified files for easy context loading

**Steps:**
1. Read `.claude/rules/INDEX.md`, the September personal-agent build plan, the current session entrypoint, and the relevant accepted ADRs/contracts
2. Run `git log --oneline` to see what was committed
3. Run `git diff main --stat` to see all changed files
4. Check for any failing tests or known issues
5. Generate the handoff document
6. Save a repo-local handoff only when another session genuinely needs it; otherwise prefer issue/PR evidence and a concise final summary
