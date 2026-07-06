---
name: session-bus
description: MANDATORY at session start AND end. Cross-session, cross-developer, cross-machine context bus. Reads/writes Linear State doc + waldo-brain git handoff file. Two substrates. Enforces concurrent-safety + forensic audit trail.
---

# Session Bus — waldo-backend

**Repo:** `waldo-backend`
**Source of truth:** Linear "Session Bus — Index + Rules" doc · ADR-0043
**Substrates:** Linear `State — waldo-backend` doc + `waldo-brain/04-Sessions/handoffs/waldo-backend/` git files
**Revised:** 2026-05-25 — dropped Linear Issue per session (noise). Git handoff = forensic record.

---

## Run order

### At session START (before any tool use)

1. **Identify self.** Read `WALDO_DEV_HANDLE` env from `.claude/settings.json` (`shivansh` | `pranav` | `aachi`). If unset → fail loudly, ask user to set it. Generate 8-char session id (first 8 of `uuidgen | md5`).

2. **Read 3 State docs via Linear MCP.**
   - `mcp__plugin_linear_linear__get_document` slug `1d46777ab444` (waldo-backend)
   - `mcp__plugin_linear_linear__get_document` slug `1d46777ab444` (waldo-backend)
   - `mcp__plugin_linear_linear__get_document` slug `52dd3df86f49` (waldo-app)

3. **Ticket assignee check.** If user mentions a HEY-N ticket: `mcp__plugin_linear_linear__get_issue` HEY-N. If `assignee != WALDO_DEV_HANDLE` AND status `In Progress` → **STOP**, alert user, ask if they want to claim or coordinate.

4. **Surface digest to user** (≤100 words):
   - "Other sessions in last 24h: ..." (derive from State doc Recent Sessions + last 5 handoff files in `04-Sessions/handoffs/waldo-backend/`)
   - "Current repo state: ..."
   - "You are starting on ..."

### During work

Track progress in your own context. No external write required mid-session. Optionally update a scratch markdown if you need to span hours.

### At session END (before user closes or `/end-session`)

1. **Pre-read State doc.** If `updatedAt` of `State — waldo-backend` < 5 min ago AND `updatedBy.name != WALDO_DEV_HANDLE`:
   - Diff incoming vs. own intended write
   - **Alert user.** Do not overwrite without explicit OK.

2. **Update `State — waldo-backend`** via `mcp__plugin_linear_linear__save_document` id=`01a520c9-2c14-45c4-a146-1ad0b3dbcc43`. Replace TL;DR + Current State + Next Steps + Blockers + Open Questions. Prepend new entry to Recent Sessions (cap 5; older → drop or archive into a session-history note).

3. **OPTIONAL: Comment on the work ticket.** If this session was scoped to ONE specific HEY-N ticket (not a multi-ticket session, not a planning-only session), leave a progress comment on that ticket via `mcp__plugin_linear_linear__save_comment` issue=HEY-N. Format:
   ```
   Session <handle> · <sid> · <date>

   - <2-3 bullet summary of progress on THIS ticket>
   - Commits: <sha range or list>
   - Status: <still in progress | ready for review | blocked on X>
   ```
   This gives whoever picks up HEY-N live context without leaving the ticket. Skip if session touched 2+ tickets (fragments) or no ticket (nowhere to comment).

4. **Write git handoff.** `waldo-brain/04-Sessions/handoffs/waldo-backend/<YYYY-MM-DD>-<handle>-<sid>.md` using template below.

5. **Commit + push waldo-brain.** Commit message: `handoff(waldo-backend): <handle> · <sid> · <one-line summary>`.

---

## Git handoff template

```markdown
---
type: session-handoff
repo: waldo-backend
date: <ISO date>
handle: <shivansh|pranav|aachi>
sid: <8-char id>
ticket: HEY-<n>  # primary ticket worked on (optional)
---

# Handoff — waldo-backend · <date> · <handle> · <sid>

## TL;DR
<1-3 sentences>

## Branch / Commits
- Branch: <name>
- Commits this session: <sha range or list>

## Files Changed
- <path/to/file.ts> — <what changed>

## Tests / Build
- typecheck: <pass|fail|skip>
- test: <X/Y pass>
- build: <pass|fail|skip>

## Decisions
- <decision> — <why>

## Next Steps
1. <action> (HEY-<n> if applicable)

## Blockers
- <blocker>

## For Other Repo Sessions
- waldo-backend: <breaking change | API addition | none>
- waldo-app: <breaking change | API addition | none>

## Open Questions
- <question>
```

---

## Conflict resolution

| Situation | Skill action |
|---|---|
| 2 sessions claim same ticket | Block second session, ask user |
| State doc updated < 5 min ago by other dev | Show diff, ask before overwriting |
| Linear MCP unreachable | Skip Linear read/write, write git handoff only, alert user "Linear bus down, forensic only" |
| `WALDO_DEV_HANDLE` env missing | Fail loudly. Ask user to set in `.claude/settings.json` |

---

## Failure modes (honest)

- **Skill skipped** → silent divergence. CLAUDE.md `[MUST]` rule is the only enforcement until ADR-0044 SessionStart hook ships.
- **Handoff lies** → CI + tests are real source of truth. Handoff is metadata.
- **Stale State doc** → 5-min reconcile is best-effort, not transactional.

---

## References

- Linear doc "Session Bus — Index + Rules" (slug `d497b9f3bf15`)
- ADR-0043 in waldo-brain
- `04-Sessions/handoffs/waldo-backend/` in waldo-brain
- ADR-0044 (future) — SessionStart hook for auto-invoke
