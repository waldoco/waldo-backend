# Orchestrator handoff, 21 Oct 2026 (for the cloud session)

The orchestrator session on Shivansh's account stopped around 13:30Z on 21 Oct 2026 because of usage limits. A cloud session on Ansh's account carries the work forward from this file. When the original account's limit resets, it takes back over from the **Progress log** at the bottom, which you keep up to date.

Everything you need is in this repository. A cloud session cannot see the original Mac's local files, memory or Claude Docs connector, so this folder holds:
- `artifacts/`: snapshots of the owner's planning docs, taken 21 Oct;
- `open-prs-at-handoff.md`;
- `merge-when-green.sh`.

## Your job

You orchestrate the Waldo backend build in `waldoco/waldo-backend`.
- PRs target `beta-mvp`, never `main`.
- You review designs and PRs against the review bar, land green PRs through merge trains, and keep lanes moving.
- You never deploy, apply hosted migrations, change secrets or touch production. The owner (Shivansh) does one bundled staging deploy later, on his explicit go.

Read in this order:
1. `CLAUDE.md` and `.claude/rules/` (start with `INDEX.md`).
2. `docs/planning/BUILD_DIRECTION_2026-10-21.md` on `beta-mvp`. It is the governing plan: decisions, waves as dependencies, parallel lanes, escalation ladder, review bar (15 questions) and tool checklist. After train #1358 lands, it includes #1352's review bar.
3. The `artifacts/` folder next to this file: snapshots of the owner's Claude Docs, taken 21 Oct. If you can open the live docs, prefer them. Links:
   - build plan https://claude.ai/artifact/MGDBPSqzWQibPfCVvCqzY3
   - build handoff https://claude.ai/artifact/J1CnxUzs8KZDstptVXCmaD
   - personality https://claude.ai/artifact/9VE8Rz71y1rqY6C6Up86Uh
   - wedge https://claude.ai/artifact/V5cYvfv58wZfFB4EcmDExm
   - onboarding https://claude.ai/artifact/48GNboKousd11DSgsdELkL
   - v1 build https://claude.ai/artifact/1xg9szN3bk7TgMp57Csx6R
   - launch brief https://claude.ai/code/artifact/99e32f08-88a5-409c-87e8-2bfb3176371e (not snapshotted)
4. `open-prs-at-handoff.md`: every open PR at 21 Oct ~13:00Z. Re-list live before acting.
5. Each lane's PR body: its `## Handoff` section is the lane's own state.

## State at handoff

`beta-mvp` is at `04471476` (#1341 merged). Its CI at `db49cb66` was green.

### Landing now: merge train #1358

Branch `train/2026-10-21-a`, head `aca8a6b5`. It contains:
- #1351 at `03f239d9`, the wave 2 harness batch made of #1340, #1343, #1243, #1248 and #1348. It passed an independent review, and three pre-merge fixes are confirmed in source.
- #1347 at `0052bc88`, which makes Drive 403 rate limits transient.
- #1352 at `0d8709e4`, the review bar.

Steps:
1. Run `bash docs/planning/handoffs/2026-10-21/merge-when-green.sh 1358`. It needs `gh` with repo access. It merges only when every check passes on an unchanged head.
2. When it lands, tell the harness-turn lane to close #1340, #1343, #1243, #1248 and #1348 as "landed via #1351 / #1358", unless GitHub already marked them merged.
3. Not live after the merge, and say so in every report:
   - the spend ceiling, because `WALDO_COST_LEDGER_SYNC` is unset;
   - compaction, because `COMPACTION.enabled` is false;
   - the Drive fix, until connector-proxy is redeployed.

### Lanes

Each lane is one coherent design in its own worktree and branch. Before the move, each was told to push its work and write a `## Handoff` section at the top of its PR body. Continue a lane from that section.

| Lane | PR | Design review | Conditions the lane still owes |
|---|---|---|---|
| Worker layer (B-2..B-7, R-4) | #1355 | Approved | Browser host accepts a job or replay run scope if contained (closes #1350), else a test that chat is answered between browser steps. The R-4 floor and notice text goes through the voice block. Per-owner job concurrency queues rather than refusing. Worker and retry calls count toward the spend ceiling. Wrangler class, binding and migration tag in this PR, with deploy sequencing against #1334. |
| Connectors (C-1..C-5, MCP and OAuth) | #1357 | Approved | Follow MCP 2026-07-28: Client ID Metadata Documents first, Dynamic Client Registration only as fallback (set `application_type` when used), validate `iss`, map `input_required` to owner asks, store tools in deterministic order, treat annotations as hints only. Add a unification issue against #1349 tool search, and a scenario test for `search_mcp_tools`. |
| Wearables and health trigger | #1354 | Approved | No auto-demotion after one skip; after 3 skips in 7 days the card asks the owner. Shadow mode until a baseline exists, then live, as an owner setting. Check-in counts as a state-change source. WHOOP needs an express storage and AI authorization as its own consent purpose, and no WHOOP data in evals. Oura stops at the mappers (terms, below). The PR quotes the clauses verbatim. |
| Onboarding, consent ledger, look-up skill | #1356 | Approved | O-1..O-8 labelled as the lane's working definition (no itemised source exists). Add the chat-channel step. One consent representation per purpose: health consent is read from the health plane, never copied. The ledger-on-deletion question goes to the owner. Coordinate the WHOOP consent purpose with #1354. |
| Evals | #1342, #1345, and a follow-up | #1342 and #1345 built, not gate-reviewed | Follow-up items: hard state assertions alongside the judge; kappa against owner labels; multi-part errands; stale-premise memory; over-personalization; health-memory cases. |
| Harness prompt (H-4, tool search) | #1346, #1349 | Not gate-reviewed | Review #1349 for cache stability: discovered tools must append, never reshuffle the prefix. |
| Browser | #1344 | Not gate-reviewed | Vendor-neutral seam plus a Browser Use adapter, flag off. The bake-off needs keys. |
| WhatsApp | #1309, #1310, #1311 | Need an independent review | They touch the send path that #1338 changed. |
| PR carries (Gmail read-depth stack and small fixes) | 12 PRs, incl. #1063, #1105, #1109, #1112, #1117, #1127, #1148 | Need gate reviews | All contain `db49cb66`; they need carries onto the current tip at merge time. |

Next lane to start once #1358 lands: **lane A, finishing wave 2.** It goes to the harness-turn lane or a new session on Opus:
- H-9: rule pruning with ablations, which also clears the 11 `post-mvp-cleanup` issues;
- M-4: a memory flush on #1248's `compactionFlush` hook, keeping only qualitative health patterns;
- cheapest-rung guidance and structured blocked outcomes (`login_required`, `js_required`, `challenge`);
- the iMessage proactive-delivery gap;
- untrusted-field handling: contact names, vCards, sender names and server text are delimited and keep their provenance;
- a tainted turn creates no links, grants, schedules or standing instructions without approval.

Later: #1253 and #1260 (`owner-do` structural), then the #1227/#1238/#1240 stack, then #1334 after Ashish's storage check.

### Owner decisions waiting

1. **Oura.** Its API Agreement (effective 8 Jun 2026) §4(d) says LLM use is "solely through the MCP Server", and storing data needs Oura's prior written consent, even with user consent (§4(c)). Recommendation: reach Oura owners via Apple Health or Health Connect now (needs legal confirmation), and ask Oura for consent in parallel. Details are in `artifacts/whoop-oura-api-facts.md`.
2. **ADR-0075.** Amend its line "MCP is not the connector integration layer" in Brain to match the API- and MCP-first direction. The custody rules stay unchanged.
3. **O-1..O-8.** Owner or Suyash confirms #1356's mapping.
4. **Health memory default.** Recommendation: keep qualitative patterns on, notify the owner at each save, and offer a one-tap off.
5. **Before 11 Nov:** tick "Use this client for an AI-powered agent" on the GCP OAuth client. See `docs/research/GOOGLE_INTEGRATION_2026-10-21.md`.
6. Add the GitHub secrets `WALDO_EVAL_OPENAI_KEY` and `WALDO_EVAL_ANTHROPIC_KEY`, and decide the default branch (scheduled evals run only from the default branch).
7. #1334: Ashish's check that the deleted classes' hosted storage is empty.

### Owner rulings to honour (21 Oct)

- Global-first; health connect sits in onboarding; look-up is an agent skill; build in parallel and one-shot, not artificial slices.
- **No deploys mid-train.** Prove everything locally and in CI, then do one bundled staging deploy on the owner's go. After that, test end to end in the Waldo console on the owner's own account, traced in Langfuse and `wrangler tail`. Conditions for that testing:
  - never type passwords or codes;
  - nothing outbound without a per-action yes;
  - use one "QA" thread;
  - forget the test facts afterwards.
- Model per lane: Opus for design, security and privacy; Sonnet for implementing a settled design, carries and doc syncs. About five concurrent building sessions is fine; start more to fix newly found issues.
- APIs and MCP first; browser and computer use last. Tools are strong, never narrowed. No restriction without a named harm; degrade, don't fail.

## How to land work

- **The migration-lineage guard** fails CI unless a branch contains the current `beta-mvp` tip. Every merge therefore invalidates every other open branch. When more than one reviewed PR is ready, build a **merge train**: a branch starting from the PR heads, plus `beta-mvp`, plus the other heads, all with merge commits. CI runs once, and GitHub marks the constituent PRs merged. Never force-push; never use `--no-verify`.
- **`merge-when-green.sh <pr>`** (in this folder) waits until no check is pending and merges with `--match-head-commit` only if every check passed on the unchanged head. `gh pr checks` exits 8 while checks are pending, and the script handles that.
- **Before any merge:** an independent adversarial review (a subagent with a focused brief) for runtime PRs, then green CI. Subagent reports are leads: verify their findings in source before acting.
- **Local wall:**
  - Use `npx -y pnpm@10.34.4 verify` with the dashboard built, only when the 1-minute load is under 12 and no other vitest is running.
  - Kill only your own processes.
  - pgTAP is UNAVAILABLE on macOS and Supabase local is NOT RUN; CI covers both.
  - Report PASS, FAIL, NOT RUN and UNAVAILABLE separately, at an exact SHA.

## How to drive lanes from a cloud session

- **Limits.** You cannot message the Desktop child sessions; they belong to the other account. You also cannot reach the owner's Mac, browser or local staging tools.
- **Continuing a lane.** Check out that lane's branch and read the `## Handoff` section in its PR body. Continue it yourself, or with subagents (the Agent tool) on separate branches, one writer per hot file. Brief each subagent with the files, what "done" looks like, the review bar, and "merge `beta-mvp` in often, merge commits only".
- **Pushes.** Push to the lane's own branch with merge commits only. Never push to `beta-mvp` directly; land work through PR merges, including trains.
- **Coordination.** Use PR bodies, PR comments and issue #116.
- **Never, from the cloud.** No deploys, no hosted migration applies, no secrets, no production, no Cloudflare or Supabase dashboards.
- **Owner asks.** Anything that needs the owner goes in the Progress log under "Owner asks".

## Progress log (keep this current)

Append an entry each time you finish a merge, a lane milestone or a decision. Commit it on this branch (`handoff/2026-10-21`) and push. The original orchestrator reads this first when it takes back over.

| Time (UTC) | What happened | PR / SHA | Next |
|---|---|---|---|
| 2026-10-21 13:30 | Handoff written. Train #1358 in CI; lanes #1354–#1357 checkpointing to their PR `## Handoff` sections. | handoff/2026-10-21 | Merge #1358 when green; review lane PRs as they finish. |

### Owner asks raised since handoff

(none yet)

### Conflicts and open risks for the takeover

(none yet)
