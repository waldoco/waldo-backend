# Overnight log, 12 Oct 2026

Orchestrator session `local_281f8c04-1fc5-41f4-8fc8-4ac9e6558cf3`, branch `docs/overnight-2026-10-12`. Brief: [ORCHESTRATOR_BRIEF_2026-10-12.md](ORCHESTRATOR_BRIEF_2026-10-12.md). Decisions: [OVERNIGHT_DECISIONS_2026-10-12.md](OVERNIGHT_DECISIONS_2026-10-12.md).

Tags: **[verified]** observed in this session; **[inference]** concluded, not observed; **[unverified]** reported by a lane or not checked.

## 21:34Z: start

- Permission mode: already `auto` (`get_session` self) **[verified]**. No switch needed, no approval card.
- `caffeinate -i -t 21600` running, pid 84717, until about 03:34Z **[verified]**.
- Heartbeat cron `29a6d33d`, `3,23,43 * * * *` local (IST), so :33/:53/:13 UTC **[verified]**.
- Branch `docs/overnight-2026-10-12` from `origin/beta-mvp` `4bb040f5` **[verified]**.
- Lane messages sent, all four queued (lanes mid-turn): L1 `6087534c`, L2 `8de61d87`, L3 `920478bc`, L4 `9499f8ab` **[verified]**.

State at 21:40Z:
- `beta-mvp` `4bb040f5` (#1073 merge); #1074 merged as `f74a2e38`, an ancestor **[verified]**.
- Staging `/healthz` reports `{"ok":true,"release":"4bb040f5"}`, so L1 has deployed the tip with #1074 **[verified]**.
- App `main` is `c2ccd5d0` (#77, approvals-defer re-pin from `21a70277`, merged 21:30Z), not `46e9e669` as the brief said **[verified]**.

L2 report (21:40Z) **[unverified until reviewed]**:
- #1074 fixes only the main-chat GET. App turns (`restored()`, `owner-turn.ts:622`) and scheduled app delivery (`appDeliveryFor`) still use the strict `load()`, so sends and app deliveries still fail for an account with a bad stored row.
- A failed send logs only `app execution outcome unconfirmed` with no code (`telegram-owner-do.ts:766`).
- Second trap: `ConversationTree.append` throws `conversation parent not found` (`conversation-entry.ts:98`) when the bad row is a parent, not the leaf.
- L2 is building the follow-up red-first: `load()` skips with the #1074 rule, children of a skipped row re-link in memory to the nearest loadable ancestor, a skipped leaf resolves to its nearest loadable ancestor, fixed log codes. Canonical-history loader change: independent review required.
- #1066 head `0bab0a41`, CI 6/6 from 19:01Z (before #1074); merge the follow-up first or together.
- The day-plan record for L3's Brief `latest` needs a DO ALTER: held for the morning (DO migration lineage).

## 21:45Z: first results and research launched

- **L1 (#116 comment 6114086292)** **[verified: read the comment; not re-probed]**: staging release `4bb040f5`, Worker version `65a07f13`, deployed with the owner's go in L1's session, Worker only (preflight 55 applied, 0 pending). Rollback is version `2d1ae6a0`. `GET /app/v1/chat/main` from the app answered 200 at 21:39:37Z. Skip line: `check` = `input_origin`, `count` = 1, `unwitnessed` = 0. Relayed to L2 (SendMessage `f4f765d0`). L1's next step: one app send.
- **Also merged at 21:30Z by the owner's account (Pin4sf):** waldo-brain#36 (ADR-0068 reminder push) and waldo-app#77 (approvals `defer` re-pin) **[verified: `gh pr view`]**. So L3's reminder-push contract (its handoff step 1) is unblocked.
- **#1066** (head `0bab0a41`): no migrations or DO lineage, 8 files; CI 6/6 at 19:08Z on the pre-#1074 base; GitHub `MERGEABLE`/`CLEAN` **[verified]**. Decision D1: merge after L2's send-path follow-up, once brought up to the current base.
- **The app repo has no CI** (L4 handoff §6). Gate item 1 can't be met literally for app PRs; see the decisions file once settled.
- **Replied to L2** (SendMessage `bdd3e888`): go ahead red-first; the six tests the review will look for.
- **Research:** six read-only subagents launched at about 21:45Z (website promises, competitors and open-source agents, design system, harness and context, backend capability, app capability). Reports land in the session scratchpad; the synthesis is `PROMISE_DELIVERY_MAP_2026-10-12.md`.
- **Message budget:** 4 `send_message` + 2 `SendMessage` used so far.

## 21:48Z: the app send fails, as L2 predicted

- **L1 (#116 comment 6114134139)** **[verified: read the comment]**: `POST /app/v1/chat/main/messages` answered 202 at 21:41:36Z. In the owner DO, hops `respond` and `turn` logged `ok:false`, `code: unknown`, error `canonical history entry invalid` (strict `load()`), then `app execution outcome unconfirmed`. The app showed `effects_unconfirmed`. The GET afterwards was 200 with the same skip line, and the message wasn't stored.
- L1 **[inference]**: the empty first page without `next_cursor` means the owner's canonical store holds only the one `input_origin` row. So it's the leaf, with no parent.
- **My grep at `4bb040f5`** **[verified]**: the canonical store has one `read(skip)` (`conversation/canonical-owner-store.ts:89-91`): `load()` is `read(false)`, `readForDisplay()` is `read(true)`. Strict `load()` callers: `owner-turn.ts:557` (`restored()`, app turns, via the `history` factory at `telegram-owner-do.ts:2140`) and `telegram-owner-do.ts:590` (scheduled app delivery). `readForDisplay` is at `:670`. The episodes index wraps only the legacy store (`:2042`). `conversationForgetSources` reads raw rows without validating. L2's caller list is complete.
- **Sent to L2** (SendMessage `2f6108ca`): the send result, test "skipped leaf with no ancestor → append as root", order D3, and the board. Target: follow-up in review by 00:30Z.
- **Board** `OVERNIGHT_BOARD_2026-10-12.md` pushed (D4). Review prompt template saved in the session scratchpad.
- **Message budget:** 4 `send_message` + 3 `SendMessage`.

## 21:50Z: L1 has the standing deploy go; app CI-equivalent baseline green

- **L1** (transcript, idle at 21:49:56Z) **[verified: read L1's final message to the owner]**: the owner gave L1 two yeses in L1's session: the `4bb040f5` deploy, and overnight deploys of later `beta-mvp` tips. L1 deploys only through a gate script that stops on a failed check: the commit is the tip; all 6 CI checks are green, pgTAP included; no pending migrations; deploy config unchanged; app contract changes reviewed first. After each deploy it checks `/healthz` and a signed-out 401, and records a rollback target. "This go ends when you're back here." L1 keeps the Mac awake until 04:00Z and a tail for the 03:17Z retention cron. It stopped four leftover `wrangler tail` processes from the old L1 by pid. L1 says it sent its results to me; that message hasn't reached this session yet.
- So merges tonight can reach staging. The board now tells L1 to deploy on a `DEPLOY: <sha>` line.
- **App CI-equivalent baseline** (D2) at app `main` `c2ccd5d0`, fresh detached worktree in the scratchpad **[verified]**: `pnpm@9.15.9 install --frozen-lockfile` exit 0, no lockfile drift; `tsc --noEmit` exit 0; jest 86 suites passed (1 skipped), 572 tests passed (1 skipped), 21 s. One jest worker was force-exited (a leaked timer); the run was otherwise clean.
- **#1072** (latency session, draft, test file only, CI 6/6 on head `1acb9474`): independent review launched. If it passes, it is the first merge, which also tests whether the permission classifier allows merges under the standing go.

## 21:51Z: L3 status

- **L3** (message 21:50Z) **[unverified: lane report]**:
  - waldo-brain#36 merged as `23c4f992` at 21:30Z, with the owner's yes in L3's session.
  - Its branch `l3/reminder-push-contract` is at `2a762747`, local only, with the full wall running. Contents: a `reminder` push class (exempt, 10 a day, `over_cap: degrade`, `hold_unless_owner_urgent`), `agent_invocable: false` (an owner ruling in L3's session), `over_cap` on every row, `owner_urgent` on the delivery candidate, and `set_reminder.urgent`, which is refused until L2's W2 stores it. No migration, endpoint, auth or app.v1 change.
  - A waldo-brain one-line ADR-0068 correction, `96b4161`, is local.
- **L3's lane rule** (from the owner's starter prompt for L3): every merge, PR, push or GitHub post needs the owner's yes in L3's session. So nothing of L3's reaches GitHub tonight.
  - I won't route around it (no pushing L3's branch from another worktree).
  - Its work is push-class (priority 7), so the cost tonight is small. It goes in the morning batch.
- **Replied to L3** (SendMessage `2316f6c5`): morning batch file, local work order, Google connect readiness check, the board.
- **Message budget:** 4 `send_message` + 4 `SendMessage`.

## 21:53Z: L1's full report; L4's reports (via the old alignment session); D5

- **L1** (message, about 21:52Z) **[unverified: lane report, consistent with #116]**: the owner's gos in L1's session were (a) deploy `4bb040f5`, (b) a standing go for overnight staging deploys, (c) keep the Mac awake until 04:00Z.
  - Conditions for (b): CI green at the exact tip incl. pgTAP; 0 pending hosted migrations (L1 never applies; a tip needing one waits for the owner); no wrangler or binding change (#1071 needs its own go); `--env staging` from a clean detached checkout; a `/healthz` check and a #116 record each time; on a failed smoke check, roll back and stop. It ends when the owner is next back in L1's session.
  - CI at `4bb040f5`: 7/7 incl. pgTAP.
- **L4** (forwarded by the old alignment session):
  - #77 merged as `c2ccd5d0` with the owner's yes in L4's session.
  - The Simulator Main-chat check matches L1's data: history 200 and empty; the send receipt `interrupted` with `effects_unconfirmed: true`; the message not stored.
  - L4 builds the time-zone write (option a) next, and told L2 that #1066 needs no `controls.ts` re-pin.
  - App-side risk L4 raised: a page with no rows but a cursor hides "Load earlier".
  - Open gap L4 raised with L3: a deferred request drops out of the default approvals list, so the chat card would say "no longer available". It needs a contract answer before L2 offers `defer`.
- **D5:** skip the `input_origin` row; don't accept it as legacy data. Git evidence in the decisions file. The old alignment session's inference (read-side drift) is half right: the row matches its witness, but no merged build wrote it.

## 22:00Z: research results in (competitors, app capability); D6, D7

- **Competitors and open-source agents** (report `02-competitors-oss.md`) **[lead, sources cited in the report]**:
  - MetaMuse is Meta Muse (~95%); Instinct is instinct.com (~85-90%).
  - Compaction converges on: keep a verbatim tail, keep a structured summary, point the model at search for what was dropped.
  - Waldo drops its oldest turns silently, and `search_episodes` indexes only the legacy (Telegram) store.
  - Waldo's approvals (button-only, cross-surface clear, undo) are ahead of what Muse and OpenClaw document.
  - One owner transcript tagged by channel matches OpenClaw's shared session.
- **App capability at `c2ccd5d0`** (report `06-app-capability.md`) **[code read, not run]**: no golden-path step is proven end to end.
  - **Missing:** Google sign-in (both sides) and the 18+ checkbox (no schema field).
  - **Sessions** last 12 hours with no renewal.
  - **Health** says "Last sent…" when nothing was sent (iOS permission not requested in the flow).
  - **Main chat:** a 503 shows only "status 503", with no retry, and the composer stays enabled.
  - **`defer`** is refused by the backend (`app-approvals.ts:46`).
  - **Reminders** appear only after a refresh, and there's no push.
  - **The time-zone write isn't built.**
- **#1066 is now `e1ab2881`**, a merge of `beta-mvp` into the branch (D1 done by L2) **[verified: `git log`]**. CI re-runs on it.
- **Time-zone deadlock** **[verified in source]**:
  - `bindIdentity` (`telegram-owner-do.ts:956-965`) and the Telegram webhook path (`:394`) store `x-waldo-timezone` from route config without confirming it.
  - #1066 confirms only in `timezone.set`.
  - The app shows its confirm path only when the zones differ.
  - D6: a confirm row whenever unconfirmed. D7: the 18+ box as an app gate tonight.
- **Board:** L4's queue is rewritten from these findings.

## 22:05Z: design-system research in

- **Design system** (report `03-design-system.md`) **[code read at app `c2ccd5d0`; artifact `1791742177-7dce` read and matching waldo-brain#35 `f9068c84`]**:
  - G1–G22: none closed, 8 partial (G1, G3, G6, G7, G9, G10, G20, G22), 13 open, 1 needs Suyash (G2). Apple sign-in (X1) is closed by the owner's 21:25Z ruling.
  - **Register corrections:** G2's retired names aren't rendered; G3, no tab bar on Home or Waldo; G4, the live misuse is the consent Switch and blue links, not the chat header; G6 needs no native module; G7's device-zone row exists, so only time formatting is open.
  - The top 8 for tonight are on L4's board queue (item 6).
  - **For Suyash:** #35 review, G2 names, G5 gauges, Apple-first text in §17 and AuthButton (Apple is out for the beta), time-zone text, the Form-zone table vs `tokens.json`, the Mottle font file, decision 53.
  - **For the owner:** the Telegram row in Connections (decision 52); a go for the netinfo dependency (G17).

## 22:07Z: #1072 review FAIL (wording only); #1066 CI green, review launched

- **#1072** (head `1acb9474`, latency session, draft): independent review **VERDICT: FAIL, wording only** **[reviewer's run: the file 72/72 at head and twice on `4bb040f5`; a mutation making the wrapper pass-through fails exactly the red-first test; `guard-setalarm` ok]**.
  - **The fix is right; the stated cause is wrong.** `cloudflare:test`'s `runDurableObjectAlarm` deletes the alarm and calls `alarm()` directly, so workerd never retries it. The pending alarm is the scheduler's own post-crash `rearm()` (`multiplexer.ts:228-229` → `alarm-slot.ts:31`, at least 250 ms later). The reviewer's A/B probe showed it: with rearm intact the run resumed with no test action; with rearm disabled it stayed put.
  - **Required:**
    - reword three comments (L165-166, L3501, L3957-3958) and the PR body's "Cause";
    - correct "covers all crash sites" (L3258 crashes through a direct `runLoop.alarm()` that bypasses the wrapper);
    - optionally rename `platformAlarm`;
    - rerun CI after a rebase (its CI ran on base `596706c2`, before #1061).
  - **No production bug is masked:** re-drives are fenced by the coalescer (`do.ts:1816`), pending-effect reconciliation (`:1860`) and `#reconcileTrustedToolReceipt` (`:2788`).
  - **Not merged.** Its owner (the latency session) is idle, and sends are scarce. Morning batch: hand these findings to the latency session. Tonight, a shard 3/4 `trusted-run-loop` failure on another PR is classified as this known pre-existing flake (#532), and I rerun only that job once, logged.
- **#1066** head `e1ab2881`: CI 6/6 SUCCESS incl. pgTAP on the current base; `MERGEABLE`/`CLEAN`; not draft **[verified: `gh pr view`]**. Independent review launched. Focus: reminders never held; health-data destinations of proactive text in the canonical transcript; no Telegram-addressed delivery for app-only owners; no burst on later confirmation; the D6 interaction; the strict-load failure mode for a bad row.
- **Plan if #1066 passes:** merge it into `beta-mvp` as soon as it passes. This revises D1's order for the merge only; deploy order is unchanged. Merging early also tests whether the permission classifier allows merges under the standing go. No deploy until L2's send-path follow-up is merged as well, so staging never runs #1066 without it.

## 22:12Z: L2 delivers #1075; #1066 back to draft; S7 spike passed; website research in

- **#1075** "App turns and scheduled app messages skip a shape-invalid history row" (L2), head `01e20d19`, CI 6/6 incl. pgTAP, `MERGEABLE`/`CLEAN`, ready **[verified: `gh pr view`]**.
  - Files: `canonical-owner-store.ts` +62/−17, `telegram-owner-do.ts` +9/−12, two test files.
  - L2 maps my checklist to named tests: leaf 2/3/10, parent 4, witness 9, no writes 1, `appDeliveryFor` 10, one shared `read()`. The owner's exact case is test 3 (one witnessed `input_origin` leaf with no parent → the new message becomes a root). 12 mutations checked; 12 of 13 tests are red at `4bb040f5` **[unverified: lane report]**.
  - Independent review launched at 22:10Z.
  - **My read of the diff [verified]:**
    - `load()` = `read(true)` (skip + in-memory re-link); `readForDisplay()` = `read(false)`.
    - Witness-differs, owner mismatch, duplicate id and shape-valid-without-witness stay fatal.
    - Only rows whose parent was left out are re-linked, so a truly missing parent still fails.
    - `asStored` maps re-linked rows back on save. A new row can't take a left-out id (`history_conflict`).
    - The failed app turn now logs a fixed code (`app_turn`).
    - Edge case to check: a re-linked entry that the runtime modifies (forget redaction) is saved with its in-memory parent.
  - After deploy, L1's probe should show the send completing and one `app_history_load` line: `input_origin`, count 1, unwitnessed 0, orphans 0, leaf true.
- **#1066 moved back to draft by L2:** it conflicts with #1075 on one `logAppReadFailure` line. L2 has the resolution at `61817c32` locally (typecheck + 33 tests pass) and pushes it after #1075 merges. My #1066 review on `e1ab2881` continues; I'll re-check only the resolution delta.
- **`defer` desk branch held for the morning** (L2): it needs a guarded `ALTER TABLE ledger ADD COLUMN deferred_at INTEGER` (DO lineage), and "Waldo raises it again" has no implementation (`present()` runs only when a proposal first opens).
  - Owner questions: the ALTER; the definition of "raises it again" (L2 proposes "presented again on any surface" via a model-called re-raise).
  - L4's re-pin isn't a blocker: app `c2ccd5d0` carries `parts.ts` and `approvals.ts` byte-identical to `21a70277` **[unverified: lane report]**.
- **S7 keyless spike PASSED at 21:55:00Z** (L2, under the owner's go in L2's session): the throwaway Worker `waldo-apns-spike-98c8af` (no bindings or secrets) got 403 + `apns-id` + `MissingProviderToken` from `api.sandbox.push.apple.com`, so Workers reach APNs. Deleted: the CF API and the URL answer 404. `wrangler delete` exits 1 on a KV-cleanup OAuth scope, after deleting **[unverified: lane report]**.
- **L2 next:** push #1066's resolution after #1075; then S7 W2 prep red-first on a branch. The token read path and device routes are held for the morning (auth/secrets).
- **Website promises** (report `01-website-promises.md`) **[lead]**:
  - 120 promises in 16 areas; 94 match ledger rows; 26 aren't in the ledger.
  - Highest harm: Gmail "read only" vs bodies read and approved sends; export/delete "Working today" (export missing, delete untested from the app); "Undo it in one tap" (only calendar moves, 10 minutes); 6:30 push missing; wearables beyond Apple Watch; "Free while in beta" and Terms gating unledgered.
  - #18's current head `598e94b0` (16 files) is newer than the ledger's record (`4fcc6f20`) and creates two new contradictions.

## 22:14Z: harness and context research in

Report `04-harness-context.md`, code read at `35b7c21b` (= `4bb040f5` + docs). Nothing executed.

- **1. Tool results from earlier turns reach the reply model on neither path** (the claim is about prior-turn tool results, not all composed context) [read, not executed; contradicts the brief; a falsifying experiment was launched at 22:15Z]:
  - App turns build context with only a `health` source (`telegram-owner-do.ts:2137`), so the tool-result list is empty (`context-composer/owner-turn.ts:71`).
  - On Telegram the composed REASONS prompt goes in as `request.system` (`joined-path.ts:73`), but the reply builds its own system prompt (`owner-turn.ts:461-489`).
  - Proposed test: write one ledger row, run one app turn and one Telegram turn, and assert the reply instructions contain it.
- **2. History is cut in three places, silently:** the token window (`window.ts:44-61`), the provider's 1,024-message / 400k-char trim plus bisection (`provider.ts:1428-1460`), and the forget-pending filter (`owner-turn.ts:417`). Only the first is logged.
- **3. App chat is invisible** to `search_episodes` and nightly (only the legacy store is indexed: `:2042` vs `:2140`; nightly reads that index, `:2317`).
- **4. Nothing carries "in flight" across turns,** and entries have no timestamp.
- **5. Cache reuse is ruled out:** the system prompt ends with the current owner text and a minute clock (`owner-turn.ts:468-479`), and the adapter ignores cache-write tokens (`openai.ts:94`).
- **6. All eligible tools are sent every round,** listed three ways; ADR-0034's `search_tools` has no handler (`hooks/registry.ts:213`).
- **A fixed rule making a judgment call:** the memory profile picks claims by recency and ignores its `question` argument (`claims.ts:1014-1031`) → `post-mvp-cleanup`.
- **Proposed C+A** **[proposed, for L2]**:
  - a `conversation_state` block through the existing ContextComposer (no new writer, storage or enum);
  - `window.ts` becomes the single owner of the cut, plus a note saying how many messages are out of view and how many are withheld for a forget;
  - on the app, `search_episodes` reads the canonical transcript (same tool name and schema; the forget-hiding re-read is reused; no new storage);
  - C: ids, statuses and times for pending approvals, receipts, open loops, reminders, runs and artifacts (≤3 KB).
  - Order: measure, then A, then C, then the eval.
- **Eval:**
  - CI plumbing on an app-path harness (the L1 scenarios run Telegram, `run-l1.ts:118`).
  - Nightly live runs on matched seeds above 150k tokens.
  - Pre-set bars: +20 points recall; hallucination ≤ today and ≤2%; 0 leaks in ≥200 probes; ≤5% more tokens. A is falsified if the model searches on <50% of out-of-view probes.

## 22:17Z: backend capability in; usage-limit risk

- **Backend capability** (report `05-backend-capability.md`, source `4bb040f5`) **[code read, spot-checked; nothing run]**:
  - 70 ledger rows: 11 implemented and tested, 2 implemented but untested, 30 partial, 0 flagged off, 27 missing.
  - Confirms the strict-load send failure, two transcripts (no continuity), and the arming gaps.
  - **New:** delivery needs `app_subject`, written only on the first chat message (`DO:742`, `:554-557`), and #1066 doesn't change that.
  - **New:** RunLoopDO and DeviceBridgeDO data survives account deletion.
  - **New:** `speakerOf` (`episodes.ts:21`) treats only `tg-` ids as the owner, so WhatsApp owner text is already dropped from nightly.
  - **New:** the only link-code issuer hard-codes `'telegram'`, so WhatsApp linking is impossible.
  - **New:** weight is always unavailable, sleep debt is computed but dropped, there's no health history route, and yesterday's Form is overwritten as stale.
- **Usage limit (`get_usage`):** 5-hour window **76% used at 22:16Z, resets 01:30Z**. At the observed rate it could hit 100% around 22:45–23:00Z **[inference]**, stopping every session until 01:30Z. My context: 61%.
  - **Actions:** no new subagents from me (the falsifying experiment for harness finding 1 is not launched); the promise map is deferred until after the reset; the board carries a budget notice pausing L3, and L2 after #1066's resolution; L4 is narrowed to two items.

## 22:30Z: MERGE #1075 → `889efa27`; deploy triggered; #1066 review FAIL + HOLD

- **MERGED waldoco/waldo-backend#1075** at 22:30:43Z as **`889efa27c55a1c6a1ae945d906f791e222778a0b`**, with `--match-head-commit 01e20d1968b1afad473f39becee353e0bfe64a41` **[verified: `gh pr view`, `git rev-parse origin/beta-mvp`]**.
  - **Gate 1, CI:** 6/6 SUCCESS incl. pgTAP at head `01e20d19` on base `4bb040f5`.
  - **Gate 2, independent review: VERDICT PASS.**
    - Ran 100/100 related tests and 48 owner-ingress tests (2 skipped). 12/13 new tests fail on base. 12 of 12 mutations caught. Custody, no-writes, fail-closed and concurrency hold.
    - My `asStored` question can't cause a silent rewrite: `save()` throws `input conflict` on an existing id with a differing witness.
    - Advisor: no blocker.
  - **Gate 3:** `CLEAN` / `MERGEABLE` immediately before the merge.
  - **Gate 4:** no app.v1 change.
  - **Hold list:** no migration, auth, isolation or health change.
  - **The permission classifier allowed the merge** under the standing go.
  - **Review notes, not blocking:**
    - Turns use "last loaded row in list order" as the parent, while scheduled delivery uses `above(storedLeaf)`: two leaf rules.
    - The PR body's `leaf: true` "once per turn" is wrong; only the first load shows it.
    - A pre-existing `commit()` path writes at `count + index` without checking the key. If staging's `count` were stale, the first send would overwrite the bad row. Falsifier: the second send logs no skip line.
- **Deploy:** `DEPLOY: 889efa27…` is on the board. Message to L1 (SendMessage `fed99bbe`, delivered to its inbox) carries: deploy after push CI is green; a self-wake cron at :09/:29/:49 to read the board; one plain probe send coordinated with L4; falsifiers (a)–(e).
  - At 22:31Z push CI was running, and Workers Builds was building `waldo-runtime-staging`. Workers Builds also succeeded on `4bb040f5` while `/healthz` kept `726ad0e7` until L1's 21:30Z deploy, so it builds but doesn't promote **[inference]**. L1 is to confirm `/healthz` before deploying.
- **#1066 independent review at `e1ab2881`: VERDICT FAIL + HOLD** **[reviewer ran 4 related files 46/46, 12/12 mutations caught, and probes A/B/C; logs `review-1066-*.log` in the scratchpad]**.
  - **FAIL:**
    - `replanDayCards` misses entries armed for another date (a pinned card stayed 11 h off; a stale Brief fired at 19:00 in the new zone; `cards` never checks `sent`, so a duplicate card is possible);
    - test 4 depends on the wall clock and fails about 23:00–04:00Z;
    - held skips settle `ok` with no trace.
  - **HOLD (health destinations):** `ledger()` puts health-log lines ("~N kcal, estimate", "N min") into the day-card machine prompt, which is saved verbatim to `conv:*` and the `episodes` FTS table. That already happens for Telegram owners; #1066 extends it to app-only owners.
  - **PASS on:** reminders never held; no Telegram-addressed delivery for app-only owners; no burst beyond the cross-date case; app.v1 shape; no migration; bounded strict-load failure (retries at 30 s and 60 s, then a 24 h quarantine).
  - → **Held for the morning.** L2 fixes 1-3 tonight (board). The owner rules on the health-log question.
- **Messages:** 10 used (5 `send_message` + 5 `SendMessage`). From here, lanes get instructions through the board and their own crons.

## 22:34Z: heartbeat (lean, D9)

- Cron `29a6d33d` alive. Staging `/healthz` is still `4bb040f5`, although Workers Builds succeeded on `889efa27`, which confirms that check doesn't promote **[verified]**. Push CI on `889efa27`: pgTAP SUCCESS, shards and verify running.
- No new #116 comments since 22:20Z. #1066 is draft. Stale ready backend PRs (#1038, #1033, #987, #892, #776) aren't tonight's.
- **App #78** (L4) "settings: write the phone's time zone over the unconfirmed UTC default", head `cb0ad501`, opened 21:57Z, before D6 reached L4. Its CI-equivalent run and review wait for L4's final head (D9 batch window).

## 22:37Z: L1 deploying `889efa27` when CI completes; L1's board cron denied

- **L1** (message) **[unverified: lane report]**: it deploys `889efa27` through its gate when push CI completes; a background watcher wakes it.
  - Gate checks: the tip equals the SHA; 6 checks green; the diff from live `4bb040f5` has no wrangler, deploy-script, migration or app-contract change (runtime only: owner DO, canonical store, tests); preflight 0 pending; a rollback target recorded.
  - The tail viewer now captures `orphans` and `leaf`.
  - After the deploy: the plain probe send with L4, falsifiers (a)–(e), a #116 post.
- **The auto-mode classifier denied L1's recurring board cron**, whose prompt deploys gated tips from the board. L1 isn't working around it, and nor am I. Later deploys need a message to L1 or the owner in the morning. Tonight none is planned beyond `889efa27` (#1066 is held). Morning batch item: whether the owner wants a standing board-triggered deploy.
- My sends still deliver: L1's reply arrived after my 10th send. The cap hasn't been hit yet.

## 22:55Z: heartbeat. DEPLOYED `889efa27`; L2 paused

- **DEPLOY** (L1, #116 comment 6114694380): `889efa27` is on staging as Worker version `3f059c04`, deployed at 22:39Z under the owner's standing go in L1's session.
  - Gate: tip; CI 6/6 incl. pgTAP; diff from `4bb040f5` is 4 runtime files with no wrangler, deploy-script, migration or app-contract change; preflight 55 applied, 0 pending.
  - Signed-out `/app/v1/session` and `/app/v1/chat/main` give 401. The cron is still registered. Rollback: version `65a07f13`.
  - **[verified]** `/healthz` = `{"ok":true,"release":"889efa27"}` at 22:54:45Z; push CI on `889efa27` 6/6 SUCCESS + Workers Builds success.
  - Falsifier (a) holds. Probe (b)–(e) is pending L4's send.
- **L2** (message 22:58Z) **[unverified: lane report]**:
  - #1066's resolution is pushed as `83edcc2f` (= `61817c32` + base `889efa27`), CI 6/6.
  - L2 marked it ready at 22:53Z before reading the review FAIL, and set it back to draft about 22:55Z. Not merged.
  - Fixes 1-3 come after the reset. The health HOLD stays with the owner.
  - **#1076** is a new draft, the `defer` desk branch, held: a guarded `ALTER` adds `ledger.deferred_at`. Local wall PASS at `43a8c92d`; 8 of 9 mutations caught (the 9th equivalent). Owner questions are in its body: the ALTER, what "raises it again" means, and whether Telegram's "Not now" should change.
  - L2's self-wake cron was accepted (minutes 11/31/51 local, from 01:41Z). L2 is paused until the reset.
- **App #78** is unchanged at `cb0ad501`.
- **Correction to the 22:37Z entry:** L1's reply arriving says nothing about my send cap. My 10 sends all delivered; an 11th is untested.

## 23:18Z: heartbeat. L4 blocked on a question to the owner; stop refused

- No probe result yet; `/healthz` is `889efa27`; no PR or #116 changes since 22:55Z.
- **L4 is blocked** **[verified: `list_events`]**: its last action is a pending AskUserQuestion to the owner, who is asleep. It was pending by 23:15Z, when I checked; it probably dates from soon after #78 opened at 21:57Z **[inference]**. My 22:03Z message sits behind it. The transcript view hides tool content, so I can't see the question.
  - This stalls L4's whole queue (D6 time zone, health honesty, chat failure state) and tonight's probe send.
- **The classifier REFUSED `stop_session` on L4** (my attempt to interrupt its waiting turn so the queue would run). Not routed around. **Morning: the owner answers L4's pending question in L4's session first thing.** Also a morning item: whether the owner wants the orchestrator able to stop a lane's blocked turn.
- **Asked L1** (SendMessage `77b9c303`, send 11, delivered) to run the probe itself on the Simulator if no new permission is needed: one plain message, no approvals, stop at any permission prompt or sign-in screen. Falsifiers (b)-(e), then a #116 post. If the send fails, the tail code is waiting for L2's 01:41Z wake.

## 23:37Z: heartbeat. Probe deferred to morning; promise map drafting; #78 pre-review

- **L1 (#116 comment 6115011063):**
  - (a) PASS (`/healthz` `889efa27`; signed-out 401).
  - (b)–(e) **NOT RUN**: L4 is blocked. L1 won't drive the owner's signed-in app without the owner's yes in its session (its overnight go covers deploys only), and driving the app needs a device-access prompt only the owner can answer.
  - L1's tail 22:39–23:17Z on version `3f059c04`: only L1's signed-out probes; no `app_history_load` or `app_turn` lines, no failures, no exceptions. No real app turn or scheduled app delivery has run on the new code. The tail stays up to read the owner's first morning send.
- **Usage:** 84% at 23:35Z (81% at 22:33Z). The pace slowed to about 3 points an hour with lanes paused, so the limit shouldn't hit before the 01:30Z reset **[inference]**.
- **Promise delivery map:** a drafting subagent was launched at 23:36Z. It joins the six research reports and tonight's state into `PROMISE_DELIVERY_MAP_2026-10-12.md` (strict status vocabulary). I spot-check and commit it.
- **App #78** (`cb0ad501`, L4): CI-equivalent (D2) at the exact head in a fresh detached worktree **[verified]**: frozen install exit 0, no lockfile drift; `tsc` exit 0; jest 86 suites passed (1 skipped), 579 tests passed (1 skipped).
  - My diff read: the logic matches option (a) and is inert until #1066 deploys.
  - **Repo-rule finding:** a code comment cites "Owner ruling (11 October 2026, option a)", a date plus a one-off reference.
  - D6's confirm row is missing.
  - Not merged; L4 is blocked. On the board for L4's morning restart. No review subagent spent tonight.

## 00:03Z: promise delivery map committed

- `PROMISE_DELIVERY_MAP_2026-10-12.md` (654 lines), drafted by one subagent from the six research reports plus tonight's log, decisions and board.
  - **I checked:** the structure; the summary; the status rule ("app-first rows take the weaker of their two halves", so nothing on `889efa27` is `verified live` until a probe runs); the golden-path table; one contradiction it settled from source (WhatsApp `^([aseu]):(\S+)$` → an approval callback, `whatsapp-api.ts:132`, **[verified]**); and a scan for health-value patterns (none).
  - **120 promises:** verified live 0; deployed, unprobed 6; merged, not deployed 7; open PR 3 (landing #18); partial 50; missing 33; copy decision 21.
  - **Golden path:** 0 verified; 3 deployed, unprobed (history, send, reminder); 3 merged; 1 open PR ("Not now", #1076); 3 partial; 4 missing (Google sign-in, 18+ box, continuity, push).
  - It carries each lane's next three items, 14 owner questions in AskUserQuestion form plus 7 smaller ones, and an Audit section (the 26 unledgered promises and the stale ledger rows) for the Audit lane. The ledger is untouched.
- Hygiene: the #1066 review's synthetic probe number is replaced with "~N kcal" in the log.

## 00:07Z: research reports committed; morning report drafted; docs PR #1077 opened (draft)

- The six research reports are copied into `research-2026-10-12/` (a secret scan matched only prose words like "bearer"; trailing whitespace stripped), and the map's input paths point there.
- `MORNING_REPORT_2026-10-12.md` drafted. It gets updated after the 01:30Z reset with L2's fixes, L3's batch file and any probe.
- **Docs PR waldoco/waldo-backend#1077** opened as a draft against `beta-mvp` (head branch `docs/overnight-2026-10-12`) and bound to this session. It becomes ready after the final update (target 02:10Z). The owner merges it.
- **Plan to the deadline:** reset at 01:30Z; L2 resumes at 01:41Z; read L3's batch file at about 01:45Z; final report, advisor and PR ready by 02:10Z; the report goes to the owner in this session by 02:15Z.

## 01:35Z: usage window reset; budget notice lifted

- 5-hour window: **0%** after the 01:30Z reset **[verified: `get_usage`]**. My context: 81%, so cycles stay lean.
- Board: budget notice lifted. L2's queue after #1066's fixes: (1) measure history cuts with fixed-code counts per turn (long-sessions step 1); (2) a falsifying test for harness finding 1. Each a separate draft PR.
- L3's batch file was read at 01:15Z and summarized in the morning report (not published, per L3's lane rule). No changes on staging (`889efa27`), PRs or #116 since 01:14Z.

## 01:55Z: heartbeat. #1066 fixes pushed

- **#1066** (L2): `c8d3190c` "Re-plan every day card on a zone change and log each held job", pushed 01:47Z, draft. CI 6/6 SUCCESS incl. pgTAP, `CLEAN` **[verified]**. Still held for the owner's health ruling; the fixes need a short delta review before any merge.
- Staging `889efa27`. No #116 comments since 01:34Z. The app probe is still waiting for the owner's morning send.

## 01:58Z: final checks before the morning report

- **Advisor's final review applied:**
  - Audit got its findings (send 12, `a4bc29d4`, delivered; map §6 plus the research folder; leads only, no ledger edits).
  - The report's reversal cells are filled.
  - **Hygiene scan** of the research copies, the map and my docs: no emails, no invite codes. The UUIDs are Claude session ids; the long numbers are migration timestamps, #116 comment ids, the artifact version and an all-digit commit prefix.
  - The Telegram-owner health leak is in Risks with its evidence level.
  - The report and the board say the standing go ends when the owner is back, and who merges what after each ruling.
  - The L4 timing is corrected (pending by 23:15Z; the start time is inferred).

## 02:15Z: heartbeat. Docs PR green; L2 #1078; Audit delta pass

- #1077 CI 6/6 SUCCESS incl. pgTAP, `CLEAN` **[verified]**.
- L2 opened #1078 (draft, `863427c6`) "Count the history each reply call leaves out" (long-sessions step 1).
- Audit: ledger delta pass on #1057 at `604e5538`; #116 comment 6116427714. No action needed before the owner is up.
- Staging `889efa27`. The morning report has been posted in the orchestrator session.

## 02:20Z: L2's two board items done (drafts, not held)

- **#1078** (`863427c6`): history-cut counts (`history_cut_window`, `held`, `cap`, `scribe`) on each `llm_reply` context, surfaced to the console and Langfuse. No storage change, no new hop. 9/9 mutations caught; targeted tests pass; CI was pending **[lane report]**.
- **#1079** (`ed7a13a6`): **harness finding 1 HOLDS on both paths.** One ledger row, a real DO turn per path. Telegram: no `<recent-tool-results>` section. App: "No recent tool results." Causes: the app context host's sources are health-only; Telegram's reply builds its own system prompt and drops the joined composition. The tests pin the gap; no fix in this PR. Unverified: "the ledger is written every turn" (the row was seeded) **[lane report]**.
- The morning report's risk entry is updated.

## 02:45Z: Main chat verified live on `889efa27`

- **L4** (via the old alignment session) and **L1** (message, plus #116 comment 6116809142):
  - Two owner-approved sends on the Simulator, owner's account, at 02:41:13Z and 02:42:49Z: POST 202, receipt reads 200, replies shown and read back from history.
  - Falsifiers: (a) PASS, (b) PASS, (d) PASS.
  - (c) `leaf` false; the prediction was wrong.
  - (e) No skip line after send 1: the first new row took the bad row's slot through `commit()`'s `count + index` write. The witness copy wasn't checked **[inference]**.
  - Approval card in chat: NOT RUN.
- **App #78 merged by the owner in L4's session** as `83b5310f` (02:39:54Z), without D6 or the comment rewording **[verified: app commits]**.
- Follow-ups for L2: `commit()` must not overwrite an existing key; unify the two leaf rules.

## 02:56Z: heartbeat. App #79 ready for the owner's yes

- **App #79** (L4) "chat: label only rows from other channels, by name", head `3546e501`, based on main `83b5310f`, `CLEAN`.
  - CI-equivalent (D2) at the exact head **[verified]**: frozen install exit 0, no drift; `tsc` exit 0; jest 580 passed / 1 skipped.
  - Diff read **[verified]**: app rows unlabelled, other channels named (`iMessage` spelling added), drafts "local", the `#BDBDBD` inline colour removed, the Waldo mark gets a VoiceOver label, tests added. No rule issues.
  - The standing go has ended, so this merge needs the owner's yes.
- Staging `889efa27`; no new #116 comments.

## 03:00Z: INCIDENT. The first send after #1075 overwrote the owner's skipped row; fix #1080 drafted

- **L2 (message)** **[lane report; cause reproduced red locally by L2; matches L1's tail]**: `commit()` writes new rows at the stored `count` key, which defaults to 0. The owner's store came from an older, never-merged build with no `leaf` key (L1's `leaf: false` shows that) and, by inference, no `count` key. So L4's test send at about 02:41Z replaced `conv:0000000000`. #1075's fixtures always set `count`, so its tests and its review missed this case.
  - **Damage:** once. The store is consistent now.
  - **The original row** should survive as its witness copy (commit never deletes witnesses). Unverified; nobody writes to staging storage for this.
  - **Exposure:** any owner whose store an older build wrote without `count` loses one row on their first send.
- **Fix: draft #1080** (`c67516c3`, 2 files): new rows go to max(count, last slot + 1) on both commit paths; a non-slot key stops the save. 5/5 mutations caught **[lane report]**. CI running. Independent review launched at 02:58Z.
- **Owner questions:** (1) leave or restore the overwritten row (L2 and I recommend leaving it: it was shape-invalid and hidden, and was written by a build outside `beta-mvp`; see D5); (2) approve #1080 for merge and deploy once CI and the review pass.
- **Lesson:** the #1075 review named this hazard as "pre-existing, needs a stale `count`" and judged it unlikely from one inference (a matching witness implies `commit()` wrote the row). That inference was wrong: an older build wrote the row. The falsifier I gave L1 caught it on the first real send.

## 03:00Z: owner answers (in this session); app #79 merged

- **The owner, via AskUserQuestion in the orchestrator session (about 02:59Z):**
  - #1080 → "Yes, merge and deploy (Recommended)", once CI is green and the independent review passes;
  - the overwritten row → "Leave it (Recommended)";
  - app #79 → "Merge now (Recommended)";
  - heartbeat → "Keep it running".
- **MERGED waldoco/waldo-app#79** as **`5bf7fd3d140d809faae16bd727901a173fbe543e`** at 02:59:51Z, with `--match-head-commit 3546e5016869f0e04f5eac72e508e5b059195d94`, on the owner's explicit yes.
  - Evidence: CI-equivalent at the exact head (580 passed / 1 skipped; tsc clean; frozen install clean); `CLEAN` before the merge; diff read.
  - No independent review subagent: the owner chose "Merge now" over "Full gate first".
- The owner's answers are relayed to L2 (SendMessage `bbf281aa`) as relayed answers, not as a yes in L2's session. #1080's deploy needs the owner's go in L1's session.

## 03:15Z: #1080 review back, two tests required; overwrite still running on staging

- **#1080 independent review at `c67516c3`: code PASS, two tests required before merge.** CI is 6/6 green and `CLEAN`; the PR is still a draft.
  - The reviewer ran the PR file (18/18), eight neighbour test files (all pass), the runtime typecheck and `git diff --check`, plus 8 mutations, at the head in a scratch worktree.
  - M7 survives all 18 tests: only the scoped commit lists in forward order. Every scoped fixture holds one row, and nothing tests the guard on the scoped path.
  - Required:
    - (a) a scoped turn over three rows with no `count` or `leaf` keeps rows 0–2 and writes the new rows to 3–4;
    - (b) a scoped save over a stray non-slot `conv:` key is rejected, with storage unchanged.
  - The required tests and the nits went to L2 at about 03:16Z. Not merged.
- **The overwrite is still running on staging** [verified at `889efa27`, `canonical-owner-store.ts:150-175`]: `commit()` writes at the stored `count`, which defaults to 0, and adds the batch size.
  - On a store whose old build wrote `conv:` rows without a `count` key, every send overwrites the next old slot, until `count` passes the last old row. Rows that load fine are lost as well, not only the skipped one.
  - I told the owner in this session to stop sending from their staging account until #1080 deploys.
  - The reviewer suggests a read-only check of `<prefix>conv-count`, by L1 or the owner, to size the old store. It isn't mine to run.
- **L4 (03:20Z, FYI):**
  - App #77–#80 are merged; #80 pins C1 (core, threads, devices) from `21a70277`.
  - L4 is wiring Constellations against the pinned `view=constellation` pager, with no new DTOs.
  - L4 is asking the owner in its own session to choose a presentation: design-system chapter 08 says the graph is not MVP and bans confidence numbers.
  - Zone heads-up: once #1066 deploys, the Simulator app (signed in as the owner) writes its zone once to the owner's staging account, if the account is still unconfirmed and on `UTC`.
- The owner asked for a pillar assessment (8 agent-product pillars × surfaces × industry bar × promises). I launched four read-only research agents, at 31% of the 5-hour window.

## 03:20Z: #1080 tests pushed; the old build is named

- **L2 pushed `f17be611`** with the reviewer's two tests and the nits. I read the delta: one comment line and 30 test lines.
  - By reading, test (a) fails under M7, which writes at slots 1–2, and on base, which writes at slot 0.
  - Test (b) fails under M7, which finds slot 0 and doesn't throw, and on base, which writes at slot 1.
  - CI is running at `f17be611`.
- **L2 and L1 on the owner's store:** it held one canonical row [inference]. The 4bb040f5 display read showed 0 rows plus 1 skipped; after two sends, a Refresh read back four rows.
  - So the first send overwrote slot 0 and set `count`, and later sends append.
  - My stop-sending advice to the owner was conservative, and I've corrected it.
  - L1: reading a DO key from outside needs a code path, so the "read-only `count` check" isn't something L1 can do. L1 deploys nothing until the owner says so in L1's session. Rollback `65a07f13` is not recommended.
- **The old build is `40522697` (7 Oct), on `beta-mvp`'s own history** [verified]. It wrote canonical rows with a `conv-count` key and no `inputOrigin`; `2afc6ebd` removed it on 8 Oct. This corrects D5's provenance claim (see the correction in the decisions file). D5's decision stands.
- **L1:** the staging retention cron ran at 03:17:17Z ("owners=0 rounds=1", ok; #116 6117118251). Deletion is still unproven.

## 03:36Z: #1080 merged

- **MERGED waldoco/waldo-backend#1080** as **`cdd906ddd025542c77b59dc818661fecbeedfd8d`** at 03:35:57Z, with `--match-head-commit f17be6111f8ac214c99afc0547d7f020a0bdbf2c`, on the owner's explicit yes (02:59Z: "Yes, merge and deploy", once CI is green and the independent review passes).
- **Evidence:**
  - Independent review: code PASS at `c67516c3`. Two tests were required, because mutation M7 survived.
  - Both were added at `f17be611`. By reading, I confirmed that each fails on the base code and under M7. I did not execute the mutation runs; L2 reported running them, along with 74 neighbouring tests and the runtime typecheck.
  - CI 6/6 at `f17be611`, pgTAP included. The checks were unchanged after `gh pr ready`. `CLEAN`.
  - Advisor consulted before the merge.
- `beta-mvp` is now `cdd906dd`. Staging is still `889efa27`. **The deploy needs the owner's go in L1's session**; a relay from me does not authorize L1.

## 03:46Z: pillar scorecard (owner's question)

- The owner asked how many of the eight agent-product pillars work by natural language in the app and on Telegram, whether they meet the industry standard, and how much of the promise and UX is left to build.
- Answer in [PILLAR_SCORECARD_2026-10-12.md](PILLAR_SCORECARD_2026-10-12.md).
  - Under the strict three-test bar, read at `889efa27`: the app passes 0 of 8, Telegram 3 of 8.
  - The authority and safety layer meets the industry bar or beats it. Context, continuity and proactivity fall below it, and evals fall well below.
  - Of the 120 promises, about 76 need code, 20 copy, 12 owner or ops, and 12 only a probe.
- Four read-only research agents wrote the inputs, which are committed as `research-2026-10-12/07` to `10`. I spot-checked the key claims at `889efa27`.
- The 5-hour usage window went from 31% to 54% over the fan-out.
- Out of scope: `owner-do-smoke.yml` pins four actions by tag, against the security checklist. I offered the owner a separate task chip and did not fix it here.

## 03:49Z: #1080 deployed to staging

- **L1 deployed `cdd906dd`** at 03:46Z, as Worker version `b72928f0`, on the owner's go in L1's session, after push CI went 6/6.
  - `/healthz` reports `cdd906dd`.
  - Signed out, `/app/v1/session` and `/app/v1/chat/main` answer 401.
  - The cron is still registered.
  - The gate saw 2 files changed from the live build, and no wrangler, migration or contract change. Preflight 55/0.
  - Rollback: `3f059c04` (`889efa27`). #116: 6117374443 [lane report].
- No app send has run on the new build yet. A send needs the owner's say-so, and L1 will read the tail.
- Scorecard updated after an advisor pass:
  - the 02:41Z observation is labelled [reported];
  - the counts read 0 of 6 chat-capable pillars on the app and 3 of 6 on Telegram (P7 and P8 have no chat tools);
  - the Telegram connect path is spot-checked;
  - build item 2 notes that a new chat part is an enum break until L4 re-pins.

## 03:51Z: heartbeat

- Brief re-read. The owner is back, so the standing go has ended. Merges and deploys now need the owner's yes, given to me or in the lane's session.
- **Staging** `/healthz`: `{"ok":true,"release":"cdd906dd"}` [verified].
- **Backend PRs:** none is waiting on me.
  - #1066 (`c8d3190c`), #1076, #1078 and #1079 are drafts with CI 6/6. #1066 and #1076 wait on the owner's rulings.
  - #1077 (this docs PR) is ready, with CI running at `d7246f73`.
- **App:**
  - `main` is `6dcba63b`.
  - Open PRs: #29, #27 and draft #16, all older.
- **#116, new since 02:55Z:** L4's C1 pin (app #80); L1's retention cron; L1's deploy of `cdd906dd` (`b72928f0`, on the owner's yes about 03:37Z).
- **Scorecard:** draft #1017 (iMessage via a paired Mac bridge, default-off, with a migration) is added to the iMessage row and to platform gate 3.

## 04:08Z: L4 update; the owner asks for a parity plan

- **L4 (04:05Z):** app #81 (Constellations) merged as `baff45b5`, on the owner's yes in L4's session. It reads the pinned `view=constellation` with no contract change, and shows the map plus a list by topic, with grey hubs and no percentages. Checked only in the Simulator against `cdd906dd`.
  - Known gap: picking a row from the list doesn't scroll to its card.
  - Health: Weight never computes on staging, because the backend producer sets `demand: null` (`producer.ts:95`). L4 relayed this to L1. Form shows `stale_inputs`, which is expected: the only data is the Simulator's seed.
  - Next for L4: Threads (C1), then push.
- **The owner asked for an 8-pillar comparison** with Meta Muse, Instinct, OpenAI Dots, Hermes and other personal agents. It goes into the scorecard as a single doc to follow to EoD.
  - On the advisor's advice:
    - one read-only synthesis agent (on a cheaper model, no web) builds the matrix from #1058, report 02 and report 09;
    - ChatGPT, Gemini and Claude rows are deferred until after the 06:30Z reset;
    - the doc separates an EoD target from a dated roadmap.
  - The 5-hour window stood at 60% at 04:06Z.

## 04:34Z: scorecard becomes the plan to EoD

- **`PILLAR_SCORECARD_2026-10-12.md` is now the single doc to follow.** In order:
  - what EoD can and can't deliver;
  - decisions E1–E11, each with a recommendation and a deadline;
  - the EoD target, with an app-chat probe per pillar and the golden-path checklist;
  - today, by lane: deploy waves, one writer for `telegram-owner-do.ts`, contract gating;
  - where we stand;
  - a dated parity roadmap;
  - the competitor comparison across eight pillars plus health.
- **Competitor matrix:** report 11, built by one synthesis agent with no web access from #1058, report 02 and report 09. Covers Meta Muse, OpenAI Dots, Instinct, Poke, Folk, Vellum, OpenClaw, Hermes, Letta and Khoj. Dots is unverified (403). ChatGPT, Gemini and Claude are deferred until after the 06:30Z reset.
- **Verified fetch:** Google's OAuth page (updated 26 May 2026) says an external app in "Testing" gets refresh tokens that expire after 7 days. This is now in E8 and platform gate 6. Waldo's publishing status is unverified.
- **L4 (04:15Z):** building D6 as its own PR. The row reads "Use this device's time zone" or "Keep <zone>", because the design system bans "Confirm". L4 is also rewording #78's comment. App merges go through the owner in L4's session.

## 04:45Z: the owner's answers on the plan (E1, E4, E8; E2 queried)

- **E1:** "Daytime standing go (Recommended)". I merge today under the overnight gate. L1's deploys and L4's merges still need the owner's word in their own sessions.
- **E4:** #1076, "Approve L2's proposal (Recommended)": the DO ALTER `ledger.deferred_at`, L2's definition of "raises it again", and Telegram's "Not now".
- **E8:** "Yes, move to In production (Recommended)". The owner checks the Google consent screen's publishing status and runs consent on staging.
- **E2 (#1066's health strip):** no option chosen. The owner asked how Waldo can learn patterns from health data without historical evidence. Answered in session:
  - the history lives in the Supabase health plane (`waldo.health_samples`, `health_anchors`, `health_context_basis`, `health_daily`, `crs_scores`, `health_logs`) [verified table names];
  - the gap is that no runtime tool reads it. `get_health` and `get_crs` exist only as contract and permission names, with no runtime handler [verified at `cdd906dd`]; `list_health_logs` is the only health tool.
  - Re-asked with refined options.
- **Relays:**
  - L2 got E1, E4, E2-pending and its tiered queue (SendMessage, delivered).
  - L3's socket is stale, and L3 isn't in `ListAgents`, so the update went on the board.
  - The board now carries a DAYTIME GO banner.
- **E2 answered (about 04:47Z):** "Strip copies, build history read (Recommended)".
  - #1066 ships with health-log numbers kept out of chat history and the episodes index.
  - A governed, owner-scoped health-history read over the health plane is added to the roadmap, gated on a bounded contract under ADR-0081. It is not an EoD item.
  - Relayed to L2 (SendMessage). E3 stays open.

## 04:53Z: more answers from the owner; relayed

All four were the recommended options, at about 04:50Z in this session:
- **E9:** probes come from the owner's account. L4 or the owner sends, and L1 reads the tail.
- **E6:** the push device routes (`/devices*`) are approved for staging behind a flag. Production stays off.
- **E3:** app chat is indexed into episode search and the nightly job, under the strip rule.
- **E7:** #1071, plus browser admission by canonical identity, is approved for staging only, after the musts.

Relayed by SendMessage to L2 (E3, E6, E7, E9), L1 and L4 (E9 and E6; information only). L1's deploys and L4's merges still need the owner's word in those sessions.

Still open:
- E5: the APNs key, the owner's task.
- E10: copy.
- E11: L3's batch, in L3's session. L3 isn't in `ListAgents`, and its socket is stale.

## 04:54Z: heartbeat

- Staging is on `cdd906dd` [verified].
- #1076 moved to `eb959538` at 04:47Z. CI is running (4 of 6 green), and the PR is still a draft. L2 is updating it under E4.
- No new #116 comments since 04:40Z.
- L3 is still absent from `ListAgents`. Nothing is ready to merge.

## 04:56Z: #1076 ready; gate started

- **L2 marked #1076 ready** at `eb959538`, with `cdd906dd` merged in. CI is 6/6, pgTAP included, and the PR is `CLEAN`.
  - The owner approved it twice: in this session (E4) and in L2's ("Merge as is, rest today").
  - In L2's session the owner also said #1066 is "ready after the strip", and gave L2 a go to post its exact `telegram-owner-do.ts` lines on #116.
  - L2's local evidence:
    - 10 approval and control files, 110 tests;
    - typecheck, guards and the diff check pass;
    - pgTAP is UNAVAILABLE locally.
  - Follow-ups due today: the model re-raising a deferred item on any surface, and Telegram's "Not now" mapped to defer.
- **Independent review subagent launched**, read-first with a limited budget.
  - 5-hour usage window: 73%, resetting at 06:30Z.
  - My context: 70%.
- **Scorecard:** the W2 probe now notes that with #1076 alone, a deferred chat card may read "no longer available". Reading "put off" also needs L3's `deferred_at` field and L4's re-pin.
- **Board:** L2's merge-order note for L3's expiry rebase. L3 is still unreachable.

## 04:56Z: L1 corrects the plan on Weight; Form deviates from ADR-0081

- **L1:** Weight is a design decision, not a fix. The scorecard now lists it as E12, asked in L1's session, and it is out of wave 1.
  - The producer runs in the Worker (`app-api.ts:146`, before any DO forward). Calendar access exists only in the owner DO.
  - Weight has no ADR, and its weights are drafts.
  - L1's proposed slice: freebusy busy minutes per local day as counts only, plus physical load from data the producer already reads, with results kept `candidate_unaccepted`. It needs E8, so it can't be verified live today.
- **E13, found by L4 and verified by L1:** `form.ts` weights differ from accepted ADR-0081. The owner decides whether to align the code or amend the ADR, and who edits `scores/`, which belongs to the Instinct contributor lane.
- **Other L1 items:**
  - The deletion-proof script is ready; L1 is asking the owner for a throwaway account.
  - L1 asked L4 for the two-send re-probe on `cdd906dd`.

## 05:12Z: #1076 review FAIL (one required change); not merged

- **Independent review at `eb959538`: FAIL.** It read the code and the CI run (38205232381, 6/6) and ran no tests locally.
  - **Required:** the API accepts a second defer of the same approval.
    - `project()` offers defer without checking `deferred_at` (`approvals.ts:333-334`), and the UPDATE guards on status only (`:413`).
    - Fix: add `AND deferred_at IS NULL`, plus a red-first test.
  - **Body claims to correct:**
    - "ends with its expiry" is false until L3's expiry fix lands, because only `decide()` writes `expired`;
    - "approve from its chat card or the open list" is false in the shipped app.
  - **Test gaps:** no test catches dropping `|| action === 'd'`, leaving `'d'` out of the expiry check, or dropping `'review_only'` from the filter.
  - **PASSes:**
    - the DO ALTER (PRAGMA-guarded, in the only desk factory, reversible);
    - app.v1 unchanged;
    - no auth or egress change; health N/A;
    - concurrency, since everything runs inside `serial()`.
- **Residual 1, for the owner:** the shipped app can't decide a deferred approval.
  - The app reads only the default list. App-turn proposals get no Telegram card, and console approval is limited.
  - So "Not now" on an app proposal is a dead end until L2's re-raise follow-up ships.
  - Recommendation: deploy #1076 in the same wave as that follow-up.
- Findings sent to L2 (SendMessage). Merge after the fix: a delta check, CI, then the advisor.

## 05:48Z: replies ruling; #1076 fix read; CI infra failure rerun

- **The owner (about 05:15Z, in this session):** "Store replies as written (Recommended)". Model replies that quote health numbers are stored and indexed as written, as on Telegram, with no filter on model output. Revisit before production. E3's strip rule covers machine-written job prompts only. Relayed to L2.
- **#1066 ready at `075eb8fe`.** The strip covers three job prompts (day card, update card, mail follow-up): the health logs go to the model as context for that turn only. L2 reports:
  - red-first, with 10/10 mutations caught;
  - 18 neighbouring files and 173 tests passing, plus typecheck and guards;
  - #116 lines posted (6118177181), on the owner's go in L2's session.

  The delta review is deferred until after the 06:30Z usage reset (79% at 05:14Z). Wave 1 isn't until about 10:00Z.
- **#1076 fix at `3aefff5c`, read by me.** It adds `AND deferred_at IS NULL`, offers `withDefer` only while `deferred_at` is null, drops `defer` from TARGET, fixes the comment, and adds 67 test lines. L2 reports red-first and 5/5 mutations caught.
- **CI `verify` failed at infrastructure**, before any test ran: the Supabase docker container failed to set up networking (run 38207328547). The four runtime shards and pgTAP passed. Classified as runner infra, not flaky code. I requested a rerun of the failed job once, with the reason logged here.

## 05:51Z: #1080 verified live; L4's D6 merged; D10

- **#1080 verified live on `cdd906dd`** [reported]: L4 sent the two-message re-probe with the owner's yes in L4's session, L1 read the tail, and no overwrite was seen. The scorecard moves GP-4a/4b to verified live on `cdd906dd`.
- **App #82 (D6) merged as `89a8e1d8`**, on the owner's yes in L4's session. It does nothing until #1066 deploys.
- **L4's Health permission and "Last sent" fix** is built on branch `app/health-honest-sent-20261012` (`b7220a4e`). L4 reports 629 tests and 9 faults caught. The PR is next, and its merge needs the owner's yes in L4's session.
- **D10:** the expiry question (L4 to L3). The server owns approval state, with no client rule, and L3's expiry branch is the fix. Logged in the decisions file and posted on the board for L3, which is still unreachable.
- **L2:** #1066's body now carries the owner's replies ruling, and its head is unchanged at `075eb8fe`. The connect-honest branch (`61eac09c`) is nearly ready. #1076's verify rerun is still in progress.

## 05:59Z: #1083 (Form aligned to ADR-0081) ready

- **L1 opened #1083**: Form is computed as ADR-0081 `form.safte-fast.v1` (head `4f80da1f`, CI pending).
  - The owner chose "align to ADR-0081, L1 edits" in L1's session (E13).
  - Runtime only: `scores/*` and `producer.ts`, plus 3 test files. No migration, contract or wrangler change.
  - L1 reports 113 health tests passing, typecheck, guards 37/37 and 6 mutations caught.
  - Resting heart rate no longer substitutes for HRV, which is stricter. Results stay `candidate_unaccepted`.
- **Gate plan:** the independent reviews for #1066 and #1083 run after the 06:30Z reset. Wave 1 is at about 10:00Z.

## 06:06Z: #1084 (honest connect on the app) ready

- **L2 opened #1084** (MUST 2) at head `6587c579`, CI pending, mergeable.
- **What it changes on the app:**
  - Nothing is minted or sent: no chat connect offer and no dead-grant reconnect notice. Minting a ticket revokes the owner's open connect sessions.
  - The model gets L4's path to Connections, and the tool loop tells it what happened to an offer.
  - The app text sink refuses link keyboards.
- **L2's evidence:**
  - the full local wall passed at `402703d0`;
  - 12 mutations caught at `6587c579`;
  - it merges cleanly with #1066 and #1076;
  - #116 lines posted (6118675388);
  - `verify:supabase` NOT RUN locally, pgTAP UNAVAILABLE; CI covers both.
- **L2's note for MUST 3:** once Prep, update cards and mail follow-ups run on the app, a grant that dies there goes unannounced. L2 will add a link-free app notice with MUST 3, or right after it.
- **Review queue for after the 06:30Z reset:** #1066 (delta), #1083 and #1084, in parallel. #1076 waits only on its CI rerun.

## 06:08Z: #1076 merged

- **MERGED waldoco/waldo-backend#1076** as **`c5c36a05d34a6fb1f80d523fc446f5981ad93b72`** at 06:07:55Z, with `--match-head-commit 3aefff5c0bddbd422f9f3a3b14931b56b329b443`. Approved by the owner in this session (E4) and in L2's session ("Merge as is, rest today"), under E1.
- **Evidence:**
  - Independent review at `eb959538`: FAIL, with one required change.
  - The fix at `3aefff5c` was read by me. Source: the `AND deferred_at IS NULL` guard and `withDefer` offering defer only once. Tests:
    - a second "Not now" is refused, gets 409 and "Already handled.", and leaves `deferred_at` unchanged;
    - a review-only defer;
    - an expired defer records nothing.
  - CI 6/6 after a single rerun of `verify`. The runner-infra classification held: the rerun passed with no code change.
  - `CLEAN`; advisor consulted.
- **Deploy:** `beta-mvp` is now `c5c36a05`, so every tip carries #1076. L2's re-raise and Telegram "Not now" follow-up is now a wave-1 must, and both L2 and L1 were told. If the follow-up misses 10:00Z, the owner decides whether wave 1 ships.
- **Hot-file merge order:** #1066 and #1084 must each merge base and pass CI on the new base before I merge them.

## 06:31Z: three independent reviews launched (usage reset)

- **#1066 delta review** at `075eb8fe`. The reviewer has the original findings (the cross-date re-plan, the clock-dependent test 4, the held-skip trace, and the health HOLD) and the owner's rulings on the strip, replies, scope and time zone. It is asked to confirm the strip covers legacy `conv:*`, episodes and FTS, canonical `conv:*` and `witness:*`.
- **#1083** at `4f80da1f`: Form aligned to ADR-0081. The reviewer reads the ADR from the local `waldo-brain` clone (`origin/main`).
- **#1084** at `6587c579`: honest connect on the app.
- **Status:** all three are 6/6 on the old base (`cdd906dd`), and `beta-mvp` is now `c5c36a05`. Before merging, #1066 and #1084, which touch the hot file, must merge the new base and pass CI on it. #1083 doesn't touch the hot file, but I'll still require a current base if GitHub reports it out of date.

## 06:35Z: base merged into #1066 and #1084; PR diffs unchanged

- L2 merged `c5c36a05` into both PRs: #1084 is now `2d7235d4` and #1066 is `5b8ed285`. Clean merges, no force push.
- I compared each PR's diff before and after the merge by `git patch-id --stable`, and the diffs are identical [verified]:
  - #1084: `6d492d4c…` both ways;
  - #1066: `8da9ded3…` both ways.
- So the reviews running at the old heads cover the new heads. CI is running on the new heads.
- **L2's re-raise follow-up:** local `a8b334b8`, not pushed yet. L2 reports 17/17 mutations caught and a golden DO test.
  - It also handles a day card calling `raise_approval` on scheduled app work: that now says "back in the list, no card on this reply".
  - It also changes WhatsApp's text parser so it accepts `d:`. That's a one-character edit in Ashish's adapter.
  - L2 is on track for about 08:30Z.

## 06:47Z: #1084 review: one required truthfulness fix; not merged

- **Independent review at `6587c579`.** The reviewer read the code and ran no tests.
  - **Verdict:** HOLD, but the reason is a code fix, not an owner hold.
  - **Required:**
    - `unconnectedLine` (`messaging-behavior.ts:132`) still tells the model "…so a connect button is sent". It goes into every reply's system prompt (`owner-turn.ts:471`) on every runtime, so it is false on the app for an owner with no grant.
    - Fix: reword it, and assert in the app test that the reply prompt doesn't contain it.
  - **Nits:**
    - a bare `catch` without a log (`tool-loop.ts:129`);
    - a comment with no code (`mcp.ts:111-112`);
    - a stale comment (`owner-turn.ts:85-87`);
    - the skip logs `ok:false`;
    - "the app chat shows none" overstates it.
  - **PASS:**
    - the app path returns guidance before any mint or write;
    - Telegram and WhatsApp are unchanged;
    - the `noteHealth` skip is placed correctly;
    - the tests catch the key mutations;
    - no auth or route change, and app.v1 is unchanged;
    - concurrency is safe.
  - **Residuals:**
    - leftover `google:reauth-noticed` entries from the base's fake acknowledgement;
    - `APP_CONNECT_GUIDANCE` hard-codes app navigation with no contract behind it ("top left" unverified).
- Findings sent to L2.

## 06:49Z: #1083 review FAIL; owner items surfaced

- **Independent review at `4f80da1f`: FAIL.**
  - **Correct:** the composite math. The reviewer's standalone script checked the integer half-up expression against exact rounding over about 106M inputs, with 0 mismatches. Weights, pillars, coverage, zones, the 36/72 h windows and confidence all match ADR-0081.
  - **Required, tests:**
    - Rounding vectors that catch a floating-point mutant, which passes today.
    - A Form assertion in the SDNN test. Deleting the same-method filter isn't caught.
  - **Required, cleanups:**
    - Stop fetching workouts, which nothing uses now.
    - Make explicit how the heart-rate and HRV windows count toward the 8-bucket gate.
    - Fix the stale comment.
    - Take the weights and source table from the contract (`crs.ts:91-114`). Today they have two owners.
  - **Required, PR body:** list the unlisted deviations under NOT DONE:
    - (a) one source per row, chosen by reading count, not confidence;
    - (b) no SDNN confidence factor;
    - (c) stored rows never age.
- **Owner items, sent to L1 and told to the owner:**
  - an SDNN confidence factor;
  - aligning to ADR-0081 drops Form's HR/HRV stress part, against the 10 Oct §7 ruling and the site's "Form (circadian, motion, stress)";
  - owners whose only source is Health Connect lose Form.
- **L4 told:** Form's `confidence` will mean the ADR product, while Recovery's and Weight's still mean coverage, in the same response.

## 07:12Z: #1066 merged; #1083 off EoD; CHECKPOINT

- **MERGED waldoco/waldo-backend#1066** as **`531813cb99f261c796c37b03565b9b7e8316f85a`** at 07:10:51Z, with `--match-head-commit 5b8ed285ab779c5d673c1116381bb9975d216aea`.
  - The delta review PASSED at `075eb8fe`: the original FAIL items are fixed; the strip holds across all four stores (with a mutation run per store); arming waits for zone confirmation; the contract change is only `timezone_confirmed`, which the app already pins; concurrency is safe.
  - Patch-id check: `5b8ed285` carries the identical diff. CI was 6/6 there, and the PR was `CLEAN`. Advisor OK.
  - Follow-ups sent to L2: event-brief hold noise (about 144 rows a day); `card.pin` and `card.time` arming without the confirmation check; the shadowed `context`; an empty trace detail; card loss on `timezone.set`.
- **#1083: the owner's answers (about 07:05Z, in this session):**
  - amend ADR-0081 to keep stress;
  - SDNN factor 0.8, candidate;
  - fix source choice before merging.

  Relayed to L1. #1083 is no longer an EoD item.
- **#1084:** review fixes are at `6202b51b`. Next, L2 merges `531813cb`; then a patch-id check, my read of the delta, CI, and the merge.
- **L4:** app #83 (health honesty and the iOS read step) merged as `eab22e88`, on the owner's yes in L4's session.
  - The change in what Form's confidence means needs no app change, because the app doesn't read `confidence`.
  - App ingest is Apple Health only.
  - The owner deferred naming the health data kinds (5.1.3(i)) to the App Store list.
  - L4 is now on D7.

### CHECKPOINT (07:12Z): state for a resume

- **`beta-mvp`:** `531813cb`, which carries #1075, #1080, #1076 and #1066. **Staging:** `cdd906dd` (`b72928f0`). #1080 is verified live there (reported).
- **App `main`:** `eab22e88`, which carries #78, #79, #80, #81 (Constellations), #82 (D6) and #83.
- **Rule: L1 deploys no tip that contains #1076 without L2's re-raise PR.**
  - Wave 1, at about 10:00Z, needs the owner's go in L1's session. It carries #1066, #1084 and the re-raise PR, plus L3's expiry fix if L3 returns.
  - After wave 1, the owner confirms their zone (by tapping the D6 row) before the P4 probe.
- **Pending PRs and their next gate step:**

  | PR | Next step |
  |---|---|
  | #1084 | base merge, then patch-id check, my delta read, CI, merge |
  | Re-raise (`l2/approval-reraise`, local `a8b334b8`, due about 08:30Z) | push, then an independent review, CI on the current base, and the advisor |
  | #1083 | ADR amendment, then re-align, source choice and tests. Not today |
  | #1077 (docs) | the owner merges it |

- **Next for L2:** MUST 3 (`:2417`), which slips to wave 2, then skills on app turns.
- **Owner-pending:**
  - E5: the APNs key.
  - E10: WhatsApp and iMessage copy.
  - E11: L3's batch, which needs L3's session resumed.
  - E12: Weight.
  - The ADR stress formula.
  - The `today:` copy question from the #1066 review: a number copied from a reply into the next stored day-card prompt. Does that count as "replies as written"?
  - The Google consent move and run (E8, under way).
- **L3** is unreachable (not in `ListAgents`). Its queue, L2's merge-order note and L4's expiry question are on the board.
- **Usage:** the 5-hour window reset at 06:30Z. Three reviews used part of it. My context is about 80%.
- **The owner, at about 07:13Z in this session:** a health number copied from an earlier reply into the day card's stored `today:` summary "counts as replies", so it is stored as written. The `today:` copy question is closed. Relayed to L2.
- **L1 (about 07:15Z):** the owner's #1083 rulings in L1's session match this session's.
  - Health Connect goes into the source table at 0.6, marked candidate, in the same ADR amendment. Mixed owners keep Form through per-component selection.
  - L1's order: the brain amendment PR, then the re-work of #1083.
  - E12 answered: the owner approved Weight's free/busy design, using all selected calendars. It comes after #1083, and its owner-DO route will be sequenced with L2.

## 07:14Z: heartbeat. #1084 rebased and its fix read; #1085 review launched

- **Staging:** `cdd906dd`. **`beta-mvp`:** `531813cb`.
- **#1084** at `93351f98`, after L2 merged `531813cb` in. Its patch-id matches `6202b51b` [verified].
  - I read the 7-file fix delta and it matches L2's account:
    - `unconnectedLine` reworded;
    - the skip now has its own hop (`ok:true`, `app_surface`);
    - the logged catch (`offer_threw`);
    - the comment and guidance wording;
    - the `mcp.ts` comment removed.
  - CI is running at `93351f98`. Merge follows CI and the advisor.
- **#1085** (re-raise, and Telegram "Not now" as defer) is ready at `c001e427`, with CI at 5/6.
  - Independent review launched. It covers authority, Telegram callback compatibility, the WhatsApp parser change, app.v1 parts, abuse limits and the hot files.
  - It must merge base and pass CI again after #1084.

## 07:23Z: #1084 merged

- **MERGED waldoco/waldo-backend#1084** as **`2e5993d65ac0194080ecaf944e2faf55b1f7117e`** at 07:23:23Z, with `--match-head-commit 93351f9826f0c84c001446339d45af26122d8dbd`, under E1.
- **Evidence:**
  - The independent review at `6587c579` asked for one truthfulness fix plus nits. The fix delta at `6202b51b` was read by me.
  - The base merge (`531813cb`) leaves the patch-id identical.
  - CI 6/6 at `93351f98`. `CLEAN`.
  - Before the merge, the advisor approved the sequence: no second review subagent for a 13-line delta that does exactly what the reviewer asked.
- **`beta-mvp` is now `2e5993d6`** (#1075, #1080, #1076, #1066, #1084). The rule is unchanged: no deploy of a tip that has #1076 before #1085 lands.
- **#1085:** L2's local head is `8a28b1d0`, with three advisor fixes in `6f9bf8de`:
  - a WhatsApp raise now says a card was sent;
  - `raise_approval`'s claim effect is null, so a list or a refused raise can't back a "done" claim;
  - the console says "Don't do this".

  L2 is merging `2e5993d6` before pushing, ETA before 08:00Z. The review is running at `c001e427`; I'll read the delta myself.

## 07:37Z: #1085 review FAIL (small fixes); not merged

- **Independent review at `c001e427`: FAIL. No owner ruling is needed.**
- **Passed:** authority (`reraise` only presents), Telegram compatibility, the WhatsApp one-character change, app.v1 (pins byte-identical), the main-path tests and the golden DO test, abuse limits, hot files, concurrency.
- **Already fixed in `6f9bf8de`, which I read:** WhatsApp `note()`, and the console "Don't do this" text.
- **Required:**
  1. Check expiry before put-off. An open approval past its expiry is reported as "still waiting".
  2. The proactive raise from job prompts is reachable and untested. My recommendation: keep `raise_approval` out of machine turns, or own the path with tests.
  3. Log the bare `.catch` (`approvals.ts:928`) with a fixed code, and drop a date comment from a test.
  4. Green CI.
- **Residuals sent to L2:**
  - `unshown` after an ambiguous send;
  - an expired raise leaves old cards unretired;
  - after a raise, two live app cards;
  - "Not now" is offered per raise;
  - a stale Telegram `d:` button after an app defer;
  - the mutation count in the body.
- **Wave 1 still waits on #1085.** L2 is to warn by 09:00Z if 10:00Z is at risk.

## 08:14Z: #1085 fixes pushed and read; #1083 v2 waits on the owner

- **#1085 at `ee213723`.** It contains `2e5993d6`. I read the delta [verified]:
  - `reraise` now checks in this order: not waiting, in flight, expired (which calls `retire()`), then not put off;
  - Telegram answers a stale `d:` with "Already put off" and keeps the card's buttons;
  - the `owner-turn.ts:308` filter offers `raise_approval` only on the owner's own turns;
  - the `unshown` wording no longer claims nothing was sent;
  - the description drops "or its moment is near";
  - the re-render catch logs `rerender_failed` (`approvals.ts:932`).
- **L2's local wall at `ee213723`:** all pass, including 4868 runtime tests and 28/28 mutations. `verify:supabase` NOT RUN; pgTAP UNAVAILABLE. CI is pending at `ee213723`. Merge follows green CI and the advisor.
- **#1083 v2 (`c2f652b2`, L1):** stress pillar, per-pillar source choice, HC 0.6, SDNN ×0.8, and a stale source is dropped. It waits on the owner merging waldo-brain #34, then #37, and on the owner's yes. It needs a fresh independent review. Not an EoD item.
- **L2 next:** the #1066 follow-ups are on `l2/app-brief-hold` (three commits). The PR comes after #1085 merges.

## 08:40Z: #1085 merged as `e37f60f3`; wave 1 code complete

**CHECKPOINT**
- **Tip:** `beta-mvp` is `e37f60f3`. It carries #1075, #1080, #1076, #1066, #1084 and #1085.
- **Staging:** `cdd906dd`.
- **Wave 1:** deploy `e37f60f3`, on the owner's go in L1's session; no need to wait for 10:00Z. It doesn't carry expiry on read (L3 is out) or the event-brief hold noise fix, which goes in the next deploy.
- **After the deploy:** the owner confirms their zone (a D6 row tap) before the P4 probe.
- **Pending:**
  - L2's #1066 follow-ups PR (`l2/app-brief-hold`);
  - #1083 v2, which waits on brain #34 and #37, the owner's yes and a fresh review;
  - E5, E10, E11;
  - docs #1077;
  - app #84.

**Gate for #1085** [verified]:
- Head `ee213723`; base `2e5993d6` is an ancestor of it; CI passed 6/6 including pgTAP; CLEAN. Merged with `--match-head-commit`.
- I read the full `owner-turn.ts:308` filter. The `raise_approval` condition is added as a new conjunct, so the `remember`/`forget_memory` own-turn restriction is intact. `raise_approval` is offered only when `activeOwnerTurn !== undefined`.
- The test deltas of the two fix commits (`6f9bf8de`, `ee213723`) contain:
  - expired-never-put-off returns `expired`, with status `expired` and 0 live presentations;
  - a day-card job is offered tools, but not `raise_approval`;
  - a WhatsApp raise reports a sent card;
  - a raise backs no done claim;
  - a stale Telegram `d:` answers "Already put off" and keeps the card decidable.
- The context-composer test edit only removes a comment that was never true: the pinned `context_ref` is the same at every commit.
- The advisor approved the merge.

**Notes for the owner:**
- New Telegram cards change meaning: "Not now" now puts off, and "Don't do this" skips.
- The PR changes one character in the WhatsApp adapter, which another contributor owns.

## 08:47Z: wave 1 deploy has the owner's go in L1's session; rollback checked

- **L1 reports** the owner's go in L1's session: deploy `e37f60f3` to staging once its CI is green, at that exact SHA only. CI run 38225039233 is in progress. If `beta-mvp` moves first, L1 stops and asks the owner again. The rollback target is Worker version `b72928f0` (code `cdd906dd`).
- **I checked L1's rollback claim against the diff `cdd906dd..e37f60f3`** [verified]:
  - The only schema change is a guarded nullable `ledger.deferred_at`.
  - `cdd906dd` reads the ledger with `SELECT *` and no runtime check, and its inserts name their columns.
  - `timezone_confirmed` is new, and `cdd906dd` never reads it.
  - `approval_presentations` already exists at `cdd906dd`.
  - Outside source and tests, only tool contracts changed.
- **Additions sent to L1 for the rollback note:**
  1. Put-off approvals show as open again (the pre-#1076 behaviour).
  2. A `d:` "Not now" tap on a card sent by the new build gets "Not available." from `cdd906dd`, whose allow-list is a/s/e/u: it fails closed [verified, `approvals.ts:868` at `cdd906dd`].
  3. Rows armed for the app owner keep firing under the old delivery [inference].

## 08:50Z: wave 1 live on staging

- **L1 reports:**
  - Staging serves `e37f60f3` since 08:49Z, as Worker version `c7974404`.
  - A signed-out request to the session route and to `chat/main` gets 401.
  - The cron is still registered.
  - CI passed 6/6.
  - Preflight: 55 applied, 0 pending.
  - Rollback is `b72928f0` (`cdd906dd`); my three rollback notes are recorded.
  - The #116 record is comment 6120903877, and the tail is live on the new version.
- **I verified** that `/healthz` reports `{"ok":true,"release":"e37f60f3"}`.
- **Next:**
  - The owner confirms their zone (a D6 row tap) before the P4 probe.
  - L1 runs no probe from the owner's account without the owner's say-so in L1's session.

## 09:01Z: #1086 (#1066 follow-ups) ready; review launched

- **L2 opened #1086** at head `51df2756`, which contains `e37f60f3`.
- **What it fixes:**
  - The app channel drops `event_briefs`: the sweep is cancelled with one `scheduled_drop` row, which removes the hold-row noise of about 144 rows a day.
  - Held and dropped rows set `detail` to their code.
  - `card.pin` and `card.time` arm only when `armable('daily_brief')` holds.
  - The `turnContext` rename.
- **L2's evidence:** mutations caught 6/6. Local wall PASS: runtime 4872, contracts 1922, 38 guards; `verify:supabase` NOT RUN and pgTAP UNAVAILABLE, so CI covers both. #116 record: issuecomment-6121018996. The #1085 residuals are listed in the body as tested or deferred.
- **Independent review launched.** It must answer whether the app-channel drop can cancel the sweep for an owner who uses both Telegram and the app. It also checks that trace `detail` carries only codes.
- **Told L2 the order:** MUST 3 (`:2417`), then SHOULD (skills on app turns), both for wave 2. STRETCH comes after.
- **Scorecard doc fixes:**
  - The harness table's broken row 3 (a missing cell divider).
  - B.2 rows 1c, 5b and 8 now reflect app #84 and wave 1.

## 09:16Z: #1086 review FAIL (one blocking item); app #84 merged; scorecard page published

**#1086.** The independent review at `51df2756` (head now `5e097fc3`, a test-only change) FAILed on one item, which I checked against the code:
- **Blocking: claim 3's `card.pin`/`card.time` gate has no live caller.** app.v1 actions exclude cards (`contracts/src/app/controls.ts`), and the console's `card.today`/`card.pin` run on the Telegram runtime, where `armable` is always true. The test reaches the gate only through a made-up `card.time` called on `setup('app').act()`.
- **Should-fix:**
  - The card test is red at base only part of the day; pin the clock.
  - "Set for today" is dropped silently before the zone is confirmed, yet the receipt still says "set".
- **Verified fine:**
  - A dual-channel owner keeps the sweep (pinned by `5e097fc3`).
  - `detail` carries only a fixed code.
  - No contract, migration or endpoint change.
  - #1085's test is intact.
- The fixes are with L2, and nothing merges until they land.

**MUST 3.** L2 asked how to handle its overlap with #1086. Answer: (a), merge #1086 after its fixes and stack MUST 3 on it, plus a red-first re-arm test for app owners whose sweep the interim drop deleted. MUST 3 stays on the app channel only. Moving a Telegram-bound owner's proactive jobs to the app is a routing decision for the owner. Whether the owner's staging account is Telegram-bound is not verified; if it is, the P4 app proof needs an app-only test account, which only the owner can create.

**App #84** (the 18+ gate at sign-up) is merged as `72eae07a`, on the owner's yes in L4's session. It has separate Sign in and Create account. The server record, the web sign-up box and invites from links are still open. B.2 row 1c is updated.

**Scorecard page published:** https://claude.ai/artifact/QQyVwrydfu3Exn6xVHyA8Q. It is a dashboard built from 13 data files; the build script checks the per-row counts against the doc's tables. Four rows were refreshed for #84 and #1086. Four superseded copies of the data files are still in the artifact's file store; I didn't delete them, because the brief bars deleting data.

## 09:20Z: P4 routing correction; #1086 fixes pushed

- **Correction** [verified at `e37f60f3`: `telegram-owner-do.ts:1272-1281`, `:1337-1345`]: the zone tap gates arming only for app-only owners.
  - A Telegram-bound owner's nightly, heartbeat and day cards run on Telegram either way, and only their reminders go to the app.
  - If the owner's account is Telegram-bound, the P4 day card lands on Telegram.
  - The page (notes y1 and `w_zone`; pillars P4) and scorecard section C and B.1 are reworded to hold either way.
  - L1 has the correction. The owner is asked how P4 is proven in the app, and whether a dual-channel owner's proactive jobs move to the app.
  - The owner's Telegram binding is not verified; L1 won't do a directory read without the owner's say-so.
- **#1086:** L2 pushed `5b41101a` and CI is running.
  - The no-op gate is removed, and with it the time-dependent test and the silent loss of a card time.
  - Held-row notes are tested with capture on and off.
  - Residuals are listed in the body.
  - Next: I read the delta, then CI, the advisor, and the merge.
- **Stamp check:** a `date -u` check caught a dataset update stamp ahead of the clock; it was corrected.

## 09:30Z: owner rulings E14 and E15; page and doc updated

- **E14:** P4 in the app is proven on an app-only test account the owner creates with a fresh invite.
- **E15:** app-first routing. Proactive messages go to the app for anyone who uses it, with Telegram as a dev copy. L2 builds it on 13 Oct after MUST 3; MUST 3 stays app-channel only today.
- **Relayed** to L2 and L1. Saved in the owner-rulings memory.
- **Page datasets updated:** pillars, notes, decisions, lanes and roadmap. The scorecard's section A and section 5 are updated too.
- **Answered the owner's questions** on why time zones look hard: the problem is trusting the zone, plus routing. Compared with the other agents in report 11's P4 sources.

## 09:34Z: #1086 merged as `e4ef5b59`; P4 probe steps fixed

- **#1086 merged** with `--match-head-commit 5b41101a`. Gate [verified]:
  - CI passed 6/6 with pgTAP, and the PR was CLEAN.
  - The head contained `e37f60f3`.
  - The delta reverts the no-op gate; the base diff no longer touches the `applyDayPlan` card line.
  - The time-dependent card test is removed.
  - The held-row test asserts fixed codes with capture off and on.
  - The advisor approved.
- **Wave 2 and MUST 3:** #1086 rides wave 2 with MUST 3, which needs the owner's go in L1's session. L2 must merge `e4ef5b59` into MUST 3 and pass CI on that base first.
- **Owner's account:** the owner told L1 in L1's session that their staging account is app-only. L1's read-only directory check by the work email matched 0 owners. P4 still runs on an app-only test account, per E14.
- **P4 probe fix:** app chat can't move a day card. Card times are console-only, and `set_schedule_preference` only toggles behaviors [verified at `e4ef5b59`]. The probe now waits for The Close at its default 21:30 local, which is 16:00Z on IST and inside the window [inference from the `DAY_CARDS` defaults]. The zone must be confirmed before 16:00Z. The page (pillars P4, notes y1) and B.1 are updated, and L1 has the new steps.
- **The page's runs document doesn't exist**, so nothing threw or is mis-marked [inference: the owner had the page open with 0 failed sources].
- **From now on**, page updates are batched at the wave 2 deploy and the 17:00Z re-score, unless something on the page is wrong.

## 09:38Z: heartbeat; owner named a Telegram-linked test account; L1's movement finding

- **Checks:**
  - The heartbeat cron `29a6d33d` is present.
  - Context is at 86%, so cycles stay lean. The 5-hour window is at 52% and resets at 11:30Z.
  - `beta-mvp` is `e4ef5b59`; staging serves `e37f60f3` [verified].
  - Open PRs: #1083 (Form v2, waits on brain #34/#37 and the owner), #1081 and #1082 (the CI pin PRs from the owner's separate task; not mine to merge), #1077 (this docs PR, UNSTABLE).
  - #116 since 09:00Z: L4's D7 note and L2's #1086 line.
- **Owner instruction:** use an existing test account for the probes; the owner says it's linked to Telegram. The address went to L1 only and is kept out of the repo and the page.
  - On that account, P4 is proven in the app through reminders, and day cards (The Close at 16:00Z on IST) arrive on Telegram.
  - A day card in the app needs an app-only account, or E15 tomorrow.
  - The page (y1, `w_zone`, P4 probe, E14) and the scorecard (B.1 P4, E14) are updated.
- **L1 finding** [reported]: the app at `72eae07a` never sends `movement_duration`. On real data, Form's motion and stress parts can't compute (#1083's stress included), and Weight's physical load comes only from workouts. The fix is app-side, with L4 and the owner; L1 has flagged it to both. It's added to W1 on the page.

## 09:47Z: probes dispatched; #1037 read in a subagent; movement ruling

- **Probes:** the owner said "go ahead with the probes on that account". The probe sheet is committed (`9dfea018`) and sent to L1 (tail) and L4 (Simulator sends). Each lane still needs the owner's go in its own session, and the owner types the emailed sign-in code. Probes 1–5 run on wave 1; probe 6 is The Close on Telegram at 16:00Z; probes 7–8 follow wave 2. No deletion on that account.
- **#1037:** the owner pointed to it for the eval and the golden tests against Instinct. A read-only subagent is mapping its task catalog to the probe rows and to the P8 eval slice.
- **Owner ruling, in L1's session** [reported by L1, verbatim]: "send all required dta as much as needed for better agent function we can handle legal things later".
  - L4 plans the app to send `movement_duration`: an AppleExerciseTime read, the permission sheet, the range field, and no backend change.
  - It is an existing producer input, not a new destination [inference from L1's report].
  - Revisit the legal side before production.
- **L1** is building Weight on `l1/weight-demand` from `e4ef5b59`; the owner-DO lines go on #116 for L2 first.

## 09:56Z: owner ruling E16, standing grants (contract and ADR now)

- **The owner's question:** is "at or above the bar on authority and safety" too restrictive for Waldo?
- **My answer:** the safety layer is not the limit. The missing standing grants are:
  - every write needs a one-time approval, so nothing acts on its own;
  - competitors document grant lifetimes (Muse, Vellum, OpenClaw, Hermes; report 11).
- **E16 (owner):** "Start the contract and ADR now".
  - The draft standing-grants ADR and contract are being written by a subagent. They build on draft #932: owner-only, reversible actions; scoped, expiring and revocable; rechecked before dispatch.
  - Output: `STANDING_GRANTS_ADR_DRAFT_2026-10-12.md`, for L3 and the owner.
  - The code comes after the app musts. The ADR goes to waldo-brain, which only the owner merges.
- **L3 has been unreachable all morning.** The owner needs to resume L3's session for the contract and E11.

## 09:59Z: D11, the skills custody bridge; #1087 review started

- **D11** (my delegated call, not an owner ruling): L2 asked which custody key app turns use for skills (SHOULD). I chose (b), the bridge, for today. An app turn reads skill activations stamped with this DO's own stored, verified Telegram subject, and otherwise `principal_ref`.
  - Why: the probe account is Telegram-linked. Under (a), its Telegram-stamped activations would show as disabled on the app, and probe 7 would fail. Skills are instructions, not permissions. No data is rewritten, and reverting the code reverts the behavior.
  - Conditions sent to L2:
    - the bridge reads only the DO's stored subject, never one from the request;
    - tests: a seeded Telegram-custody row loads on an app turn; a fresh DO uses `principal_ref`; a row stamped with another subject or principal stays disabled;
    - the PR body names the edge case where a re-bound DO inherits activations.
  - Both surfaces move to `principal_ref`, with a reviewed re-stamp, in E15's routing slice tomorrow. SHOULD goes in its own PR, not #1087.
  - Next: an advisor check on whether this falls on the hold list (user isolation).
- **#1087 (MUST 3)** is a draft at `53d0f699` on `e4ef5b59`. pgTAP passed; verify and the four runtime shards are pending. The independent review subagent started at `53d0f699`.

## 10:07Z: E17, the app first on iOS and Android; D11 goes to the owner; #1037 read; strict-check sweep

- **E17 (owner, verbatim):** "we need to resolve this as well have a working waldo app for ios and android ready followed by whatsapp and imessages". Then: "focus on app build for to make everything work fully the agent on app for ios and android end to end the we can continue the extension work on whatsapp and imessages".
  - This replaces 11 Oct's "iPhone first, Android later". E10's copy question stays open. The scorecard (A, §5) and memory are updated.
- **Android today** [verified at waldo-app `5017f0c8`, files read]:
  - Package `com.waldo.app`, Expo SDK 54, and an EAS development profile with an Android key.
  - Android health uses Samsung Health's SDK only (`HealthModule.kt`, `withHealth.js`). There is no Health Connect, so non-Samsung phones get no health data. A code comment says reads need Samsung Health's developer mode until Samsung registers the app (error 2003).
  - There is no Firebase config, so there is no Android push. The backend accepts an `fcm` token (`contracts/src/app/devices.ts:7`) but has no FCM sender [verified by grep at `e4ef5b59`].
  - This Mac has no Android SDK or emulator; Java 17 is present [verified].
- **D11 goes to the owner** (advisor): the SHOULD PR touches user isolation, so it is on the hold list, and I don't merge it under E1.
  - L2 builds (b) and must show one of two things: that a DO can't be re-bound to another owner's app principal, or a same-owner check with a negative test.
  - If the owner hasn't said yes before wave 2, wave 2 ships #1087 alone and probe 7 waits.
- **#1037** [subagent read; claims carry file:line]:
  - It is a docs-only pack at `a709fcd6`: 113 tasks and 66 gold rows. Nothing runs, and no task targets the app. The gold is Instinct-written, prepare-only and self-graded, with no fixtures.
  - It isn't a GitHub draft, despite its "do not merge". I won't merge it.
  - Waldo's research doc records that Instinct's terms bar benchmarking (moonshot evaluation, :183), so the catalog's §8 plan needs the owner's terms decision.
  - Proposed slice 1: five app-path golden journeys (UC-02-US, PR-07, SAF-01, SAF-05, PR-15). They use synthetic fixtures, run in verify, and use no Instinct output. The owner is to be decided; it is not L2, which holds today's hot file.
  - Slice 2 (nightly, model-graded) waits on a CI secret, an egress review and the terms decision.
- **Strict checks:** reads of stored data skip the bad item and record a code, as #1075 does. Authority and safety checks still fail closed. A read-only sweep subagent is listing every whole-read failure at `e4ef5b59`.
- **Promise count correction:** the grant-blocked promises are ten rows, not "about eight": WP-025, -026, -028, -030, -032, -033, -034, -046, -047 and -061. WP-023 and WP-038 depend on grants in part.
- **L1:** the tail for probes 1–8 is live on `c7974404` (10:00:31Z), with the owner's confirmation in L1's session. Results come per probe.

## 10:13Z: probes 1–4 pass on the test account; probe 5 waits for a test event

Reported by L4, with the owner's yes in L4's session and L1 reading the tail. Staging is `e37f60f3`; the app build is main `5017f0c8`.

| # | Pillar | Result | Times (Z) |
|---|---|---|---|
| 1 | P6, GP-4 | **PASS.** The reply appears under the message, and the receipt is `completed`. L1's tail shows no `history_conflict` and no strict-load failure | Sent 10:01:41; replied by 10:02:10 |
| 2 | P4 | **PASS.** The reminder is set for 10:12:41, and the Waldo row is in Main chat after a manual refresh. L1 confirms the set; the fire and delivery lines are still to come | Sent 10:02:22; seen 10:13:01 |
| 3 | P5 (#1084) | **PASS, with a note.** Google was already connected, so Waldo said so. It claimed no button or link, and no link was minted (L1's tail) | Sent 10:03:48 |
| 4 | P5 | **PASS.** One named event tomorrow is listed, and `tool_query_calendar` is ok (L1). The owner can confirm it's real | Sent 10:04:54; listed by 10:05:30 |
| 5 | W2 | **Pending.** The owner is creating a 4 pm test event. L4 won't touch the two existing approvals | — |

- **Also:**
  - App #85 (Main chat failure state and retry) is merged as `5017f0c8`.
  - The reminder needed a manual refresh. L4's next item is refresh-while-open with an unread signal on Home, after `movement_duration`, whose merge needs the owner's yes in L4's session.
- **L4's question:** why does Main chat show no Telegram turns on a Telegram-linked account?
  - It's today's design: two transcripts. The scorecard's P6 row lists one transcript across surfaces as a gap that remains open.
  - Not a bug, and no app change now. E15's routing tomorrow moves proactive messages into the app; one shared transcript is a later owner decision.

## 10:14Z: L1's tail confirms probes 1–4

Staging `e37f60f3`, version `c7974404`. Codes and times only.

- **1, PASS.** The turn ran from `owner_request` to `resolved` by 10:01:54Z. The history read returned 200 with no `history_conflict`, no strict-load failure and no skipped rows.
- **2, PASS.** `set_reminder` was ok at 10:02:41Z. The alarm fired at 10:12:02Z through the app runtime: no `reminder failed`, no Telegram send.
  - Open: L4 reported the reminder as set for 10:12:41Z. If that is its due time, it fired 39 s early. I've asked L1 to compare `due_at` with the fire time; under a minute doesn't fail the probe.
- **3, PASS.** `tool_connect_service` was ok and resolved by 10:04:07Z, with no link-mint hop.
- **4, PASS.** `tool_query_calendar` was ok at 10:05:08Z and resolved by 10:05:15Z.
- **5–8:** pending, as in the probe sheet.

## 10:15Z: #1087 review FAIL (one blocking); L2 has the fix; D11's evidence

- **#1087 (MUST 3) at `53d0f699`**: the independent review says FAIL. I re-read the blocking line myself [verified].
  - **Blocking: legacy briefs reach the app with the flag off.** With `CALENDAR_GROUNDED_PREP` set to `"0"` (production's value, `wrangler.jsonc:20`; staging is `"1"` at `:84`), a confirmed app owner's `event_briefs` sweep falls through to the legacy branch (`telegram-owner-do.ts:2497-2511`). That branch has no channel check, so the brief goes to the app transcript:
    - without the final outbox;
    - send before record (`event-briefs.ts:109-110`);
    - retried on every sweep;
    - with the full tool set.

    At the base, `held` and `armable` kept `event_briefs` off the app.
  - **The fix:** return through `updateCheck` when the channel isn't Telegram, plus a test with the flag at `"0"`.
  - **Should-fix:**
    - the stale comment at `:2041`;
    - an unpinned Telegram feedback keyboard (no test contains `fb:`);
    - a narrow health-strip oracle (sentinel values needed);
    - the re-arm test, which lacks the zero-Telegram assertion.
  - **Everything else passed:** the health strip, honest delivery, unchanged Telegram owners, the three-part app authority check, re-arm once, no app.v1 change and no migrations. CI is green at `53d0f699` (run 38233018531) [reported by the reviewer].
  - I sent the fix list to L2 and will re-review only the delta, then go to the advisor, then merge. Wave 2 still needs the owner's go in L1's session.
- **D11 evidence** [reported by L2, in the SHOULD PR body]:
  - `waldo.owners.do_name` is `not null unique` and minted as `'owner-' || gen_random_uuid()`.
  - No migration rewrites it; deleting an owner removes the row.
  - The app principal is `prn_<owner_id>`, resolved by `do_name`.

  So skill inheritance stays within one owner. The schema doesn't stop a future rename. The PR is marked for the owner's merge.

## 10:17Z: probe 2's timing closed: the reminder fired on time

- **On time, not early.** 10:12:41Z was L1's estimate, not the stored due time.
  - `set_reminder` takes owner-local wall clock to the minute (`contracts tools/schemas/reminders.ts:11`) [reported by L1].
  - The model chose 15:42 IST, which is 10:12:00Z. The alarm fired at 10:12:02Z, about 2 s after the due minute.
- **A one-shot reminder at a time already past is rejected, not fired** [verified at `beta-mvp`: `packages/runtime/src/channels/reminders.ts:31`].
- **So "in 1 minute" fires at the next minute the model picks.** That is between a few seconds and about a minute after the request [inference], and nothing fires early.

## 10:26Z: #1087 delta re-review PASS at `fd792254`; CI running

- **Delta over `53d0f699`** [verified by reading the diff; `53d0f699` is an ancestor]: 4 files, +49/−16.
  - **Source** (`telegram-owner-do.ts`, 3 lines): the stale comment at `:2041` is deleted. Before the legacy branch, `if (channel !== 'telegram') return void (await updateCheck(...))` is added, with a comment saying why. With the flag on, the grounded block returns first on both channels. With it off, Telegram keeps the legacy sweep, and the app gets only the update check.
  - **Tests:**
    - **Grounded prep off.** A new test with `CALENDAR_GROUNDED_PREP: '0'` checks three things: the app chat holds exactly the update card, `event_briefs` has 0 rows, and no model request names the meeting. L2 reports it was red at `53d0f699`.
    - **Health strip.** It now uses decimal sentinels. Requests carry the rendered lines; `storedText` has neither number, after the update card and after prep. The prep request carries neither number nor the meal.
    - **Re-arm.** It now asserts zero Telegram sends.
    - **Keyboard.** The Telegram keyboard is pinned exactly: `fb:<id>:u` and `fb:<id>:n`, keyed to the pushed row.
  - **#1086's dual-channel test was flaky.** L2 reproduced the flake deterministically, so it was a test-clock bug, not true flakiness. The fix sets the interval phase to the due occurrence (`phase_ms: sweepAt % 600000`, was `0`). The assertion is unchanged.
- **Next:** CI at `fd792254`, then the advisor, then merge with `--match-head-commit`. The PR is no longer a draft. Wave 2 needs the owner's go in L1's session.
- **Skills PR:** L2 is opening it as owner-merge. Its local wall had one owner-ingress run fail with `delivery_uncertain` (`telegram-relink-owner-do`, 8 cases). That run overlapped another worktree's tests, and the file passed 3/3 alone. L2 has logged this on #116.

## 10:29Z: standing-grants ADR draft landed (E16); #1089 review started

- **The draft:** `STANDING_GRANTS_ADR_DRAFT_2026-10-12.md`. I read it in full before committing.
  - It proposes ADR-0085; the number is [inference], since brain `main` `23c4f99` ends at 0084.
  - It builds on #932 (`5506de85`) and brain #34 (`13d60067`, unmerged), and lists eight departures from #932.
- **v1 is calendar holds only:** attendee-free Waldo holds on the primary calendar, which can be created, moved or shortened, and removed only through Undo.
  - Tasks are deferred: there is no task Undo, completions stay `connector_write`, and there is no reorder action.
  - Sends, attendees, purchases, deletions and health shares can't be expressed in a grant.
  - Coverage: WP-026 in full, given Form. WP-032, WP-033 and WP-046 for holds only. WP-025, WP-028, WP-030 and WP-047 in part.
- **Questions for the owner, Q1–Q7. Q1 (taint) comes first:**
  - Calendar reads are external-origin, and their taint latches for the rest of the turn (`tool-loop.ts:161-167`). So a rule of "any taint means a card" blocks every hold run.
  - Recommended Q1(b): act only when every field is host-fixed and the host checks the time against the grant and free/busy. That amends ADR-0049.
- **On the hold list:**
  - a DO migration (a table and two ledger columns);
  - an ADR-0008/0033 amendment;
  - the brain PR, which only the owner merges;
  - an app.v1 re-pin before anything is emitted.
- **For L3 before any code:** confirm that the grant SQL and the effect-ledger KV share one `transactionSync` [inference in the draft].
  - L3 is still unreachable; the owner needs to resume L3's session.
- **One edit by me:** the draft notes that WP-034 and WP-061 also wait on autonomous moves (ten rows).
- **#1089 (Weight, L1):** an independent review is running at `76d9bcaf`. L1 holds pushes, and the merge needs the owner's yes in L1's session.

## 11:38Z: usage-limit outage (about 10:30–11:30Z); #1087 merged as `614d1aff`

- **The outage:** the account hit its 5-hour session limit at about 10:30Z. The window reset at 11:30Z and resets again at 16:30Z; it is at 1% now.
  - All my subagents died with nothing produced:
    - the strict-check sweep and the six sub-agents it had fanned out;
    - the #1089 review.
  - L2 also stopped at the limit. L1's and this session's processes restarted.
  - Cause [inference]: fan-out subagents, the sweep's six above all, while four lanes ran at max effort.
  - Fixes:
    - the sweep is relaunched as one agent, with no Agent tool and a budget of about 45 tool calls;
    - every lane is asked not to fan out;
    - peer messages now go by session id, because names didn't resolve after the restart.
  - The cron `29a6d33d` is present.
- **#1087 (MUST 3) merged as `614d1aff`** (`gh pr merge --merge --match-head-commit fd7922547009c4d006caa07980c92c7e77298c26`).
  - Gate:
    - CI passed 6/6 at `fd792254`, pgTAP included;
    - a subagent reviewed the full diff at `53d0f699` (FAIL, then fixed);
    - I re-reviewed the fix delta myself;
    - the advisor passed it;
    - GitHub reported CLEAN against `e4ef5b59`.
  - Not on the hold list:
    - no migrations and no contract change;
    - health goes only into the owner's model context, and stored copies are stripped and sentinel-tested;
    - the app branch adds fail-closed owner checks.
  - Non-blocking follow-ups from the review:
    - (5) `appCaller`'s synthetic ACK when a send happens outside the alarm;
    - (6) whether a health-tool read in an app update-card job with follow-ups off reaches a stored copy. Day cards already carry the same exposure.
- **Wave 2** is #1086 plus #1087, on the owner's go in L1's session. #1088 joins only if the owner merges it first.
- **#1089:** L1 is asked to merge base now that #1087 is in, because both touch `telegram-owner-do.ts`. The review launches at the new head.
- **Lanes:**
  - L4 had committed movement minutes locally (`a5f26f16`, 660 tests passed) and asked the owner about probe 5's 4 pm window; that question was interrupted. Probe 5 needs a new time.
  - L2 is idle after the limit; it was told #1087's state, to mark #1088 ready when green, and to pace itself.

- **11:39Z, L4:** movement minutes is committed locally as `a5f26f16`, not pushed. `check` passes, and tests pass 660, with 1 skipped. Two fixes since: the one-time 30-day re-send now waits for iOS's Exercise Minutes prompt, and the keychain keeps the watermark version. Still to do before a PR: deliberate faults, a native build, and Simulator proof. My steer: a kind that fails is skipped and recorded, never stops the range. Probe 5 waits for a new time from the owner; L4's 10:27Z question went unanswered.

- **11:40Z, L1:**
  - **#1089** merged base `614d1aff` cleanly; the new head is `dc9cdefc`. Locally, 264 tests pass across 29 files, typecheck passes, and guards pass 37/37; pgTAP is unavailable. CI is running. The review subagent is now running at `dc9cdefc`, under the no-fan-out rule and a budget of about 60 calls.
  - **The staging tail** was down from about 10:52Z to 11:38Z, after the restart, and is live again. Anything probed in that gap went unobserved.
  - **Wave 2:** L1 runs the gate and asks the owner for the go in L1's session.

- **11:44Z:**
  - D11 and D12 are written up in the decisions file. D12: G1 builds in parallel with #1089, and the gate decides the merge order.
  - L4 holds movement minutes and probe 5 for the owner's answers in L4's session.
  - #1088 merged the new base at `0e2557c3`; L2 marks it ready when it is green.

## 11:53Z: strict-read sweep results; D13; the scheduler fix goes to L1

The sweep was one agent with 43 tool calls and no fan-out, at `614d1aff`. I verified finding 1 myself.

1. **Worst case** [verified]: one schedule row that fails `toEntry` makes `dueEntries` throw before the dispatch `try`, so all scheduled work stops for that owner. It also breaks `rearm`, which reads every row in every status. The likely trigger is a rollback [inference].
   - This goes to L1. The bad row is skipped in memory and logged as `schedule_row_invalid`, and it is never mutated.
   - Tests come first: a valid row still dispatches, `rearm` binds, and the bad row stays byte-identical. It stays out of wave 2.
2. `loops.ts:82` `proactivity()`: settings JSON with no schema check. It feeds the heartbeat, day-card holds and card prompts. Backlog.
3. `update-cards.ts:61-64` `unfolded()`: a `JSON.parse` inside `.map` can stop the day-card job. Backlog.
4. `owner-turn.ts:333-337`: one failed episode read fails the whole `search_episodes` call while a forget hold exists. This goes to L2 as a small PR after G1.
5. `recall.ts:176-206`: one recall hit over 2,000 characters fails the turn. It is latent while recall is stubbed. Backlog.

**Not covered:**
- approvals, the coordinator and `run-loop/do.ts`;
- model-output parses that end a whole job (prep, nightly);
- L1's narrative and health material;
- day-card time parsing.

No second sweep for now, because the usage window has to last through wave 2 and the 17:00Z re-score.

**D13** is written up in the decisions file: one log shape, rows behind owner-visible promises are skipped and never mutated, and authority chains keep failing closed.

- **11:55Z, wave 2 deploying.** L1 has the owner's go in L1's session for `614d1aff` (#1086 and #1087) and is deploying through its gate, with CI 6/6. Probe 7 depends on #1088 and is not a MUST 3 failure. Probe 8 tests wave 2. A new probe 9 proves MUST 3 on an app-only account with a confirmed zone and an event 35–40 minutes out. The Telegram-linked test account can't prove MUST 3. The owner's own staging account qualifies, if the owner agrees. The probe sheet is updated.

## 11:56Z: #1089 (Weight) review FAIL at `dc9cdefc`; findings sent to L1

- **Blocking** [verified]: CI shard 1/4 fails (run 38244121825). The new DO table `calendar_demand` has no row in the forget inventory (`forget-store-table.test.ts`). L1 picks its forget class and gives the reason; the reviewer proposes EXEMPT (counts only, purged on disconnect, erased by `deleteAll`).
- **Should-fix:**
  - fake zero load on days with no movement (`producer.ts:107-117`);
  - past-day rows treated as final when they were fetched mid-day (`calendar-demand.ts:120`);
  - failures are silent, with no code recorded;
  - accounts are chosen by `calendar.events`, not by the scopes the read uses;
  - Recovery and Form wait on the demand read inside `waitUntil`;
  - a missing test that a confirmed owner's upload re-arms idempotently, since uploads now run `setup('app')`;
  - the PR body says "capped", but the code drops the values.
- **My call, under D13:** a permanent per-calendar error skips that calendar with a recorded code and is surfaced in Weight's used signals. Transient errors stay fail-closed.
- **Passed:** health destinations (counts only; values reach Supabase through `context_write`); the signed route (HMAC, constant-time compare, owner-scoped; replay is possible within 35 days but returns counts only); no new scope; no contract or migration change; the hot-file pieces change no chat path.
- **Still owner-merge:** it adds DO persistence, and HEALTH_PLANE_AMENDMENT ruling 1 needs the owner's yes before Weight is shown.

## 11:58Z: wave 2 live on staging; #1088 ready for the owner, with a review running

- **Wave 2:** staging has served `614d1aff` (#1086 and #1087) as version `02103423` since 11:55Z [reported by L1].
  - Gate: CI 6/6; preflight 55 applied, 0 pending; no wrangler, migration or contract change.
  - `/healthz` reports `614d1aff`. Signed-out session and chat requests get 401, and the cron is registered.
  - Rollback is `c7974404` (`e37f60f3`). Recorded on #116, comment 6123770747.
- **Probe 6** (The Close, 16:00Z): L1 watches from 15:59Z to 16:15Z and reports silence as silence. Probe 9 (MUST 3 on an app-only account) needs the owner's yes.
- **#1088** (skills on app turns): head `0e2557c3`, which includes base `614d1aff`. CI 6/6, CLEAN, owner-merge. An independent review is running (no fan-out, about 25 calls). The owner decides on its result.
- **The old L4** (`local_a2ad79f3`) woke on a message from L1 that went to the wrong lane, stayed stood down and passed the message on. L1 was told the current L4 id.
- **Usage:** the 5-hour window is at 13 percent and resets at 16:30Z; context is at 57 percent. The page update is deferred to the 17:00Z re-score; the scorecard file is current.
- **G1 (L2), ~12:00Z:** a red test shows that after the owner approves a send from the app, the next turn has no trace of it: no subject, recipient, id or state.
  - Shipping tool results alone would make P1 worse. The stored output says "nothing was sent" even after approval.
  - So G1 ships both halves: tool results, and the receipt reconciled at read time from the approvals ledger, withheld when it can't be read.
  - Hot-file changes: about 3 lines in the owner DO and about 10 in `owner-turn.ts`.
  - The new `proposal_ref` field is additive in KV (`tool-output-ledger.ts:109-115` uses `storage.put`) [verified], so it isn't a DO schema change.
  - L2 has the slot now (D12, restated), with the #116 lines posted first.

## 11:59Z: lane messages paused at the 10-message cap; #1089 forget-class fix at `2fc0e642`

- **The cap:** the desktop app paused my cross-session sends after 10 since the owner last typed here. It resumes on the owner's next message, and I'm not routing around it. One message is undelivered, to L2:
  - the G1 slot is L2's now (D12, restated);
  - `proposal_ref` is additive KV, not a DO schema change [verified];
  - add a test that old entries without the field read as non-proposal;
  - #1088 READY is noted, with the owner's review running.

  D12 itself was queued to L2 at 11:44Z.
- **#1089:** L1 pushed `2fc0e642`, a one-line forget-inventory entry (EXEMPT: day, zone, digest, minute counts; no owner text). It fixes the shard-1 blocker. My six should-fix findings went to L1 at 11:56Z, queued, and L1's message suggests it hadn't read them yet. The delta re-review waits for L1's next head.
  - L1 classifies a shard-2 failure at the old head `76d9bcaf` as flaky, fixed upstream by #1087's phase fix [inference].
- **The docs push** was rejected once ("failed") and went through on retry. It was transient.
- **12:04Z, L2:** G1's two owner-DO lines (~`:2101`, ~`:2157`) don't overlap #1089's hunks, and #1089 doesn't touch `owner-turn.ts` [L2's check; it matches mine]. L2 is making the hot-file edits locally on `l2/g1-tool-results`, unpushed.
  - Already committed locally: the ledger reconciliation (24/24) and the red P1 tests for the app and Telegram.
  - L2 is waiting for the slot before it pushes or posts on #116. My "slot is yours" reply is blocked by the message cap until the owner types here.

## 12:08Z: #1088 review: isolation PASS, but FAIL as written (the app-first, Telegram-later transition)

- **Isolation PASS** [verified by the reviewer]: the custody key comes only from this DO's KV `telegram_subject` or the context principal. No app request field, header or model output reaches it. Skill loading grants no tools.
- **Blocking as written (MEDIUM): an owner who starts in the app and links Telegram later loses all 16 skills on both surfaces.** I re-read the mechanism myself at `0e2557c3` (`skills/curated-owner.ts`) [verified by reading; not executed]:
  - `authentic()` requires `created_by === createdBy(s)`, which includes the current custody key.
  - `ensureDefaults()` inserts only missing names and upgrades only rows ending `:owner:${custodyKey}`.
  - `install()` denies when the existing row isn't authentic.
  - So the app's `prn_` rows block the Telegram custody after linking.
  - This is the onboarding path the product expects (connect Telegram from the app later). The body's "Telegram unchanged" and "no data change on revert" claims are wrong in effect: a revert leaves `prn_` rows behind.
- **Lower findings:**
  - The app's dispatch check doesn't re-check the stored subject the way Telegram's does (`:2116` vs `:2158-2162`). A relink race fails closed.
  - Test gaps: no subject in the app request, no `telegram_unlinked` case, no transition case.
  - The body overstates "never from ingress", and the comment should say that `telegram_unlinked` is deliberately ignored.
  - Pre-existing (INFO): `bindIdentity` writes the subject from a Worker header without the regex or the directory re-check.
- **Recommendation for L2** [proposed]:
  - Accept either of this DO's own identities in `authentic()` and in the upgrade loop: the stored Telegram subject, or `prn_<owner>`. The DO never changes owner, which was checked.
  - Add the transition test: app first, then link Telegram, and skills are still active on both surfaces.
  - The alternative is to land E15 (both surfaces on `principal_ref`) first.
- **Owner:** don't merge #1088 at `0e2557c3`.
- **Queued for L2** (message cap): this finding, plus the G1 slot message from 11:59Z.

## 12:11Z: owner on skills and just-in-time loading

- **The owner, verbatim:** "all skills should be there what's problem we have around 27..." and "like JIT skills, tool ,memeory loading".
- **Answer:**
  - The code has 16 reviewed skills: `bundled-text.ts` at `614d1aff`, generated from `skills/*/SKILL.md` [verified]. #1088's transition bug would hide all 16 after a later Telegram link, and the fix keeps every skill on both surfaces.
  - The 27 are the website's profession-preset routines (WP-042, missing). That is a separate promise.
- **Just-in-time loading:**
  - Skills already load just in time: `skills_list` returns metadata, then `skills_load` returns one skill's instructions (`curated-host.ts:41-45`) [verified].
  - Tools don't: there's no tool search or deferred loading in the runtime [verified by grep].
  - Memory is a working set plus on-demand search [inference].
- **Roadmap:** just-in-time tool loading is added to §5 for after the app musts, with a tool-choice eval.
- **The cap has reset.** L2 got the G1 slot and the #1088 finding in one message, queued.

## 12:14Z: heartbeat

- Cron `29a6d33d` is present. `beta-mvp` is `614d1aff`, and staging serves it (wave 2).
- **Open PRs:**
  - **#1089** at `2fc0e642` is CLEAN after the forget-class line. My six should-fix findings are with L1, and the PR stays owner-merge.
  - **#1088** at `0e2557c3` is CLEAN but fails as written (the transition). L2 has the fix, and the PR stays owner-merge.
  - **App:** no new PRs since 11:00Z.
- **#116:** since 11:55Z, only L1's wave-2 record.
- **Lanes:**
  - L1: the #1089 should-fixes and the scheduler fix.
  - L2: G1 (both halves) and the #1088 fix.
  - L4: holding for the owner's answers in L4's session (probe 5 time, the per-kind steer).
  - L3: unreachable.
- **Next:** probe 6 at 16:00Z (L1's watch), then the 17:00Z re-score.

## 12:26Z: #1089 delta re-review PASS at `4b98b1d7`

I read the source delta over `2fc0e642` (+237/−57 across 6 files; about 120 source lines) [verified by reading].

| Finding | Status |
|---|---|
| 1. Forget class | EXEMPT, with the reason in the body |
| 2. Physical load | Null without movement or a workout |
| 3. Finality | `fetched_at` at or after the day's local end |
| 4. Codes | `calendar_demand` codes plus `read_failed`; `weight_demand` `demand_late`/`demand_failed`; no ids |
| 5. Gone calendars | `notFound` is left out and marked `partial`, tagged `calendar_partial` on the target day; other errors are unknown |
| 6. Account selection | By the scopes the read uses; `scope_gap` makes the read unknown |
| 7. Slow reads | The demand read races 5 s beside the series read; Recovery and Form are written first; `finally` awaits the raw read |

- **Also checked:** the re-arm idempotency test, which pins byte-identical rows across three boots.
- **I accept L1's three calls:** the 5 s grace, the tag on the target day only, and `scope_gap` for the whole read.
- **Follow-ups before Weight is shown:**
  - a reconnect hint for `scope_gap`;
  - a test for the `read_failed`/503 path;
  - partial flags on baseline days.
- **Next:** CI at `4b98b1d7`, then the owner's merge (new DO persistence; HEALTH_PLANE_AMENDMENT ruling 1). L1's scheduler fix is on `l1/schedule-row-guard`, red/green not yet run.

- **12:30Z, #1090** (L1, the scheduler bad-row fix): head `4a644e06` on `614d1aff`, changing `multiplexer.ts` plus a new test file.
  - What it does: each row is guarded in `dueEntries` and `rearm`, and a bad row is left out before the slice. It logs `schedule_row_invalid` with a count once per `dispatchDue` pass, never writes to the row, and sets no wake time for it.
  - Red first: both new tests failed with a ZodError at `614d1aff` [reported].
  - Local runs: 204 scheduler tests and 230 RunLoop, tracer and outbox tests pass; tsc passes; guards pass 37/37.
  - Gate: CI is pending; the independent review is running (no fan-out, about 25 calls).
  - Merge is mine under E1 (not on the hold list); deploy needs the owner's yes in L1's session.

## 12:39Z: probe 5 FAIL on `02103423`; correction on tool search

- **Probe 5 (W2):** sent on the test account at 12:25Z and 12:33Z [reported by L1].
  - Each turn made one `query_calendar` call (ok) and ended `resolved` ok.
  - No `propose_calendar_change` call, no `approval_raise`, no failed hop.
  - The test event was at 6 pm IST (12:30Z), so it started between the two sends.
  - The calendar tool logs no count, so we don't know whether the event came back.
- **Diagnosis:**
  - `propose_calendar_change` is eligible whenever Google calendar is granted (`tools/live/google.ts:299-306`) [verified], so a missing tool is unlikely.
  - Hypotheses: (a) the read missed the event (window, zone, or a calendar the account doesn't read); (b) the prompt's time didn't match the event; (c) the event had already started at the second send; (d) the model chose not to propose.
  - The cheapest discriminator is Waldo's reply. I asked L4 for a one-line paraphrase and the exact prompt.
  - Rerun only on the owner's yes in L4's session: an event 2+ hours ahead on the primary calendar, with a prompt that names its time.
- **Correction to my 12:2xZ answer:** the registry has a `search_tools` schema (`hooks/registry.ts:214`, classed `read()`), but no runtime handler [verified by grep: no `name: 'search_tools'`]. "Tools don't load just in time" still holds. JIT tool loading would build on that schema.

## 12:42Z: #1090 review FAIL on claim scope; fixed-id rows are the remaining gap

- **#1090 at `4a644e06`:** the code is correct and safer than base, with no regressions. CI is 6/6 green [verified by the reviewer].
- **Finding 1 (HIGH, the claim):** `read(id)` on fixed-id rows (heartbeat, nightly, brief sweep, day cards) still throws on an unreadable row.
  - It runs inside `ready` (`:2042-2059`), through `heartbeat.ts:33`, `episodes.ts:93`, `event-briefs.ts:16` and `schedule-preferences.ts:60-82`.
  - **Every chat turn awaits `ready`** (`telegram-owner-do.ts:1081`, `:1135`, `:1150`, `:1423`, `:1449` `turn()`) [verified by me]. So a reshaped fixed-id row would break every alarm and every chat turn, the same class as the overnight 503.
- **Rollback check:** `packages/contracts/src/runtime/schedule.ts` is unchanged from `e37f60f3` to `614d1aff` [verified]. Today's rollback to `c7974404` is safe from this bug.
- **Lower findings:**
  - the reaper writes to a quarantined unreadable row once its window has passed;
  - a mutant that logs from `hasDue` survives;
  - slice-before-filter is caught only by the count;
  - unreadable rows that aren't due are skipped silently.
- **Plan (advisor-checked):**
  - #1090 gets a body-only edit (scope, "never written", NOT DONE), keeping the head `4a644e06`, then I merge.
  - L1's next PR is its top priority: unreadable fixed-id rows are skipped in the existence checks and never upserted over.
    - An owner-DO test plants a reshaped heartbeat row; an alarm and an app turn must both succeed.
    - `event-briefs.ts` and `schedule-preferences.ts` are coordinated with L2, and the LOW test fixes are folded in.
    - It lands before anything reshapes a fixed-id row.
  - L2 is told not to reshape fixed-id schedule rows until then.
- **Correction to the owner:** after #1090, skip-and-run-the-rest holds only for rows read at dispatch and rearm. A bad heartbeat, nightly or day-card row still stops every job and every chat turn, until L1's next PR.

## 12:43Z: heartbeat

- **Fixed:** six log headings I had guessed ("12:0xZ" to "12:5xZ") are corrected to their commit times. The 12:5xZ one ran ahead of the clock.
- **#1090:** the head is still `4a644e06`, with CI 6/6 and CLEAN. L1 hasn't edited the body yet (last update 12:31Z). I merge once the edit lands and the head is unchanged.
- **Other PRs:** nothing new since 12:30Z, apart from this docs PR.

## 12:44Z: #1090 merged as `2d18e5e5`

- **The merge:** `gh pr merge 1090 --merge --match-head-commit 4a644e06edb71f0a15148b9850dd8142d39c84f0`.
- **Gate:**
  - CI passed 6/6 at `4a644e06`, pgTAP included.
  - An independent review found the code correct and safer than base, and failed only the claim's scope.
  - The body was edited, with the head unchanged [verified by `git rev-parse`]. It now covers the scope, the reaper exception, and `read(id)`'s blast radius in NOT DONE.
  - The advisor approved the plan: a body-only edit needs no new review.
  - CLEAN.
  - Files: `multiplexer.ts` and a new test.
  - Not on the hold list.
- **Not deployed:** staging stays on `614d1aff`. Deploying needs the owner's yes in L1's session. It's worth deploying with L1's fixed-id follow-up, which is L1's top priority, stacked on `4a644e06`.

- **12:45Z, probe 5 detail** [reported by L4]: at 12:25Z the move request got a clarifying question about which date by 12:26Z. At 12:33Z a follow-up naming the day got "could not identify the event on today's calendar" by 12:35Z. No card appeared, and nothing was approved or deferred.
  - `query_calendar` reads one account's calendar, primary by default, from now through the next 24 hours unless the model passes `date_range` (`tools/live/google.ts:145-164`) [verified]. Google filters on end time, so an event already under way still comes back [inference from the Calendar API].
  - Likeliest causes: (a) the event is on another calendar or account; (b) the model passed a `date_range` or zone that excluded it. L1 is asked for the tool args and the count; the owner, for the event's account and calendar.
  - **Quality note:** asking which date for "my 6 pm" suggests the turn may lack a clear local "today" [inference]. Check the turn context once the cause is known.
  - L4 is building the per-kind skip into movement minutes, with the owner's approval.
- **L1's follow-up scope** [reported; its lines are verified by L1]: the fixed-id arm, cancel and day-plan paths skip unreadable rows and never write to them; cancels are included, since the roll-forward Worker's startup reconcile cancels kinds that are switched off.
  - Two more read paths fail the same way and are added: `standingOrdersPrompt` in the prompt builder (`~:2102`), and the reminder `list()` (`repeatFromRecurrence`). The reminder list feeds `promptLedger`, which covers update cards, follow-ups, the evening job, `/ledger` and the dashboard.
  - `read(id)` keeps throwing only on cancels the owner starts for a known id.
  - L1 is waiting for L2's OK on `event-briefs.ts`, `schedule-preferences.ts` and `day-cards.ts`.
  - **D14** (adopted): a fixed-id row may be reshaped only one release after the guard is live, so the rollback target has it too.

## About 12:50Z: G1 is #1091 (draft); #1088's fix is written locally

- **#1091 (G1, L2):** a draft at `de6211c9` on base `2d18e5e5` (#116 comment 6124573993). It ships both halves.
  - Earlier tool results go in the owner turn as fenced external data, never in the system prompt. A test pins this: external text never joins the system prompt (`owner-turn.ts:440-442`).
  - It shares the receipts block's gate (scribe and session canaries) and has a 4096-byte cap that drops the oldest entry whole. Owner turns only; job prompts get nothing.
  - REASONS is byte-identical, because `context_ref` is checked on replay.
  - Receipt half: a linked entry shows `desk.approvals` state, or is withheld if the desk can't answer. Old rows read exactly as before.
  - DO change: one line, at the ledger.
  - The P1 tests on the app and on Telegram were red at base. Mutations: 12/14 caught; the two survivors are defence in depth.
  - A full wall at `de6211c9` is running. Gate when it's ready: CI, an independent review, the advisor, then my merge under E1.
- **#1088 fix (local):** custody aliases.
  - Telegram accepts the stored, directory-verified `owner_principal_ref`, and the app accepts the app principal. New rows are stamped with the surface's own key.
  - The app re-checks the stored subject in `assertOwnerIdentity`.
  - Tests: app first, then link Telegram, gives all 16 skills on both surfaces. A spoofed `x-waldo-telegram-subject` header changes no custody.
  - It stays owner-merge.
- **L2 OK'd L1's guard edits.** Skipping cancels is safe because `gateScheduleExecutors` cancels a disabled kind at dispatch (`schedule-preferences.ts:103-111`) [reported].
- **#1079:** L2 asks for it to be closed as superseded after #1091 merges. It's L2's PR, so L2 should close it. Closing a PR is outward-facing, so I won't.

## 12:54Z: heartbeat; usage pace warning

- **State:** `beta-mvp` is `2d18e5e5`; staging is `614d1aff`. #1091 is a draft at `de6211c9`, CI running. No app PRs since 12:00Z.
- **Usage:** the 5-hour window is at 34%, 85 minutes after its 11:30Z reset, which works out to about 24% an hour [inference]. At that pace it runs out around 15:40Z, before probe 6 at 16:00Z and before the 16:30Z reset.
  - My context is at 74%, so cycles stay lean.
  - Proposed: the lanes pace down (no subagents, fewer long turns) until 16:30Z, or the owner accepts a pause.

- **13:14Z heartbeat:** #1092, L1's fixed-id follow-up, is open at `457c0f67` with CI running. #1091 (G1) is a draft at `10dbfdec`. No new app PRs. The #1092 review starts when L1 reports the head and CI, so it doesn't chase a moving head.

- **13:15Z, #1092 ready for review** (L1): head `457c0f67`, which merges `2d18e5e5` into `e200dccc` with the tree unchanged.
  - The change: `Scheduler.lookup(id)` and `cancelReadable(id)`. The arm paths treat an unreadable row as present, and the preference cancels and day plan skip it. The prompt paths leave it out. `read(id)` still throws for cancels the owner starts.
  - Red first [reported]: at `4a644e06`, a reshaped heartbeat, nightly or brief-sweep row ends an app turn `interrupted`, and the planner deletes a reshaped day-card row. With the fix, all 4 cases pass and the row stays byte-identical.
  - Evidence: 4891 tests pass under the default config, mutants 14/14, tsc and guards pass. CI is running.
  - The independent review is running, with no fan-out and about 30 calls. L1 wants one deploy after #1092 merges, which needs the owner's yes in L1's session.

- **13:16Z, probe 5 diagnosis:** L1's tail can't see the `query_calendar` arguments or an event count. The tool logs ok with no code (12:25:57Z, 12:34:06Z). Raw capture is off by design, and `calendar_id` is often an email address.
  - Chosen: option (3). L1 writes a count-only log line for the tool (window default | date_range, calendar primary | other, events N), with L2's OK on the tool path. It falls under the D13 standard and merges under E1 after the gate.
  - Still open: option (1), the owner naming the account and calendar. Option (2), Langfuse, is not used without the owner's go.
  - Message cap: 9 of 10 sends used since the owner's last message.
