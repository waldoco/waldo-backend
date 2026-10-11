# Lane handoff template, 12 October 2026

The owner is starting successor sessions because the current ones are long. In the owner's words, each handoff should let the successor "carry build forward and finalize the waldo backend and waldo app".

**How to write it:**
- Write your handoff to `<your worktree>/docs/planning/lanes-2026-10-11/handoffs/<LANE>_HANDOFF_2026-10-12.md`, then reply to the alignment session with the absolute path.
- Don't commit it. The alignment session collects every handoff into one docs PR, so there is a single writer.

**Rules for every claim:**
- Tag each one `[verified]` (you ran or read it, at a named SHA) or `[inferred]`.
- Take SHAs from `git rev-parse`, never from memory.
- Never include secrets, tokens, invite codes, email addresses, Figma screenshot URLs or raw health values.

**Assume your successor starts in a fresh worktree.** Anything you haven't pushed, it can't see. Any background process you started (a log tail, Metro, a dev server) stops when this session ends.

## 1. Role

- What this lane owns: surfaces, files and contracts.
- Hot files it shares with other lanes, and who else writes them.
- What this lane does not own.

## 2. State at exact SHAs

- `beta-mvp` and app `main`, from `git rev-parse`.
- Staging Worker version and what it serves, if your lane deploys or depends on it.
- PRs merged since 10 Oct: number, merge SHA, one line each.
- Open PRs: number, head SHA, CI state, what is needed to merge, and who gives the go.

## 3. In-flight work

- Every branch you touched: pushed or not, head SHA, worktree path.
- Nothing uncommitted may be left behind. If something is, push it to a branch and say so.
- Background processes that end with this session, and how to restart them.

## 4. Owner rulings for this lane

- Quote each ruling exactly, with its date and the session it was given in.
- Say whether each is recorded in the ledger (#1057), an ADR or a design-system decision.
- Open owner decisions: the question, the options, and your recommendation.

## 5. Next steps, in order

For each step give:
- what to do;
- the files;
- an acceptance check: the test, probe or observation that proves it's done;
- who gives the go.

## 6. Verification and pitfalls

- Exact commands, for example `npx -y pnpm@10.34.4 verify:guards` and targeted tests.
- What can't run at the same time as another lane's work. The full verify resets the shared local Supabase.
- Known flaky tests, with issue numbers.

## 7. Dependencies

- What you are waiting on from other lanes.
- What other lanes are waiting on from you.

## 8. Do not

- Constraints specific to this lane.
- Any standing rule that caught you out.

## 9. Starter prompt for your successor

A message the owner can paste as is. It names:
- the role;
- the handoff path to read first;
- the SHAs to re-verify before acting;
- the first action.
