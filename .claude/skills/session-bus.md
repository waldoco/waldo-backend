---
name: session-bus
description: MANDATORY at session start AND end. Cross-session, cross-developer, cross-machine context bus. Reads/writes Linear State doc + Linear Session Log issue + waldo-brain handoff file. Enforces concurrent-safety + forensic audit trail.
---

# Session Bus — waldo-backend

**Repo:** `waldo-backend`
**Source of truth:** Linear "Session Bus — Index + Rules" doc · ADR-0043

---

## Run order

### At session START (before any tool use)

1. **Identify self.** Read `WALDO_DEV_HANDLE` env from `.claude/settings.json` (`shivansh` | `pranav` | `aachi`). Generate 8-char session id (first 8 of `uuidgen | md5`).

2. **Read 3 State docs via Linear MCP.**
   - `mcp__plugin_linear_linear__get_document` slug `9e07bc2c8d7a` (waldo-backend)
   - `mcp__plugin_linear_linear__get_document` slug `1d46777ab444` (waldo-backend)
   - `mcp__plugin_linear_linear__get_document` slug `52dd3df86f49` (waldo-app)

3. **Read last 5 Session Log issues.**
   `mcp__plugin_linear_linear__list_issues` team=HeyWaldo, label=session-log, updatedAt=-P1D, limit=5

4. **Ticket assignee check.** If user mentions a HEY-N ticket: `get_issue` HEY-N. If `assignee != WALDO_DEV_HANDLE` AND status `In Progress` → **STOP**, alert user, ask if they want to claim or coordinate.

5. **Create own Session Log issue.**
   `mcp__plugin_linear_linear__save_issue` team=HeyWaldo, project="Waldo V1 — Build Sprint", title=`Session Log — <handle> · <YYYY-MM-DD> · <sid>`, assignee=<handle>, labels=[`session-log`, `repo:waldo-backend`], state=`In Progress`. Store issue ID for later updates.

6. **Surface digest to user** (≤100 words):
   - "Other sessions in last 24h: ..."
   - "Current repo state: ..."
   - "You are starting on ..."

### During work (every ~10 min OR on significant action)

Append comment to own Session Log issue via `mcp__plugin_linear_linear__save_comment` issue=<own-id>:
```
HH:MM · <action>
- Edited <file>
- Test status: <pass|fail|n/a>
- Notes: <one line>
```

### At session END (before user closes or `/end-session`)

1. **Pre-read State doc.** If `updatedAt` of `State — waldo-backend` < 5 min ago AND `updatedBy.handle != self`:
   - Diff incoming vs. own intended write
   - **Alert user.** Do not overwrite without explicit OK.

2. **Update `State — waldo-backend`** via `save_document` id=`01a520c9-2c14-45c4-a146-1ad0b3dbcc43`. Replace TL;DR + Current State + Next Steps + Blockers + Open Questions. Prepend new entry to Recent Sessions (cap 5; older → archive comment in Session Bus index).

3. **Final comment on Session Log:** summary of what shipped, what's pending, what's blocked.

4. **Close Session Log.** `save_issue` id=<own>, state=`Done` | `Blocked` | `Handed-off`.

5. **Write git handoff.** `waldo-brain/04-Sessions/handoffs/waldo-backend/<YYYY-MM-DD>-<handle>-<sid>.md` using template below.

6. **Commit + push waldo-brain.** Commit message: `handoff(waldo-backend): <handle> · <sid> · <one-line summary>`.

---

## Git handoff template

```markdown
---
type: session-handoff
repo: waldo-backend
date: <ISO date>
handle: <shivansh|pranav|aachi>
sid: <8-char id>
session_log_issue: HEY-<n>
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
| Linear MCP unreachable | Skip Linear, write git handoff only, alert user "Linear bus down, forensic only" |
| `WALDO_DEV_HANDLE` env missing | Fail loudly. Ask user to set in `.claude/settings.json` |

---

## Failure modes (be honest)

- **Skill skipped** → silent divergence. CLAUDE.md `[MUST]` rule is the only enforcement.
- **Handoff lies** → CI + tests are real source of truth. Handoff is metadata.
- **Stale State doc** → 5-min reconcile is best-effort, not transactional.

---

## References

- Linear doc "Session Bus — Index + Rules" (slug `d497b9f3bf15`)
- ADR-0043 in waldo-brain
- `04-Sessions/handoffs/waldo-backend/` in waldo-brain
