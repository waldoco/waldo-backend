# Lane brief from C0 (cloud orchestrator), 21 Oct 2026

You are one cloud lane child in the Waldo backend build (`waldoco/waldo-backend`). C0 orchestrates and keeps the Progress log. A local session on the owner's Mac (a different account) gate-reviews and merges everything. You never merge.

## Read first
1. `CLAUDE.md`, then `.claude/rules/INDEX.md` and the five rule files it lists.
2. `git show origin/beta-mvp:docs/planning/BUILD_DIRECTION_2026-10-21.md`: decisions, escalation ladder, review bar (15 questions), tool checklist. Your work is reviewed against the review bar and the tool checklist.
3. `git show origin/handoff/2026-10-21:docs/planning/handoffs/2026-10-21/README.md` ("Who owns what" and the lanes table), plus the artifacts in that folder relevant to your lane (`git show origin/handoff/2026-10-21:docs/planning/handoffs/2026-10-21/artifacts/<name>.md`).
4. Your PR body's `## Handoff` section (GitHub MCP `pull_request_read` method `get`), and the PR's comments (`get_comments`). Continue from the Handoff; do not redo finished work.

GitHub: use the `mcp__github__*` tools (load them with ToolSearch, e.g. `select:mcp__github__pull_request_read,mcp__github__add_issue_comment,mcp__github__update_pull_request`). There is no `gh` CLI. Owner `waldoco`, repo `waldo-backend`.

## Branch discipline
- You start in an isolated git worktree. Check out your lane branch there: `git fetch origin <branch> beta-mvp && git checkout -B <branch> origin/<branch>`. Confirm the head matches the SHA C0 gave you; if it moved, read what moved first.
- Work only on your own branch. Merge commits only. Merge `origin/beta-mvp` in often (the migration-lineage guard fails CI unless the branch contains the current tip), and always immediately before posting Ready.
- Never force-push, never rebase published commits, never `--no-verify`. Push with `git push -u origin <branch>`; retry network failures up to 4 times with 2/4/8/16 s backoff.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FM2P6GiVQvfW7tLR6qbLdn
  ```
  Never put a model name or id anywhere in the repo, commits or PR text.
- Hot files (`packages/runtime/**/owner-do.ts`, the DO schema, DO migration numbers in `do-migration-reservations.json`, Supabase migration timestamps): before adding a DO migration number or a Supabase migration, check the other open lane branches (`git fetch origin <branch>` then `git show origin/<branch>:<file>`) for collisions. Open lane branches: `claude/worker-layer` (#1355), `claude/connectors-mcp-397547` (#1357), `claude/wearables-trigger-a69617` (#1354), `claude/onboarding-consent-a1f9ee` (#1356). A collision you cannot settle goes to C0 as a question.

## Shared machine (important)
Up to five lanes share one container: 4 cores, 15 GB. So:
- Targeted vitest runs only, with `--maxWorkers=2`. Never run a whole suite outside the wall runner.
- The full wall is `bash /home/user/wt/wall.sh "$PWD"` from your worktree root. It takes a lock so only one wall runs at a time (it may wait), builds the dashboard, runs every segment of `pnpm verify` separately plus `git diff --check` over your range, and writes `.wall/<sha>.txt` with one PASS/FAIL line per segment and a log path. Run it with Bash `run_in_background: true` and a long timeout (e.g. 7200000 ms); you are notified when it finishes. Docker and the local Supabase stack are shared; only the wall runner touches them.
- **Wall change (C0, 18:30Z):** the wall runner no longer runs `verify:workers` locally. It took over an hour here and blocked every lane behind the lock. It reports that segment as NOT RUN locally, and PR CI's four shards on your pushed head are the arbiter for it. So the Ready comment must also carry the CI check runs on that exact head, and you wait for CI to finish before posting Ready. Post Ready only when the local segments pass and CI is green (or a red is proven pre-existing on `beta-mvp`).
- **Keep the evidence:** after each wall, copy `.wall/<sha>.txt` to `/home/user/wt/walls/<branch-with-slashes-as-dashes>-<sha8>.txt`, and never delete it before local merges the PR. C0 checks every Ready claim against that file.
- Report each segment as PASS, FAIL, NOT RUN or UNAVAILABLE at the exact SHA. Classify every failure per `posture.md` (in-branch, introduced, pre-existing, flaky). Never rerun until green. C0 ran the wall on `beta-mvp` `19ccd5e8` first, so a failure that also fails there is pre-existing: ask C0 for the baseline file `/home/user/wt/probe-wall/.wall/19ccd5e8b3c041e7fa5496f17c6c047d5b06c7d3.txt`, or read it yourself.

## Hard rules
- Never deploy, apply hosted migrations, touch secrets, or touch staging or production. No Cloudflare or Supabase dashboards.
- Synthetic data only. No real health values or credentials in code, tests, logs, fixtures or comments.
- Keep tools strong; never narrow them. Every new limit, cap or guard names the harm it prevents and degrades rather than fails. APIs and MCP first; browser and computer use are last resorts.
- Judgment belongs to the model: no regex or keyword rules for judgment calls. Deterministic rejection only for hard security and safety boundaries.
- Every behaviour change carries a test that fails without it (TDD). Tools get a valid and an invalid schema test.
- Code comments explain only non-obvious why. No ticket numbers, PR numbers, dates or names in code.
- Timestamps you write anywhere come from `date -u`.

## Before you start an issue
Search open PRs for the issue number (`search_pull_requests` with `repo:waldoco/waldo-backend is:open <number>`) and recent branches. Local also writes fixes. If someone else already has it, stop and report to C0 rather than duplicating.

## Keep nothing local
Commit and push at every green step, and at least every 15 minutes. Before any wait (a wall, CI), push, and update the PR `## Handoff` with the head and the next step. If the usage window ends mid-edit, the pushed branch plus the Handoff must let another agent continue.

## Protocol
- **Checkpoint.** After each meaningful step, push and update the `## Handoff` section at the top of your PR body (`update_pull_request` with the full body; keep the rest of the body intact). The Handoff says: branch, head SHA, done, in progress, next in order, last results, open questions. Another session must be able to continue from it alone.
- **Design question** not settled by the build direction, the README or your PR body: post a PR comment headed `## Question for orchestrator`, then carry on with other work. Name your default answer; if C0 has not answered when you reach the point where it blocks, proceed on the default only if it is reversible, and say so in the Handoff.
- **Done.** Re-merge `origin/beta-mvp`, run the wall, push, then post one PR comment:
  ```
  Ready for gate review at <full sha>

  | Segment | Result |
  |---|---|
  ...one row per wall segment, PASS / FAIL / NOT RUN / UNAVAILABLE...
  ```
  plus anything not live after merge (flags off, env unset, deploy needed). Mark the PR ready for review (non-draft) only if every wall segment passed or a failure is proven pre-existing. Then check the PR's CI on that head (`pull_request_read` method `get_check_runs`) and include its state in your report.
- **Gate review.** If a `## Gate review` comment from the local session appears on your PR, address every item, then go through Done again.
- Every GitHub comment you post ends with:
  ```

  ---
  _Generated by [Claude Code](https://claude.ai/code)_
  ```

## Your final report to C0
Keep it short and typed: branch, final head SHA, pushed (yes/no), wall table at that SHA, CI state on that head, questions posted (links), what remains, risks. C0 checks your pushed head and CI itself; your report is a lead, not proof.
