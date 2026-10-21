# Briefs for Instinct (waldo-backend)

These are delegated, disjoint slices, handed over under `docs/app/codex-handover/OWNERSHIP_BOUNDARY.md` on `beta-mvp`. Each brief gives guidance and an acceptance bar, not code.

## Rules for every brief

- Work in your own branch and worktree, cut from the current `waldoco/waldo-backend` `beta-mvp`. Open a **draft** PR against `beta-mvp`.
- **Do not merge, deploy, apply migrations, change secrets or touch production.** The owner's Claude session reviews and merges.
- Never edit these hot files. If you need a change there, describe it in the PR and we make it:
  - `packages/runtime/src/channels/telegram-owner-do.ts`
  - `packages/runtime/src/channels/approvals.ts`
  - `packages/runtime/src/channels/owner-turn.ts`
  - `packages/runtime/src/context-composer/*`
  - `packages/contracts/src/app/*`
  - anything under `supabase/migrations/`
- Read the repo rules first: `CLAUDE.md`, `.claude/rules/INDEX.md` and the files it lists.
  - Judgment belongs to the model. Do not add regexes or fixed rules for judgment calls.
  - Use test-first (red, then green).
  - Every Zod schema gets a valid and an invalid test.
  - No credentials or real health values in code, fixtures, logs or traces.
- **Gates:** `git diff --check`, then `npx -y pnpm@10.34.4 verify:guards`, then `npx -y pnpm@10.34.4 verify`.
  - Report each stage as PASS / FAIL / NOT RUN / UNAVAILABLE at the exact head SHA. pgTAP is often UNAVAILABLE on macOS; say so.
- **PR body must contain:** what changed and why, files touched, tests added (and which fail without the change), what did not change, open questions.
- Keep diffs tight. Every line has to earn its place.

## The briefs

| # | Brief | Ledger rows it advances |
|---|---|---|
| 01 | Health score calculations: a pure module | Recovery, Sleep debt, Form, Weight, Training (Wave 3) |
| 02 | Weather and daylight tool | Weather and daylight (Wave 3/5, ‡) |
| 03 | Connector read depth: Calendar across all calendars, Gmail full bodies | Google Calendar, Gmail (Wave 5, ‡); Weight's demand input |
