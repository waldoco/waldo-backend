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
  - **HOLD (health destinations):** `ledger()` puts health-log lines ("~612 kcal, estimate", "N min") into the day-card machine prompt, which is saved verbatim to `conv:*` and the `episodes` FTS table. That already happens for Telegram owners; #1066 extends it to app-only owners.
  - **PASS on:** reminders never held; no Telegram-addressed delivery for app-only owners; no burst beyond the cross-date case; app.v1 shape; no migration; bounded strict-load failure (retries at 30 s and 60 s, then a 24 h quarantine).
  - → **Held for the morning.** L2 fixes 1-3 tonight (board). The owner rules on the health-log question.
- **Messages:** 10 used (5 `send_message` + 5 `SendMessage`). From here, lanes get instructions through the board and their own crons.
