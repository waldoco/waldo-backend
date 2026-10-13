# Mac lane T, first PR: tool eligibility for `use_mac` (M1)

Launched by the Mac orchestrator on 13 Oct 2026, about 20:05Z, on Ansh's go (#1103 6153969229) and the owner's word that the Mac owns most of the building. The plan is `FINAL_TAKE_2026-10-13.md` on this branch (read its "Update, 19:20Z" section and the M1 paragraph in section 1). The board is waldoco/waldo-backend#1103.

## Rules

Read these first, in the repo you work in:
- `CLAUDE.md`;
- `.claude/rules/INDEX.md` and the five rule files it lists;
- `AGENTS.md`.

They govern: judgment stays with the model, TDD, the verify wall, and no slop.

## The problem

The model is offered tools that cannot work for the current owner. That wastes steps and invites wrong claims.
- **The live case is `use_mac`** (#1178). It has run on staging since 19:27Z on 13 Oct, at release `7ba2e7f9`.
  - It is in `ALWAYS_ON_TOOLS` (`packages/contracts/src/tools/permissions.ts`, around line 298).
  - Its handler is registered with no availability condition at `packages/runtime/src/channels/owner-do.ts`, around line 2463.
  - [inference] So an owner with no paired Mac is offered it.
- **`formatToolDefinitions` in `packages/runtime/src/tools/dispatcher.ts` has no runtime caller,** so the real place where the model's tool list is built is still unknown.
- **Why it matters:**
  - CLAUDE.md says "resolve the smallest per-turn capability manifest";
  - the Build Bible §7 Phase 2 says "make eligibility check the binding";
  - the Phase 0 baseline (S5) lost four calls on a browser tool that could not authenticate.

## Scope of this PR

The eligibility seam plus `use_mac` only.
- `browse_page` waits until #1110 merges. Do not build on an unmerged PR.
- An eligibility fact (a binding is present, a device is paired, a connector is linked) is a hard capability fact, which the repo allows as deterministic logic. It is not a judgment call.

## Steps

1. **Find where the model's tool list is really built.** Trace from the owner turn to the provider call.
   - Stop and report back, with the minimal diff you would need, if the only place to filter is in:
     - `packages/runtime/src/channels/owner-do.ts`;
     - the responder (`createOwnerResponder` and its file);
     - the inbound turn files (`telegram-turn.ts`, `owner-turn*.ts`).
   - Do not edit those files. The lead's A1 and A2 rewrite them, and `owner-do.ts` has a single-writer queue on #1103.
2. **Prove the defect before fixing it.** First write a test that fails on today's code: it shows `use_mac` offered to an owner with no paired Mac.
   - If the test passes, `use_mac` is already filtered. Stop and report that, with the evidence.
3. **Add the seam:**
   - one runtime source of truth for "can this tool work for this owner now";
   - the tool list filtered by it at the place step 1 found;
   - a `use_mac` predicate meaning "this owner has a paired, active Mac".
4. **Keep defence in depth.** If `use_mac` is called anyway, it returns an error the model can act on, which says unavailable and not to retry.
5. **Edge cases, each with a test:**
   - a paired Mac;
   - none ever paired;
   - pairing revoked;
   - the device bridge binding missing;
   - an owner who is not admitted.

## Do not

- Touch `ALWAYS_ON_TOOLS`, the contracts registry, or anything in `packages/contracts`. That is contract drift, and the app is frozen.
- Edit the files listed in step 1.
- Add regex or fixed rules for judgment calls.
- Spawn subagents.
- Open more than one PR.
- Merge or deploy anything.
- Use `--no-verify` or force-push.
- Touch secrets, `.env` files, health values or staging URLs.
- Touch the shared local Supabase container, or another session's worktree.

## Verify, and report each result at the exact SHA

- `git diff --check`
- `npx -y pnpm@10.34.4 verify:guards`
- `npx -y pnpm@10.34.4 verify`, the full wall

Report each as PASS, FAIL, NOT RUN or UNAVAILABLE. pgTAP doesn't run on macOS, so report it as UNAVAILABLE; CI runs it. Classify any test failure as in-branch, introduced, pre-existing or flaky, per `.claude/rules/posture.md`.

## Git and PR

- **Branch:** `mac/m1-use-mac-eligibility`, from `origin/beta-mvp`.
- **Commits:** by path. Each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **PR:** to `beta-mvp` with `gh pr create --repo waldoco/waldo-backend --base beta-mvp`, ready for review, with a plain-language title.
  - The body covers the problem, the change, the files, the tests and their red-first evidence, the impact surface, and rollback.
  - It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Don't post on #1103.** The orchestrator posts.

## Report back

- the PR number and head SHA;
- the CI state;
- the files touched;
- where the tool list is built;
- anything you need: a slot, a decision, or a blocker.

Stop once the PR is open and CI has started.
