# Mac lane R: recall by relevance (B3)

Launched by the Mac orchestrator on 13 Oct 2026, about 20:50Z. It builds the backend lead's spec, section B3 only: #1103 comment 6154593035. The review session gave the go on 6153969229, item 3. The owner's bar applies (digest item 35): no rash decisions, and mature practice cited for every ambiguous design point. The board is waldoco/waldo-backend#1103.

## Rules

Read these first:
- `CLAUDE.md`;
- `.claude/rules/INDEX.md` and the five rule files it lists;
- `AGENTS.md`.

The spec is the contract, so read it whole: `gh api repos/waldoco/waldo-backend/issues/comments/6154593035 --jq .body`. B4 is out of scope.

## Scope: one PR, B3 steps 1 to 5

1. **Pinned blocks as views over claims.**
   - Add the `pinned` and `pin_order` columns, following the file's additive `ALTER` pattern.
   - Render the two blocks within their budgets, with the profile filter.
   - Keep the fallback for when nothing is pinned, so no existing owner loses context.
2. **Curation ops.**
   - Add `pin` and `unpin` to `CLAIM_OPS_SCHEMA`.
   - `applyClaimOps` applies them in the settle and in the nightly pass.
   - `NIGHTLY_MEMORY_INSTRUCTION` describes the two blocks and their budgets.
3. **`memory/turn-recall.ts`, `recallForTurn`,** as specified:
   - query terms come from `ftsQuery`, with the previous message as the fallback;
   - claims come from `store.recall(query, 12)` and episodes from `episodes.search(query, 8)`;
   - dedup by `source_ref`, with the claim winning;
   - render a `<recalled>` block, within `RECALL_MAX_CHARS` inside `room`, with one count line for what was cut.
4. **Call sites in `channels/owner-turn.ts`:**
   - the owner turn's `turnMemoryPrompt` call, near line 504 on the tip;
   - the background decision, near line 716, which gets claims only and still excludes `health`.

   `day-cards.ts` keeps its shape.
5. **The tests listed in the spec,** written red first.

## Order of work, to stay clear of #1149

#1149 is the builder's PR. It is open and not yet ready for the gate. It changes these:
- `applyClaimOps`, `ClaimGrounding` and `consolidate`, in `memory/claims.ts`;
- the `respond` and `consolidate` parts of `owner-turn.ts`.

Don't stack on it. Branch from `origin/beta-mvp` and work in this order:
1. The pure module `turn-recall.ts` and the pinned-block renderer, with their tests.
2. The call sites.
3. Last, the claim-ops and nightly-instruction edits. Before you start them, run `git fetch`. If #1149 has merged, merge `origin/beta-mvp` in with a merge commit; never rebase.

## Judgment stays with the model

The repo forbids fixed rules for judgment calls. What to pin and what matters in a turn are the model's decisions, made in the nightly pass and in the turn.

Query-term extraction, dedup and the budget cut are retrieval mechanics, and the spec makes them deterministic. Keep them mechanical. Add no keyword lists and no topic rules.

## Prior art (the owner's bar)

The PR body gets a section called "Prior art and decisions". For every point where the spec leaves room, or where you depart from it, say how mature systems handle it. Cite sources you read yourself, starting with Anthropic's docs and engineering posts. At least these points:
- recalled memory injected every turn, compared with retrieval just in time through tools (the spec does both: `<recalled>`, plus `read_memory` and `search_episodes`);
- pinned memory blocks with a size cap, rendered every turn;
- how the cut is reported to the model.

If the code contradicts the spec, or a point in the spec is unsafe, stop and report it with a proposed fix. Don't improvise. The orchestrator relays questions to the lead.

## Out of scope

- B4: embeddings, Vectorize and the outbox.
- `channels/owner-do.ts`, `packages/contracts`, app.v1.
- Supabase migrations and wrangler.
- `use_mac`.
- The threads PRs: #1173, #1176 and #1179.
- Anything in #1149's diff, beyond merging the tip in.

## Privacy

- The decision path keeps excluding `health` claims.
- Health pins follow today's rules; the visibility ruling is still pending.
- Use synthetic fixtures only. No health values, owner text or staging URLs in logs, fixtures or the PR.

## Tests, red first

Cover what the spec's step 5 lists.

The r1 scenario (`r1-recall-across-day`) lives in #1185, which is still open, so don't build on it. Instead, write the same check on the tip:
- use the tip's scenario harness, or a responder test with a fake model;
- include a trace assertion that the last turn's `<recalled>` block carries the fact.

"r1 three of three in the nightly harness" is checked after the merge.

## Verify, stage by stage, at the exact SHA

- **`git diff --check`.**
- **`npx -y pnpm@10.34.4 verify:guards`.** `guard-pgtap` needs Linux, so report it as UNAVAILABLE. Then run the guards that sort after it one by one, from the repo root.
- **Type checks and suites:** `pnpm -r typecheck`, then every non-Supabase vitest config of `@waldo/runtime`. Read the real list from `package.json`: the default, console-ticket, common-bootstrap, scenarios, owner-ingress, link-routing, devices, browser-fixture, browser-continuity and scribe.
- **`verify:supabase` is NOT RUN.** This change has no SQL, and every worktree shares the local Supabase stack. CI's "Supabase migrate-from-zero and pgTAP" job is the arbiter. Never run `supabase` commands locally.
- **Before a full runtime suite,** check that no other vitest is running (`pgrep -fl vitest`); suites started at the same time time out at pool startup.
- **Dashboard tests:** if `console-entry` or `dashboard-static-worker` fail with 404s, build the dashboard assets first.
- **Failures:** classify each one per `.claude/rules/posture.md`.

## Git and PR

- **Branch:** `mac/b3-recall-by-relevance`, from `origin/beta-mvp`. Unset any upstream that points at `beta-mvp`.
- **Commits:** by path. Each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **PR:** `gh pr create --repo waldoco/waldo-backend --base beta-mvp`, ready for review, with a plain-language title.
  - The body covers the problem, the change, prior art and decisions, the files, the tests with red-first evidence, the impact surface, and rollback.
  - It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Never:** merge, deploy, `--no-verify`, force-push, secrets, `.env`, subagents, posting on #1103 (the orchestrator posts), or touching another worktree.
- **Budget:** about 250 tool calls. If you get close, stop at a clean commit and report.

## Report back

- the PR number and head SHA;
- the CI state;
- the files touched;
- the decisions and the prior art;
- every verify result, per stage;
- any questions for the lead.

Stop once the PR is open and CI has started.
