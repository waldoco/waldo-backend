# Mac lane T, second task: the turn time budget (M4)

Launched by the Mac orchestrator on 13 Oct 2026, about 20:30Z. Lane T's first task, `use_mac` eligibility, was withdrawn because `use_mac` is Ashish's Kennel work: don't touch `use_mac` or its wiring. The plan is `FINAL_TAKE_2026-10-13.md` on this branch, M4, and Harness verification item 22. The board is waldoco/waldo-backend#1103.

## Rules

Read these first:
- `CLAUDE.md`;
- `.claude/rules/INDEX.md` and the five rule files it lists;
- `AGENTS.md`.

`CLAUDE.md` asks for one retry owner, bounded work, cancellation fencing and honest terminal ambiguity. Keep all four.

## The problem

A slow or hung model provider can stretch an owner's turn far past what a person waits for. The owner felt Waldo was slow, and the Phase 0 baseline measured it:
- S5 took 72.9 s, with six model calls;
- most turn time was not model time.

The Build Bible's Harness tab says a model call can take about 90 s in the worst case: a 30 s timeout plus two SDK retries. Today `packages/runtime/src/llm/openai.ts` creates the client with `maxRetries: 2` and `timeout: 30_000`, and also runs its own `AbortController` timer per `complete()` call. Whether that outer timer already caps the total at 30 s is unverified. Prove it before changing anything.

## Scope of this PR

1. **Measure first.** Write tests with a fake slow client. They should show:
   - the worst-case time of one `complete()` call;
   - the worst case across one turn's model calls;
   - how many layers retry: the SDK, the adapter, the gateway or provider in `llm/provider.ts` and `gateway.ts`, and `conversation/tool-loop.ts`.

   Record the numbers in the PR. If the worst case is already bounded and there is exactly one retry owner, say so. Then limit the PR to the per-turn deadline below.
2. **One retry owner, with at most one retry for a model call.** Remove the second layer, wherever it is, and keep the provider-idempotent reconciliation key behaviour in `provider.ts` intact.
3. **A per-turn deadline:**
   - Each model call gets the smaller of its own timeout and the turn's remaining budget.
   - When the budget runs out, the turn ends honestly through the existing final no-tools step. Otherwise it gives a plain "I couldn't finish that in time" reply.
   - Never fabricate an answer.
   - Tools that already started are not abandoned silently. Leave mutation semantics untouched (see below).
4. **One home for the values.** Put the constants in one place, and justify them in the PR from the baseline turn times. Scheduled turns can have their own budget if the code already separates them.

## Out of scope: stop and report instead

- Per-tool timeouts. Mutations need intent-before-I/O and honest ambiguity, so they get a design with the lead first.
- p50/p90 dashboards: a follow-up PR.
- Model or provider changes.
- `packages/contracts`.
- `channels/owner-do.ts`, the responder (`createOwnerResponder`), the inbound turn files (`telegram-turn.ts`, `owner-turn*.ts`) and anything `use_mac`. If the deadline can only be threaded through one of these, stop before editing it, and report the minimal diff you would need.

## Tests

Red first, using fakes. Each of these needs a test:
- a slow call is aborted at its timeout;
- the retry count stays at 1 or fewer;
- the per-turn budget shortens a later call;
- an exhausted budget ends the turn honestly;
- a cancellation from the run scope still aborts at once;
- a provider's success right at the edge of the budget is kept.

## Verify, and report each result at the exact SHA

- `git diff --check`
- `npx -y pnpm@10.34.4 verify:guards`
- `npx -y pnpm@10.34.4 verify`

Report each as PASS, FAIL, NOT RUN or UNAVAILABLE. pgTAP doesn't run on macOS, so report it as UNAVAILABLE. Classify any failing test per `.claude/rules/posture.md`, and never touch the shared local Supabase container.

## Git and PR

- **Branch:** `mac/m4-turn-time-budget`, from `origin/beta-mvp`.
- **Commits:** by path. Each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **PR:** `gh pr create --repo waldoco/waldo-backend --base beta-mvp`, ready for review.
  - The body covers the problem, the measured numbers before and after, the change, the files, the tests with red-first evidence, the impact surface, and rollback.
  - It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Never:** merge, deploy, `--no-verify` or force-push. Never touch secrets, `.env`, health values or staging URLs, and spawn no subagents. Don't post on #1103.

## Report back

- the PR number and head SHA;
- the CI state;
- the files touched;
- the measured worst cases before and after;
- every verify result;
- any blocker or decision.

Stop once the PR is open and CI has started.
