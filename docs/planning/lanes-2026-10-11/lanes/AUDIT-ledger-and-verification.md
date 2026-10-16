# Audit lane: ledger owner and promise verifier

**Owner decision (11 October 2026).** This session owns the website promise ledger. It checks, independently of the lanes that build, whether Waldo delivers what heywaldo.in promises.
- **Model:** Fable 5.1 (`claude-fable-5-1`), at high effort.
- **Repo:** `waldoco/waldo-backend`, base `beta-mvp`.

## Why this lane exists

- The building lanes grade their own work.
- The ledger itself says its rows were audited at `a13c1fb5` and must be re-pinned before anyone relies on them.
- The capability matrix dates from 27 September, and the competitor research from 20 September.
- **The owner's goal for this phase:**
  1. Finish the app with every promised capability that belongs in the app.
  2. Then hand the app build to Suyash. He owns the interface, experience, flows and screens, and he asks for the backend changes those need.
  3. Suyash must be able to:
     - build onto his own iPhone and Apple Watch;
     - sign up;
     - delete his account and create it again.

## What you own

- **The ledger.** You are the sole writer of `docs/planning/WEBSITE_PROMISE_LEDGER_2026-10-10.md`. Lanes post corrections on #116 starting with "Ledger correction:", and you apply them.
- **This brief.**
- **Nothing else.** You write no runtime, contract, migration, app or Brain code.

## First run, in order

1. **Take over the ledger.**
   - L3's ledger PR #1053 is open. Don't edit the ledger until it is either merged (the owner's go in L3's session) or closed with its content handed to you.
   - Post the ownership change on #116.
   - In your first ledger PR:
     - add this brief;
     - update `lanes/L3-approvals-contracts-connect.md`, which still names the ledger.
2. **Draft a ruling amendment for the owner to confirm.** Suyash is a human collaborator who will change app screens and request or make backend changes. Ruling 2 says only the owner and the owner's sessions write and merge.
   - Draft the amendment text.
   - It becomes a ruling only when the owner confirms it.
3. **Baseline: re-pin every ledger row.**
   - **Pins:**
     - the `beta-mvp` tip;
     - the staging release reported by `/healthz`;
     - `waldoco/waldo-app` `main`;
     - `Pin4sf/waldo-landing` `main`, for the website copy.
   - **Evidence ladder for each row:** source → merged → deployed on staging → seen working on staging or a device. Only the last rung counts as delivered. Merged is not deployed, and deployed is not proven.
   - **Columns:**
     - promise;
     - surfaces: app, console, Telegram, WhatsApp, iMessage, email, Watch, browser;
     - rung, with an evidence pointer (SHA, PR, #116 comment, test name or device record);
     - owner lane;
     - gap.
4. **Handover readiness for Suyash.**
   - For each promise, say whether it belongs:
     - in the app;
     - in the console only (the approved web-only items are invite admin, the admin overview and the memory graph);
     - on a later surface.

     Then say what is missing.
   - At least cover these:
     - the device build (app PR #50);
     - in-app sign-up (L2's O1);
     - deleting an account and creating it again with the same email (untested);
     - proactive jobs (P3a);
     - push (S7);
     - the approvals screen;
     - the connections screen;
     - the scores screen;
     - memory controls.
5. **Market parity, kept separate.**
   - Refresh `docs/planning/waldo-agent-mvp/COMPETITOR_RESEARCH.md` with dated first-party sources: Meta Muse, Instinct, Poke, Dots, and any others the owner names.
   - Use the bar in `docs/planning/INSTINCT_PATTERN_AUDIT_2026-09-27.md` as the rubric.
   - Vendor claims are not benchmarks.
   - Instinct the competitor product is not the Instinct contributor lane (`lanes-2026-10-11/instinct/`).
6. **Report at most 10 ranked gaps, in two lists:**
   - (A) gaps against the website promises, which are in scope under ruling 1;
   - (B) parity ideas beyond the published copy. These are new scope and enter lanes only by an owner ruling.

   Send the report to the owner, and post a short summary on #116 with a link to the ledger PR.
7. **Acceptance probes.**
   - For each promise, write a probe spec: surface, preconditions, steps, the expected receipt or state, and the evidence to capture.
   - A lane automates them against staging later. Status is then measured rather than judged.

## Cadence

- Run the baseline above first.
- After that, run a delta pass after each staging deploy, which L1 announces on #116. A deploy is when "delivered" can change.

## Limits

- **Your only writes:** ledger docs PRs and #116 comments. Each of your PRs merges only with the owner's go.
- **Read-only** on code, staging, Supabase and Cloudflare.
- **None of these:** merges, deploys, migrations, secrets, production, device runs or account creation. Use device evidence from L4 and Suyash.
- **Staging probes:** any probe that signs in, sends a message, spends model calls or touches Google needs the owner's go for that probe. Use a dedicated test account with synthetic data, never the owner's account.
- **Secrets and data:** never read `.env` files or secrets. Write no raw health values, tokens or ids anywhere.
- **GitHub API:** the limit is shared by every session (5,000 calls an hour). Prefer `git fetch` and local reads (`git show`, `git grep`, `git log`) to `gh api`, and batch any `gh` reads you do need.
- **Lane work:** don't assign it. Findings go to the owner and #116, and the alignment session turns them into lane work.

## Read first

- `CLAUDE.md` and `.claude/rules/*`.
- The ledger.
- In `docs/planning/lanes-2026-10-11/`: `README.md`, `SESSIONS_ALIGNMENT_REVIEW.md` (the morning baseline and the Phase 1 exit), `IDENTITY_ROOT_PLAN.md`, and the lane briefs.
- #116 comments since 11 October 06:00Z, especially:

  | Topic | Comments |
  |---|---|
  | L2's order | 6107746777, 6107783460 |
  | L3's parity map | 6107715001, 6107727308 |
  | Account deletion | 6107746748, 6107787637 |
  | Staging state | 6107813219 |
- In waldo-app:
  - `Docs/planning/APP_BUILD_ORDER_2026-10-10.md`;
  - `src/agent/featureAvailability.ts`;
  - the build guide in app PR #50.
- Parity:
  - `docs/planning/waldo-agent-mvp/CAPABILITY_MATRIX_2026-09-27.md`;
  - `docs/planning/waldo-agent-mvp/COMPETITOR_RESEARCH.md`;
  - `docs/planning/PARITY_GAP_PLAN_2026-10-02.md`;
  - `docs/planning/MATURE_AGENT_*_PARITY_2026-10-02.md`.

## Evidence rules

- Never infer shipped capability or competitor parity from plans, schema counts, local fakes or model claims (CLAUDE.md).
- Tag each claim:
  - `[verified]`: you saw it yourself at a SHA;
  - `[reported]`: a lane said so; link to where;
  - `[inference]`.
- Report tests as PASS, FAIL, NOT RUN or UNAVAILABLE, at an exact SHA.

## State when this brief was written (11 October, about 10:30Z)

This is a snapshot. Check it before you rely on it.

- **Staging:**
  - `/healthz` reports `a5a523f9`, the `beta-mvp` tip [verified].
  - Hosted migrations: 54 applied, 0 pending [reported by L1, 6107813219].
- **App main:** `019208a4`.
- **Open app PRs:**
  - #48: the health connect fix. Device ingest fails without it.
  - #49: re-pins the controls contract.
  - #50: Suyash's build guide.
- **Pinned contracts, app main against the backend tip** [verified by sha256]:
  - in sync: `core`, `health-ingest`, `surfaces`;
  - drifted: `approvals`, `controls`, `parts`.
- **Placeholder screens:** six render "unavailable": Brief, Activity, Memory, Graph, Connections and Health detail. Health Stats links to Apple Health but shows no Waldo scores.
- **Phase 1 exit:** 0 of 5 met end to end. No physical iPhone run has happened yet.
