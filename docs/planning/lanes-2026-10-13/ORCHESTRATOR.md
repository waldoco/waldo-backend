# Orchestrator (Mac): lane handoff, 13 Oct

Read `README.md` in this folder first. Tonight (12-13 Oct) the existing orchestrator session `local_281f8c04-1fc5-41f4-8fc8-4ac9e6558cf3` keeps this role, because no session can be started without the owner. A later fresh orchestrator replaces it by following this file, including its first-hour steps.

You own:
- the merge gate for both repos;
- staging deploys (the old L1 deployer role is now yours);
- Simulator QA on `iPhone 17`;
- this docs folder.

You don't write runtime or app code.

## First hour, in order

1. **Switch to auto mode:** `ccd_session_mgmt__set_session_permission_mode` with session "self" and mode "auto". The owner approves the card.
2. **Keep the Mac awake:** run `nohup caffeinate -i -t 21600 >/dev/null 2>&1 &` in the background. It changes no settings, and the owner knows.
3. **Set the heartbeat** with CronCreate: recurring, cron `3,23,43 * * * *`, prompt "Orchestrator heartbeat: re-read docs/planning/lanes-2026-10-13/README.md and ORCHESTRATOR.md, then run one cycle." On every wake, run CronList and re-create the job if it's gone.
4. **Tell the old orchestrator** (`local_281f8c04-1fc5-41f4-8fc8-4ac9e6558cf3`) that your heartbeat exists. It then deletes its own cron, so two orchestrators never merge at once.
5. **Find the new sessions** with `list_sessions`, using the titles from their chips: "Connectors", "App" and "Backend core". Message each one with your session id; they report to you.
6. **Retire the old lanes.** When a successor confirms it has read its lane file, send that old lane one message to stand down and stop taking work.
   - Old L1: `local_63e9825d-2a8f-4bf9-8dcc-6a2a4f50041d`.
   - Old L2: `local_83ce6587-5e6a-489a-a26a-24fb750048cf`.
   - Old L4: `local_2c085cba-5c08-4fef-8397-3e2dc1f95148`. It stands down only after P1's state is recorded.
   - Old L3: `local_63b3708b-d329-4698-b049-61fada649a9e`. It has been idle since 08:46Z on 12 Oct.

   Never archive, stop or delete sessions; the owner does that.
7. **Merge #1077** (this docs pack and the 12 Oct log) once its CI is green, so the pack is on `beta-mvp` for every session. It's docs only: a light review is enough.

## Each heartbeat cycle (keep it lean)

1. **Check:**
   - each lane: `get_session`, and `list_events` (last 15) when it's quiet;
   - open PRs and CI in waldoco/waldo-backend (base `beta-mvp`) and waldoco/waldo-app (base `main`);
   - staging `/healthz`;
   - new #116 comments (read only);
   - `get_usage`.
2. **Unblock:**
   - answer questions or decide them under the rulings;
   - relay between lanes;
   - give an idle lane its next item from its lane file.
3. **Gate and merge** what is ready (below).
4. **Deploy** a green tip when it carries something a user or a test needs (below).
5. **Log** in `docs/planning/lanes-2026-10-13/LOG.md`, a few lines per cycle: the time from `date -u` (run it in its own call; never guess a stamp), what changed, merges, deploys and blockers. Commit by path and push.

## The merge gate (every item is required)

1. **CI is green on the PR's current head,** all six checks: verify, four runtime shards, and Supabase migrate-from-zero with pgTAP. The app repo has no CI until the App lane adds it; until then, require its local typecheck and jest output in the PR.
2. **An independent review passes.** Use a fresh review subagent with a "no Agent tool" rule and a tool budget. It checks:
   - the diff against the PR's claims;
   - `CLAUDE.md`, `.claude/rules/*` and the security checklist;
   - contract safety (app.v1 is additive-only).

   Then ask the advisor.
   - **Where findings go:** to the lane in one message; for Ansh's PRs, as GitHub PR comments (owner ruling).
3. **GitHub reports MERGEABLE and CLEAN** against the current base.
4. **App contracts:** before any Worker emits a new app.v1 value, the App lane re-pins and confirms the app tolerates it.
5. **Merge** with `gh pr merge <N> --repo <repo> --merge --match-head-commit <full sha from git rev-parse>`. Then log it.

**Hold for the owner, even when green:**
- migrations: `supabase/migrations/`, a new DO SQLite table or DO migration lineage;
- production;
- secrets;
- new third-party services other than Expo;
- new places health data goes;
- PR D's guard deletions or downgrades (they change what blocks a merge);
- a PR whose behaviour rests on a product decision no ruling covers, unless it's flagged off.

## Deploys (staging, Worker only)

**Tooling (from L1's handover, 21:40Z).** Use L1's scratch dir as `$GSP`: `/private/tmp/claude-501/-Users-shivanshfulper-Developer-Pin4sf-waldo-backend--claude-worktrees-agitated-swanson-736b51/efae3256-6422-4a7c-9ace-29bb71b5a2fb/scratchpad`.
- `$GSP` already holds pnpm10 and `staging-gate.sh`; the memory copy is identical.
- Run `bash $GSP/staging-gate.sh <backend checkout> $GSP <sha>`.

**Habits:**
- Deploy clear of the :00 and :30 alarms.
- Re-check the tip just before `--deploy`.
- An in-flight app turn finishes on the old version.
- After a deploy, curl a signed-out `/app/v1/session` and confirm the 401 lands in the tail view.
- Classify any push-CI red before rerunning it.

**The live tail.** It writes `$GSP/tail-view.log`, filtered through `tailx.py` (16 hops plus `hops_total`), so it's safe to quote. The processes are supervisor PID 63114 and `wrangler tail` PID 47855. If you stop it, kill the supervisor first, then the tail, by PID only.

**connector-proxy is staging's Google path.** It's the Supabase Edge Function, still v17 from 10 Oct, and it imports `connectors/google.ts`. A Google connector fix reaches Vault-backed connections only after connector-proxy is redeployed, from the same SHA as the Worker. Deploy it from the clean detached checkout like this:

```
supabase functions deploy connector-proxy --project-ref togdshayyxycitzckpqv --no-verify-jwt
```

Run it inside `env -i PATH=... bash -c '...'`, with the access token exported inside the subshell so it never appears in argv or output.
- It's backend code, not a migration, so the owner's deploy ruling covers it.
- Rollback: redeploy the previous source.

1. **Gate script:** `bash ~/.claude/projects/-Users-shivanshfulper-Developer-Pin4sf-waldo-backend/memory/tools/staging-gate.sh <backend checkout> <scratch dir> <40-hex tip sha>`.
   - Run it first without `--deploy`, then with `--deploy` once it prints `GATE PASS`.
   - It needs pnpm 10.34.4 at `<scratch>/pnpm10`: run `npm install --prefix <scratch>/pnpm10 pnpm@10.34.4`.
   - It stops on a non-tip SHA, red CI, a wrangler, deploy or migration change, a pending hosted migration, or an unreviewed app-contract change.
   - Never paste the deploy log, because it prints environment bindings.
2. **Smoke check:** check these yourself after every deploy.
   - `/healthz` shows the release.
   - An unauthenticated `/app/v1/session` returns 401.
   - `POST /probe/turn` with a body and no token returns 403.
3. **Simulator QA** follows; see below.
4. **Record** each deploy: SHA, Worker version and rollback target, in LOG.md and as one #116 record. The deployer lane always posted its own deploy records there.
5. **The `v6` rename deploy (owner ruling)** is its own deploy, only after #1100's behaviour has passed a Simulator check on staging.
   - The gate script stops on its `wrangler.jsonc` change. So check the live-to-tip diff by hand: the only wrangler changes may be the `v6` `renamed_classes` entries and the binding rename (`TELEGRAM_OWNER_DO` to `OWNER_DO`); there must be no other migration tag or binding.
   - Then run the gate script's other steps.
   - Rollback after this deploy is forward-only, so fix forward. Say so in the record.

## Simulator QA (`iPhone 17`, after each deploy)

**Before you start:**
- The App lane owns P1 on the shared test account. Make no turns until it reports P1 done.
- Begin every turn with "QA:".
- Take a screenshot of each result, and note the trace id where the app or staging trace shows it.

**The core set:**
1. "QA: what's on my calendar today?"
2. "QA: summarise my important email from the last day."
3. "QA: remind me in 2 minutes to stretch." The reminder must appear in the app.
4. After the approval fix is live: "QA: draft a note to myself saying 'qa' and send it once I approve." An approval card should appear. Approve it, and then the send should be confirmed.

**For a specific fix,** add one check that would fail without it. For example, after the mail-reading fix, ask about the Razorpay meeting's Fireflies recap.

**Mark each step pass or fail.** File each failure to its owning lane with the screenshot path and the trace id. When the device's 12-hour sign-in lapses, ask the owner to sign in again. Never type codes.

## Morning summary for the owner (by 02:15Z, or when the owner returns)

Add a short section to LOG.md and the docs PR. It covers:
- what works on staging, with the Simulator evidence;
- merges and deploys;
- what is held for the owner and why;
- the owner's own tasks: uploading the Expo keys (APNs key and FCM service account), signing in again on the Simulators, any held PR.
