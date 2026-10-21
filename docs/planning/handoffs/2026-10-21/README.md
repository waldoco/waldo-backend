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

### Merge train #1358: MERGED as `19ccd5e8` at 12:46Z (history below)

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

## Who owns what (FINAL, 21 Oct 16:02Z)

**All work now moves to cloud sessions on Ansh's account.** The original account's sessions have stopped. Each one pushed its work and wrote a `## Handoff` section at the top of its PR. Nobody on the original account pushes or merges until the owner says it is taking back over.

Cloud sessions cannot message each other. They coordinate through GitHub: PR bodies, PR comments, and this file's Progress log.

| Cloud session | Model | Owns | Starts from |
|---|---|---|---|
| **C0 orchestrator** | Opus | The **only merge owner** for `beta-mvp`, plus merge trains, gate reviews, design questions from lanes, owner asks, and this Progress log | This README |
| C1 worker layer | Opus | #1355, branch `claude/worker-layer` | #1355 `## Handoff` |
| C2 connectors | Opus | #1357, branch `claude/connectors-mcp-397547` | #1357 `## Handoff` |
| C3 wearables and health trigger | Sonnet | #1354, branch `claude/wearables-trigger-a69617` | #1354 `## Handoff` |
| C4 onboarding and consent | Sonnet | #1356, branch `claude/onboarding-consent-a1f9ee` | #1356 `## Handoff` |
| C5 evals | Sonnet | #1342, #1345, #1360 (`evals/state-memory`) | their `## Handoff` sections |
| C6 harness prompt | Opus | #1346, #1349: fix the two shard-1 tests H-4 broke (`owner-skills-private`, `imessage-e2e`, which now read the turn context), carry onto the current tip, check #1349's cache stability. Then lane A (below). | #1346 `## Handoff` |
| C7 carries | Sonnet | WhatsApp #1309, #1310, #1311, and the 12 PR-carries in the table on #1105: keep them on the current tip, fix CI | their `## Handoff` sections, #1105 comment |

Run C0 plus as many lanes as the budget allows, in this order: C0, C1, C6, C2, C3, C4, C5, C7. One session writes a branch at a time.

**Lane rules** (every lane session):
- Work only on your own branch, with merge commits only. Merge `beta-mvp` in often, because the lineage guard fails otherwise. Never push to `beta-mvp`, and never merge.
- Keep your PR's `## Handoff` section current, and post "ready for gate review at <sha>" as a PR comment when the wall is green.
- If a design question is not settled in your PR body, post it as a PR comment headed `## Question for orchestrator` and wait. Don't decide it yourself.
- Never deploy, apply hosted migrations, touch secrets, or touch production.
- Report PASS, FAIL, NOT RUN and UNAVAILABLE separately, at an exact SHA.

**C0 duties:**
1. Answer `## Question for orchestrator` comments.
2. Gate-review each "ready" PR: an independent adversarial review against the review bar and tool checklist in `BUILD_DIRECTION`, with findings verified in source. Post a `## Gate review` comment with the SHA and a verdict.
3. Land green, approved PRs with merge trains and `merge-when-green.sh`.
4. Log every merge, decision and owner ask below.

**Lane A** (C6, after #1346 lands):
- H-9: rule pruning with ablations, which also clears the 11 `post-mvp-cleanup` issues;
- M-4: the memory flush on `compactionFlush`, keeping qualitative health patterns only;
- cheapest-rung guidance plus structured blocked outcomes (`login_required`, `js_required`, `challenge`);
- the iMessage proactive-delivery gap;
- untrusted fields delimited, with their provenance;
- no links, grants, schedules or standing instructions from a tainted turn without approval.

### Prompts to start the cloud sessions

Every session runs in repository `waldoco/waldo-backend`. Each prompt begins with:

> Read `docs/planning/handoffs/2026-10-21/README.md` on branch `handoff/2026-10-21`, then CLAUDE.md and `.claude/rules/`.

Then add the line for the session's role:
- **C0:** "You are C0, the orchestrator and only merge owner. Follow the C0 duties. Keep the Progress log on `handoff/2026-10-21` current."
- **C1–C7:** "You are C<n>. Check out <branch> and continue from the `## Handoff` section of <PR>. Follow the lane rules."

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
| 2026-10-21 12:46 | **Train #1358 merged** (`19ccd5e8`). #1351, #1347 and #1352 all show merged. The five #1351 constituents (#1340, #1343, #1243, #1248, #1348) still need closing as "landed via #1351/#1358". | beta-mvp `19ccd5e8` | Close the constituents (orchestrator). |
| 2026-10-21 14:50 | Five lanes hit the original account's usage limit mid-work. The orchestrator committed their uncommitted work as found ("WIP: checkpoint at the session limit") and pushed it: #1357 `7b71f5a1`, #1354 `13049cf3`, #1355 `2f533c04`, new branch `evals/state-memory` `73b8f645`, and the #1311 carry `36123341`. These WIP commits may not build. | — | Lanes re-check typecheck and tests first. |
| 2026-10-21 15:55 | Limit reset. Orchestrator and lanes resumed; wearables, onboarding, evals and WhatsApp moved to Sonnet. Work split per "Who owns what". | — | Cloud: gate reviews, plus fixing #1346/#1349. |
| 2026-10-21 16:02 | The owner moved ALL work to Ansh's cloud sessions to save the original account's usage. Every local lane was told to stop, push and finalize its `## Handoff`. Roles are C0–C7 (see "Who owns what"). | — | Start C0 first. |
| 2026-10-21 16:40 | Lane checkpoints received, all containing `beta-mvp` `19ccd5e8`: evals #1342 `b4340dd9`, #1345 `7ae34032`, new **#1360** (state and memory evals, draft) `3dec7c1e`; WhatsApp #1309 `1db91d11`, #1310 `408d99c0`, #1311 `ab2eb6b7`; connectors #1357 `94aa5990`; onboarding #1356 `925549a6` (wall NOT RUN). Worker layer #1355 and wearables #1354 still finishing. **Decision (orchestrator):** WHOOP express authorization = the existing (whoop, storage_compute) + (whoop, model_processing) grants with WHOOP-specific notice copy. Drop `provider_terms`; connect needs both grants. This is next step 1 for C3. Accepted: #1354's Scheduler.schedule() fix, so a re-arm always moves updated_at. | see row | C5 adds #1360 to its scope. |

### Owner asks raised since handoff

(none yet)

### Conflicts and open risks for the takeover

(none yet)
