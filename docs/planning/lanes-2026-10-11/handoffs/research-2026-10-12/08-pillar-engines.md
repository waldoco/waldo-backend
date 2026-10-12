# B. Engine maturity for pillars P1, P2, P3, P4, P6, P7 and P8

Read-only research for the overnight orchestrator, 12 Oct 2026. Nothing was edited, run, committed, pushed, posted or deployed. No Waldo endpoint was called. Read-only `gh pr view` calls were made for #1032 (metadata and body, as the brief asked), and also for #1071 and #1080 (metadata only).

## Pins, shorthand and labels

- **Backend:** `origin/beta-mvp` = `889efa27c55a1c6a1ae945d906f791e222778a0b` (merge of #1075), read from `git archive` into the scratchpad. `git rev-parse origin/beta-mvp` matched at the start of this run [verified].
- **App:** `origin/main` = `6dcba63b8f52c3bc892bbfd13ed6f9e386682719` [verified].
- **Shorthand:** `DO` = `packages/runtime/src/channels/telegram-owner-do.ts`; `rt/` = `packages/runtime/src/`; `ct/` = `packages/contracts/src/`; `test/` = `packages/runtime/test/`; `app/` = the waldo-app tree.
- **Labels:** [verified] = read at the pin (read, not executed). [inference] = my conclusion. [unverified] = not checked or not checkable from source. [reported] = a lane report or log entry I did not re-check.
- **Memory, context and the harness** are report 04's slice. Its memory findings, in five lines:
  1. Memory is explicit tools (`remember`, `read_memory`, `forget_memory`) with owner-quote grounding and literal forget that reaches canonical rows.
  2. Prior turns' tool results reach the reply model on neither path (L2's #1079 later pinned this with tests [reported]).
  3. History is cut in three places, silently; only one cut is logged.
  4. App chat is invisible to `search_episodes` and to nightly consolidation; `speakerOf` would misfile app owner turns.
  5. The prompt layout prevents cross-turn prompt caching, and nothing carries "what is in flight" across turns.

### Maturity scale used here

The scale is the one in the brief, with one sharpening at level 4, because every file at `889efa27` is "deployed":

| Level | Meaning in this report |
|---|---|
| 0 | Missing, or present but unreachable for that owner type |
| 1 | Designed or contract only |
| 2 | Partial in source |
| 3 | Built and tested in source (including deployed code that no served route or flag reaches) |
| 4 | Reachable on staging from the source's config, flags and bindings at the pin. Worker secrets are unknowable from source, so a level 4 that needs a secret says so |
| 5 | Verified live. The only live evidence in hand: two app Main-chat sends with replies at 02:41Z on 12 Oct |

Where surfaces diverge, the level is given as **app-only owner / Telegram owner**.

---

## Summary

| Pillar | Level (app-only / Telegram) | Engine in one line |
|---|---|---|
| P1 Durable workflows | **4** for the owner-DO engine (one live path, plus one live defect). **3** for WaldoCoordinator/RunLoopDO (unreachable) | Safe, not resumable: intent-before-I/O and readback reconciliation for approved effects; interrupted turns end honestly and are never resumed |
| W2 Approvals desk | **4** (propose, present, approve/skip/edit, dispatch, receipt, calendar undo). Defer **1**. Expiry-on-read **0** | Strong effect safety; "Not now" refused; expired items served as open |
| P2 Computer use | **0 / 3** | Browserbase or Cloudflare browser reads, read-mostly; app-only owners rejected; staging default route fails closed; no desktop executor |
| P3 Skills | **0 / 4** | 16 reviewed SKILL.md procedures with progressive disclosure, Telegram only; no owner-authored skills |
| P4 Triggers and scheduled jobs | **2 / 4** | Robust DO scheduler; reminders reach the app transcript; app arming, push and event triggers missing |
| P6 Channels beyond app and Telegram | **WhatsApp 2, iMessage 2, inbound email 0, push 1, voice in 3 / out 0** | Ingress code exists for WhatsApp and iMessage, but neither can be used end to end |
| P7 Identity and payments | **Identity 4 (email OTP), Google 0, 18+ at sign-up 0, Trusted Relationship 1, payments 0** | Invite-gated email OTP with 12 h sessions; no billing anywhere |
| P8 Evals and observability | **Tracing 4, alerts 0, evals 2** | Langfuse traces with cost and context bytes; a manual, self-judged, Telegram-path eval runner; nothing model-graded in CI |

---

## P1. Durable workflows

### Two engines, one carries the traffic

**1. The trusted run loop (WaldoCoordinator inside RunLoopDO) is not on the owner path.** [verified]
- `WaldoCoordinator` is constructed only inside `RunLoopDO` (`rt/run-loop/do.ts:378,398`).
- The Worker reaches `RunLoopDO` only through the responsibility public handler (`rt/index.ts:274`), which runs only when `RESPONSIBILITY_PUBLIC_API_ENABLED === 'true'` (`rt/index.ts:224`). That var is set in neither `vars` block (`rt/../wrangler.jsonc:20,84`), so on staging it would have to be a secret [unverified].
- Its work-unit execution uses `DeterministicFakeExecutionEnvironment` (`rt/run-loop/work-unit-execution.ts:184,239-241`).
- `TracerDO` is bound (`wrangler.jsonc:26`) but no Worker route calls it; `TRACER_DO` appears only in the `Env` type (`rt/index.ts:76`).
- RunLoopDO also has a "common host" bridge for owner messages, `commonExecutionFromHost` and `commonTaskSourceFromHost`, held unless `COMMON_OWNER_TASKS === '1'` (`do.ts:444-445,563-564`; set in no vars block). No source file calls either method. Only `test/owner-do-ingress-isolation.test.ts` does (`:47-48,999,1074-1095`).
- The owner turn imports run-loop *adapters* in-process (`rt/channels/owner-turn.ts:23,140`, `resolveRunLoopAdapters({ WALDO_ENV: 'local' }, …)`), not the DO.
- Tested in source: 19 test files cover the coordinator, run loop, trusted v2 property tests and responsibility routes (`test/waldo-coordinator.test.ts`, `trusted-run-loop.test.ts`, `run-loop.test.ts`, …) [verified by listing; not run].
- **Level 3.** CLAUDE.md calls this the canonical authority to keep; in practice no owner message reaches it.

**2. The owner DO's own machinery carries every app and Telegram turn.** [verified]

| Mechanism | What it does | Evidence |
|---|---|---|
| App inbox | One durable writer. Admission is idempotent on `client_message_id` plus a text digest, and commits the payload and its alarm wake before the 202. Claim sets an attempt id and a 15-minute deadline. Every effect calls `scope.admit()`, which re-reads the row (fencing). Settle ends `completed` or `interrupted`. | `rt/channels/app-inbox.ts:36-58,89-113`; wake `rt/scheduler/alarm-slot.ts:13-17` |
| Restart recovery | A `running` row with no live attempt becomes `interrupted`, `effectsUnconfirmed: true`, text cleared. It is never runnable again. | `app-inbox.ts:60-66`; called at `DO:634,747` |
| Sign-out fence | Admitted and running rows of the session become `revoked`; a running turn stops at its next `admit()`. | `app-inbox.ts:76-88` |
| Effect ledger | Intent and quota are reserved in one synchronous transaction before any I/O (`reserved`). Then `attempting`, then dispatch. A dispatch error goes to keyed `reconcile()` readback, which yields `done`, `rejected` (not applied) or `unknown`. A crash after I/O leaves `attempting`, and the next execute reads back instead of re-sending. | `rt/channels/owner-effect-ledger.ts:53-71,79-87,93-114` |
| Ledger coverage | Approval-desk applies and undos, Google Task changes, `draft_email`, workspace writes and renders. | `approvals.ts:239-241`; `google-task-approvals.ts:149`; `rt/tools/live/google.ts:335`; `workspace-render.ts:27,47`; `workspace.ts:65`; constructed `DO:1915` |
| Not ledger-covered | Reminder and card sends, scheduled app deliveries (`appDeliveryFor` → `store.save`), scheduler writes. | `DO:2183-2232`, `DO:571-594` |
| Scheduler (`multiplexer.ts`) | SQL `schedule` table plus append-only `schedule_runs`. At most 8 due rows per alarm. Retries at 30 s × attempts; quarantine for 24 h after 3 attempts. Missed-run policy fires only the latest elapsed occurrence and records the rest as `missed` (no catch-up burst), with a bounded 64-step walk. Telegram reminders and heartbeats are deduped against the committed final outbox. Run rows record a crashed attempt as evidence. | `rt/scheduler/multiplexer.ts:17-27,143-231,233-240,300-329,334-357,429-497` |
| Single alarm slot | One owner of `setAlarm`, enforced by `guard-setalarm`; one arbiter merges every due key (app inbox, outbox, inbox, link, browser, WhatsApp, schedule). | `alarm-slot.ts:1-8,31-43` |
| Honest ambiguity | Telegram: `notifyUncertainRecovery` after recovery (`DO:294,1300`). App: the receipt carries `closed_reason` and `effects_unconfirmed` (`app-inbox.ts:32-35`). | as cited |

- **Tests:** dedicated files include `owner-effect-ledger`, `owner-effect-adversarial-review`, `owner-effect-break-936`, `run-effect-fence`, `telegram-owner-inbox-crash-matrix`, `scheduler-catchup`, `schedule-runs`, `scheduler-alarm`, `telegram-final-outbox`, `app-inbox`, `unbound-owner-alarm` (`test/`, 469 files in all) [verified by listing; not run].
- **Live:** the 02:41Z sends exercised admit → claim → turn → settle → receipt [reported]. That same send also triggered the overwrite below.
- **Level 4**, with a live data-loss defect.

**What survives a Worker restart** [verified code; consequences inferred]:
- Mid-turn: nothing resumes. The app turn ends `interrupted` with `effects_unconfirmed`, and the owner must send again. The Telegram inbox recovers the same way and tells the owner.
- Mid-effect: an approved calendar change, email, task change or workspace write is safe to retry. The ledger reads back by marker or Message-ID before acting again (`approvals.ts:392-393,585-642`).
- Mid-reminder on Telegram: the committed-final check stops a double send (`multiplexer.ts:233-240`).
- Mid-reminder on the app: no such check exists, because the app path has no final outbox. A crash between `store.save` and `book.fired` could write a second reminder row with a second model call [inference from `DO:2219-2220` and `multiplexer.ts:157-167`; the window is narrow; untested].

### The live `commit()` overwrite [verified at the pin]

- Both canonical commit paths write each new row at `conv:<count + i>`, where `count = kv.get(prefix + 'count') ?? 0` (`rt/conversation/canonical-owner-store.ts:150-153,172-175`).
- A store whose rows were written by an older build without a `count` key loses its first rows, one per new row, until `count` passes the last old slot. That includes rows that load fine.
- Every app send (`persistOwnerInput`, then the reply save) and every scheduled app delivery (`store.save` at `DO:589`) goes through it.
- [reported] It overwrote one row on the owner's staging account at about 02:41Z (overnight log, 03:00Z). The fix #1080 is still an **open draft** (`gh pr view 1080`: OPEN, isDraft, head `f17be611`) [verified at the time of this run]. The review asked for two more tests [reported].

### W2: the approvals desk lifecycle [verified]

| Step | State at the pin | Evidence |
|---|---|---|
| Propose | Six kinds; payload frozen into `payload_json`; `proposal_digest` and origin run bound | `approvals.ts:680-800` |
| Present | A row opens only after a surface records the review (`approval_presentations`); approvability is per surface, by how much it could show | `approvals.ts:270-303` |
| Approve, skip, edit | Digest-checked on the app (409 `superseded` on a stale digest); idempotent receipt book keyed by session and `request_id` | `app-approvals.ts:40-57`; `approvals.ts:386` |
| Dispatch | Through the effect ledger, with readback for an ambiguous outcome | `approvals.ts:239-241,585-616` |
| Receipt | `done`, `not_done`, `outcome_unknown`, `undone` mapped for the app | `approvals.ts:22-25` |
| Undo | Calendar only, within 10 minutes, etag-guarded, itself ledger-backed and read back by marker. Email, message, MCP, task and browser submits say they cannot be undone. | `approvals.ts:31,371-384,618-642,415,489-567` |
| Expiry | 12 h TTL (30 min for browser submits). **Written only inside `decide()`.** `pending()` and `approvals()` list by stored status, so an expired request is still served as open until someone taps it. | `approvals.ts:32,51,349-351,400-412,810-860` |
| Defer ("Not now") | In the contract; refused at runtime with 409 `no_longer_eligible` | `app-approvals.ts:45-46` |
| Resurfacing | `present()` is called only from the propose paths (`approvals.ts:694,703,728,758,767,794`). A request is shown once, so anything deferred would never come back without new code. | as cited |

- [reported] L4 saw the owner's two 9 Oct requests still served as open about 2.5 days after expiry. That is live evidence of the expiry defect. L3's fix branch `l3/approval-expiry-on-read` is local only. L2's defer branch #1076 is a held draft that needs a DO `ALTER`.
- No owner cancel exists for a running app turn: the DO handles only GET under `/app/v1/chat/main/messages/{id}` (`DO:631-636`), so the cancel route the contract declares falls through to 404.

### Industry bar [inference]

- Durable-execution engines (Temporal, Restate, Inngest, Cloudflare Workflows) checkpoint step results and resume after a crash.
- Waldo's owner path is stronger than most agent frameworks on effect safety: intent before I/O, keyed readback, digest-bound approvals, per-surface presentation records. It is weaker on continuity: no step checkpoint, no resume, and no timer-driven lifecycle (expiry, reminders to decide).

### App-only vs Telegram

- Same engine. Telegram additionally has the final outbox (delivery dedupe) and the uncertainty notice. The app has receipts and nothing that resurfaces a closed turn.

### Three biggest gaps

1. The live `commit()` overwrite (#1080 unmerged).
2. Not resumable: an interrupted turn is abandoned. There is no checkpointed step to resume, and no cancel route for the owner.
3. No timer-driven approval lifecycle: expiry happens only on a tap, "Not now" is refused, and nothing resurfaces. The canonical WaldoCoordinator plane, which has the richer outcome model, carries no owner traffic.

### Minimal NL demo

- "Move my 3 pm to 4 pm" in app chat → approve the card in the app → the event moves → "undo that" within 10 minutes → the card reads `undone` after a refresh.
- **Needs:** #1080 deployed; Google connected live on staging (never run [reported]); expiry-on-read merged so stale cards don't confuse the demo.

---

## P2. Can use a computer

### Engine [verified]

- **`browse_page`** (`rt/tools/live/browser.ts:97-157`). Two providers:
  - **Browserbase Stagehand over HTTP:** start session, navigate, model-driven `extract`, end. Needs `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`.
  - **Cloudflare Playwright:** needs the `BROWSER` binding.
- **`browse_act`** (`browser.ts:198+`): up to N observe-then-act steps.
  - It stops before anything that looks irreversible: a fixed regex over the action description plus a safe-method allow-list (`browser.ts:173-179`). This is a deterministic safety line, which CLAUDE.md allows for hard safety boundaries.
  - An irreversible step can become a `browser_submit` approval bound to page facts extracted at that moment.
- **Native owner browser** (`rt/channels/owner-browser-runtime.ts`): retained sessions, DOM and accessibility snapshots, screenshots, downloads to the private workspace, an `owner_login` handoff. It is per-owner and spend-capped (`common-spend-reservation.ts`, `common-public-browser-configuration.ts:105`).
- **`web_search`:** the Brave API, needs `BRAVE_SEARCH_API_KEY` (`rt/tools/live/web-search.ts:20-40`).
- **Registration:** both browse tools are registered for every channel (`DO:2067`), wrapped by `ownerBrowser.read`/`act`.

### What happens on staging at the pin [verified code; outcomes inferred]

1. **Staging routes the default to Cloudflare.** The staging entry registers the Playwright SDK (`rt/staging-browser.ts:7-8`), so `defaultProvider` becomes `cloudflare_playwright` (`browser-public-read-configuration.ts:20-26`). No `BROWSER` binding is bound, on purpose (`wrangler.jsonc:78`).
   - A call with no `provider` goes down the Cloudflare path (`owner-browser-runtime.ts:138`) and fails closed: "The selected Cloudflare browser provider is unavailable" (`:153`).
   - Failure never switches providers (`:136`). `provider` is optional in the schema (`ct/tools/schemas/reads.ts:223`).
   - Only an explicit model choice of `browserbase_stagehand_http_v3` reaches Browserbase, and only if those secrets are set [unverified].
2. **App-only owners are rejected before any routing.** `read()` and `act()` call `current(ctx)` first (`owner-browser-runtime.ts:135`). `current()` and `assertOwner()` require `telegram_subject` and a live Telegram binding (`:49-70`).
   - So an app-only owner gets `rejected`: "The browser owner or retained session is unavailable" (`:172`), whatever the provider.
   - Meanwhile `eligibleWith` answers `ok` on staging (`:47-48`), so the tool is offered on every app turn and its call always fails.
3. **The latency note conflicts.** The owner memory note (10 Oct) says `browse_page` dominated latency, which suggests browse calls ran on staging after this routing landed (6–8 Oct, `git log -S`). Telegram turns that chose Browserbase explicitly would explain it. I could not check this [unverified].

### Desktop executor [verified]

- The device bridge offers only `machine_state_query` and `notify_local` (`rt/devices/contract.ts:2`).
- Kennel and execution use the deterministic fake (above).
- No outbound request in runtime source sets a `User-Agent` (grep: zero matches). The browser presents whatever the provider defaults to, and nothing identifies Waldo to the sites it reads.

### Browser lane PRs [verified metadata, read-only]

- **#1032**, "Browser lane: draft audit, errand set and any-surface design": OPEN, draft, docs only (2 files, +408), last updated 10 Oct.
  - Its findings: only Telegram-linked owners can browse (confirmed above at the pin); the native browser cannot submit; S0 has never run; card fields are not masked; "health never goes to browser jobs" is unenforced for typed or URL values. I re-checked only the first.
- **#1071**, "Staging browser binding under a dated owner exception (prod stays off)": OPEN, draft (4 files, +63/−6).

### Industry bar [inference]

- ChatGPT agent and Operator, Claude computer use and Manus drive a hosted browser from the main chat on any surface, with sign-in takeover and an approval before purchase.
- Waldo's safety design (approval-bound submits with page-fact binding, spend ceilings) is ahead of a typical demo. Its reach is behind: read-mostly, Telegram-only, and the staging default fails closed.

### Three biggest gaps

1. App-only owners cannot browse at all. Admission is keyed to the Telegram subject, not the canonical owner principal.
2. On staging the default route has no binding (#1071 held), and the tool is still offered to the model.
3. No desktop or computer executor (Kennel is fake), and S0 has never run.

### Minimal NL demo

- In app chat: "What are the opening hours on <public URL>?" → Waldo reads the page and answers with the source link.
- **Needs:** owner-browser admission from the app session's canonical principal; the `BROWSER` binding (#1071), or a staging default that reaches a configured provider; the S0 network-block test passed; an eval case for "page unreadable, say so".

---

## P3. Skills

### Engine [verified]

- **Bundled skills.** 16 `SKILL.md` folders in `packages/runtime/skills/` with `name`, `description` and `tools` frontmatter (for example `skills/meeting-prep/SKILL.md:1-5`). They are bundled into text (`rt/skills/bundled-text.ts`) and parsed into a reviewed catalog (`rt/skills/curated-catalog.ts:4`; `curated-owner.ts:9-10`).
- **Progressive disclosure.** The catalog metadata goes into the prompt. `skills_load` selects one enabled reviewed version, and its instructions enter trusted, bounded context on the next step, never in the tool result (`rt/skills/curated-host.ts:41-50`).
- **Defaults.** Every reviewed catalog skill is inserted `active` for an owner with no row, and a disabled skill is never re-enabled (`rt/skills/curated-owner.ts:61,65-69`). So all 16 are live by default on Telegram.
- **Owner lifecycle commands.** `/skills install|disable <name>@<version>` (`curated-host.ts:43-48`). Uploaded skills are refused ("Does not accept uploaded skills or grant capabilities").
- **Authority.** A skill grants no tools: each call re-checks the owner, turn, run scope, trigger and taint (`curated-host.ts:32-39`).
- **Build gate.** `pnpm verify` starts with `node packages/runtime/scripts/bundle-skills.mjs --check` (root `package.json:21`).
- **Tests:** `test/curated-skills*.test.ts` (6 files), `bundled-skill-l1.test.ts`, `owner-do-ingress-isolation.test.ts` [verified by grep; not run].
- **Owner-authored skills: not wired.** `MutableSkillReader` (`rt/skills/mutable-reader.ts:115`) has a stub loader that returns no skills (`rt/context-composer/skills.ts:108`). The closest owner-taught routines are standing orders and cron reminders (`standing-orders.ts`, `reminders.ts:76-85`).

### App-only vs Telegram [verified]

- The skill host is built only when `channel === 'telegram'` (`DO:2077,2112`).
- App turns get only a health context host and the canonical history (`DO:2129-2137`): no catalog, no `skills_*` tools, no procedures.

### Industry bar [inference]

- Anthropic's Agent Skills (SKILL.md frontmatter, metadata first, instructions loaded on demand) is the reference pattern. Waldo matches the format and the loading pattern closely, with stricter authority.
- OpenClaw and Hermes let users edit their agent's files directly (competitor report 02, lines 31-32 for memory files). Waldo has no owner-authored path.

### Three biggest gaps

1. Not wired for the app, the primary surface.
2. No owner-authored or owner-taught skills (stub reader).
3. No eval proves a skill is chosen when it fits or skipped when it doesn't (the 46 eval cases have no skill cases; see P8).

### Minimal NL demo

- In app chat: "Prep me for my 3 pm" → Waldo loads `meeting-prep`, reads the event and threads, and answers with sources.
- **Needs:** the skill host for the app channel; Google connected; one eval case on skill selection.

---

## P4. Triggers and scheduled jobs

### Engine [verified]

- **Scheduler:** P1's multiplexer.
- **Kinds.** The contract defines ten (`ct/runtime/schedule.ts:4-15`). The owner DO wires six executors: `reminder`, `heartbeat`, `dreaming` (nightly), `pre_activity_spot` (Prep), `brief` (day cards), `standing_order` (`DO:1349`). `journal`, `handoff`, `pre_brief_sweep` and `patrol` have no owner executor.

### Reminders end to end

| Step | App-only owner | Telegram owner |
|---|---|---|
| Owner says it | An app turn. The first app send writes `app_subject` (`DO:739`), which delivery needs later | Telegram turn |
| `set_reminder` | Same tool. Parses local time **in `clock.timezone`** and supports once, daily, weekdays, weekly and cron. The note sits beside the schedule row (`rt/channels/reminders.ts:22-50,76-85,101-116`) | same |
| Time zone | Stored zone, else `WALDO_OWNER_TIMEZONE` (set in neither vars block), else **UTC** (`DO:1627,1634`). The app's automatic zone write runs only when `timezone_confirmed === false` (`app/src/agent/controlsController.ts:53`), and nothing at the pin produces that field (grep: zero matches in `rt/`). **So "at 5" means 17:00 UTC unless the owner tapped the device-zone row in Settings, or a staging secret sets `WALDO_OWNER_TIMEZONE`** [unverified; falsifier: L1 or the owner checks the secret list or the account's stored zone]. | Same rule; console and Telegram owners usually set the zone |
| Alarm | `alarm()` → `appOwnerLookup()` must answer `admitted`, which needs `app_subject` (`DO:550-566,1271-1286`) → `setup('app').fire` | `alarm()` → Telegram runtime `fire` |
| Fire | A model call (`responder.remind`), then `api.sendMessage` → `appCaller` → `appDeliveryFor` writes one assistant row to the canonical transcript (`DO:2183-2232`, `571-596`; `rt/channels/surfaces/app.ts:17-24`) | Final outbox, deduped by committed final (`DO:2209-2217`) |
| Owner sees it | **Only on the next history read.** The app polls only while its own sent turn is pending (`app/src/agent/appRuntime.ts:79-91`). `onActive` restores a pending turn and does not reload history (`:47`). No push. [reported] "Reminders appear only after a refresh" | Telegram push from the bot |
| Tests | Alarm to transcript: `test/app-owner-scheduled-work.test.ts:111-145`. The fixture seeds the reminder through `reminderBook.set` in UTC and writes `app_subject` by hand (`:66-90`), so the full NL chain is not tested in one piece | `reminders-do.test.ts`, `reminders.test.ts` |
| Quiet hours | Reminders are never held | same |

### Proactive jobs at the pin [verified; matches report 05 §C]

- **App runtime `ready` arms nothing** (`DO:2024`).
- **Telegram runtime `ready`** arms nightly, the event-brief sweep, day cards and heartbeat (`DO:2024`).
- **App `timezone.set`** arms nightly only (`DO:2647-2651`).
- **Prep (`pre_activity_spot`)** exits for non-Telegram channels on staging, and so do update cards and mail follow-ups [report 05; not re-read].
- **Nightly** reads only the legacy episodes index, which has no app chat (report 04, finding 3).

### #1066 (held), head `c8d3190c`, base `889efa27` [verified diff]

- **Arming.** `armOwnJobs` arms nightly, day cards (re-planned to the zone) and heartbeat once `timezone_confirmed` is true. `timezone.set` writes that flag and rearms.
- **Holding.** An alarm-time `held(kind)` on the app channel always holds `event_briefs` and holds every other preference kind until the zone is confirmed. Reminders are never held.
- **Projection.** The `day` view emits `timezone_confirmed`, which would activate the app's automatic zone write.
- **Tests.** `test/app-owner-proactive.test.ts` (+191).
- **Still open after it** [inference from the diff plus report 05]:
  - Delivery still needs a first chat message (`app_subject`).
  - Prep and update cards stay off on the app.
  - No push.
  - It is held on the owner's health-destination ruling: health-log lines reach the day-card machine prompt, which is saved to kv and episodes [reported].

### Event triggers [verified]

- **No Gmail or Calendar push watch.** A grep for `users/me/watch`, `events/watch`, `pubsub`, `historyId` and `x-goog-resource-state` finds nothing.
- **No health-change trigger on the owner path.** The `fetch_alert` / `healthkit_acute` triage exists (`rt/triage/dispatcher.ts:230`), but only `RunLoopDO` and `TracerDO` import it (`do.ts:143`, `tracer-do.ts:21`), and neither carries owner traffic.
- **Event ingress** (`rt/channels/event-ingress.ts`): GitHub HMAC or token-verified generic envelopes, gated by `WALDO_EVENT_SOURCES` (in no vars block). They are stored and sent as a plain notice through the Telegram runtime, and never fed to a turn (`:5-10`). App-only owners get nothing [report 05].
- **Net:** all proactivity is clock-driven. The heartbeat scans and lists overdue loops with no model call (report 05, DD-10).

### Industry bar

- OpenClaw: heartbeat plus cron with active hours and a model-decided `NO_REPLY` (report 02, lines 90-102).
- Hermes and Letta: cron (Letta cloud cron in UTC; Hermes has open time-zone bugs) (lines 177-196, 213-215).
- Khoj: automations delivered by email (line 254).
- Meta Muse: background work "on a schedule and in response to relevant events" (line 57).
- Waldo's scheduler engine is more rigorous than any of these documents (missed-run policy, quarantine, run history) [inference]. It lacks event triggers, app-side arming and push, and a model-decided silence outcome.

### Three biggest gaps

1. App delivery is invisible until a refresh: no push, no history poll.
2. App-only arming and zone: nothing arms at sign-in; the zone defaults to UTC; the automatic zone write is inert until #1066 deploys.
3. No event triggers (mail, calendar or health change) on the owner path.

### Minimal NL demo

- In the app: "Remind me at 5 to call Sam" → at 5 local, a push arrives; tapping it opens Main chat on the reminder.
- **Needs:**
  1. #1080 deployed (otherwise the delivery itself can overwrite history).
  2. The owner's zone set: by hand today, or automatically once #1066 and the app's write are live.
  3. An APNs sender plus device routes plus app token registration (W2/S7, none exist).
- **Without push**, the demo works today only as: set the zone by hand, then reopen Main chat after 5 [inference; untested end to end].

---

## P6. Channel adapters beyond app and Telegram

| Channel | State | Evidence | Level |
|---|---|---|---|
| WhatsApp | The webhook is routed into `whatsappTurn` through a Telegram-shaped shim. Audio and images come in. Approvals arrive as `a/s/e/u:<id>` text. **Linking cannot complete:** the only link-code issuer inserts provider `'telegram'` (`supabase/migrations/20260924130000_waldo_console_auth.sql:47`), and redemption matches on provider (`20260924120000_waldo_owners.sql:85`). Turns go to the legacy transcript. | `rt/index.ts:179-181`; report 05 CX-3 | 2 |
| iMessage | `rt/channels/imessage/*` (4 files) has no importer in `rt/`. `packages/imessage-relay` (relay, mailbox, outbound, receipts) has 6 test files and runs in `verify:node`. Not routed; no presence migration. | grep; root `package.json` `verify:node` | 2 |
| Inbound email | **No Email Worker handler** (grep for `async email(` / `ForwardableEmailMessage`: zero). CLAUDE.md names inbound email as a launch presence. | — | 0 |
| Push / APNs | No sender, no device-token route (`/app/v1/devices*` answers 404, report 05 §A). The delivery gate models an `apns` channel (`rt/delivery-gate/gate.ts:98-176`), and the only "sender" is an in-memory fake (`rt/tracer/sink.ts:17`). App: `expo-notifications` is in `package.json` and imported nowhere. [reported] The keyless APNs reachability spike passed at 21:55Z. | as cited | 1 |
| Voice in | Speech-to-text through ElevenLabs or Smallest.ai, chosen by `WALDO_STT_PROVIDER` or the first key present (`rt/llm/transcriber.ts:17-24`). Telegram voice and audio and WhatsApp audio are transcribed (report 05 CL-1). The app is text only. | as cited; keys [unverified] | 3 on Telegram/WhatsApp; 0 on the app |
| Voice out | No text-to-speech anywhere (grep: zero). The contract's voice part has no producer. | — | 0 |

### Industry bar

- Poke: Apple Messages, Telegram, WhatsApp and RCS. Letta: Telegram, Slack, Discord, WhatsApp, Signal. Muse: iOS, Android, web, WhatsApp. OpenClaw: iOS push through an APNs relay (report 02, lines 20, 40, 134-136, 219, 255).
- Waldo is behind on reach. It has two working surfaces and no push.

### App-only vs Telegram

- None of these channels can be added by an app-only owner today. WhatsApp linking is blocked in SQL; iMessage is unrouted; email is missing.

### Three biggest gaps

1. No push (S7/W2 not built).
2. No inbound email handler, although email is a named launch presence.
3. WhatsApp linking is impossible (issuer hard-codes `'telegram'`), and both WhatsApp and iMessage would land in the legacy transcript, not the app's.

### Minimal NL demo

- Send Waldo a WhatsApp voice note, "remind me at 5 to call Sam" → it confirms in WhatsApp → the app's Main chat shows the same exchange.
- **Needs:** a `'whatsapp'` link-code issuer; WhatsApp secrets; a canonical-history factory for the WhatsApp runtime plus the `speakerOf` fix (report 05 §D); Meta's eligibility (ruling 8).

---

## P7. Payments and identity

### Owner sign-in [verified]

- **Flow.** POST `/app/v1/auth/code` then `/auth/verify`. Supabase email OTP. An existing member resolves by Auth user plus exact confirmed email; otherwise the person joins with a recipient-bound invite, spent atomically (`rt/identity/console-auth.ts:105-121`; `rt/channels/app-api.ts:108-137`).
- **Throttles.** Edge limits per address and per IP, plus a durable throttle (`app-api.ts:62-73`).
- **Session.** 12 h absolute from creation, no refresh route (`app-api.ts:75-83`).
- **Sign-out.** Fences the DO, revokes push and the session, verifies it is gone, then fences again [report 05 §A].
- **App screen** (`app/app/(auth)/agent-sign-in.tsx:14-57`): email, invite and code only. **No Google, no Apple, no 18+ checkbox.**
- **The only 18+ attestation** is on health consent: `age_attested_18_plus: z.literal(true)` (`ct/app/health-ingest.ts:38`; `app/src/components/health/HealthConsent.tsx:77-78`).
- **Live:** the 02:41Z sends needed a valid app session, so this path worked live [inference].
- **Level 4.** Google sign-in 0; 18+ at sign-up 0.

### Account linking [verified]

- **Telegram.** A console action (`telegram.link`, or the link page) issues a 10-minute code for `/link <code>` to the bot (`DO:1102-1106,1238-1243`; `console-auth.ts:140-143`). The app has no link action; `channel.unlink` is rejected for the app [report 05].
- **Verified-email linking.** Email is the account key. No second sign-in provider exists, so there is nothing to auto-link by email. The owner's ruling targets the unbuilt Google O2 flow.
- **Trusted Relationship signed exchange.** Contract only: `ct/runtime/trusted-coordination.ts` has no runtime consumer (grep: zero). Level 1.

### How Waldo identifies itself to third parties [verified]

- **Email.** Approved sends build MIME with no `From` header (`rt/connectors/google.ts:191-208`), so Gmail stamps the owner's own account [inference: standard Gmail API behaviour]. Nothing marks Waldo as the author. The owner approves the exact bytes by digest.
- **Web.** No `User-Agent` is set anywhere in runtime source; the browser provider's default is used.
- **Third-party messaging.** `send_message` reaches only the owner's own channels (report 05 UC-4).

### Payments [verified]

- No Stripe, billing, subscription, invoice, StoreKit or RevenueCat code in backend runtime, contracts, SQL or the app (grep: zero product matches). `subscription_tier` appears only in a contracts test fixture (`ct/runtime/invocation.test.ts:97`).
- "Spend" code is Waldo's own browser-cost ceiling, not owner payments.
- `browse_act` stops before pay, purchase or checkout steps (`browser.ts:173`). Ruling 14 / D10: no purchases until spend limits exist.
- This is consistent with the site's "Free while it's in beta" (WP-118, not yet in the ledger) [report 01].
- **Level 0, by design for the beta.**

### Industry bar [inference]

- Consumer agents ship OAuth sign-in (Apple or Google) with refresh tokens and an age gate at sign-up. Agent-payment rails (for example Google's AP2, Stripe's agentic tooling) are emerging, and no beta peer in report 02 documents purchases.
- Waldo's invite-gated OTP is sound for an alpha. The 12 h no-refresh session and the missing Google sign-in are the visible gaps.

### Three biggest gaps

1. No Google sign-in and no 18+ box at sign-up (both owner rulings).
2. The session expires in 12 h with no refresh.
3. No self-identification to third parties (mail goes out as the owner with no marker) and no Trusted Relationship runtime. Payments are absent by design.

### Minimal NL demo

- A new tester taps "Continue with Google", ticks "I'm 18 or older", and lands in Main chat; the next day they are still signed in.
- **Needs:** O2 Google (security review first), the 18+ checkbox wired to the contract, a refresh route or a longer session.

---

## P8. Evals and observability

### Tracing [verified]

- **Langfuse.** One OTLP trace per turn, generations with tokens and USD cost, plus content-free context-size metadata per model call (`rt/observability/otlp-turns.ts:58-60,104-115,215-216`; `docs/ops/OBSERVABILITY.md:16-22,68-75`). It is active only when the three `LANGFUSE_*` secrets are set [unverified on staging; the memory note implies it is live].
- **Text capture.** `resolveCaptureText` requires `LANGFUSE_CAPTURE_TEXT === 'true'` and a `WALDO_ENVIRONMENT` that is not `production` (`rt/observability/trace-privacy.ts:62-66`), re-applied in the exporter (`otlp-turns.ts:60`). Production sets `"false"` and `"production"` (`wrangler.jsonc:20`); staging sets `"true"` (`:84`).
  - Caveat [inference]: the guard trusts `WALDO_ENVIRONMENT`. A production deploy mislabelled as staging would capture text.
- **DO `trace_log`.** Hop, ok, duration, a 200-character note, model, tokens, cost and bytes, with the newest 500 rows kept. It stores no message text (`rt/channels/harness.ts:62-91`).
- **Worker logs.** JSON hop lines with text stripped (`DO:1615`). Invocation logs and Cloudflare traces are off (`wrangler.jsonc:8-11`).

### Metrics and alerts [verified]

- A per-owner cost ledger and usage rollups exist (`harness.ts:85-89,120-134`).
- **No alert sink** (grep for PagerDuty, Sentry, Opsgenie, Slack hooks: zero). Nobody is paged when owner turns fail, the alarm wedges or the retention cron misses.

### Evals [verified]

- **`packages/runtime/evals/run.ts`.** A W7 runner with 46 held-out cases (`evals/cases.ts:12`): voice, tools, memory, planning, clinical, proactive fetch, MCP, and prompt injection over mail, web and MCP. Exact tool checks plus a model judge.
  - **The judge is the agent's own model:** `JUDGE = WALDO_CHAT_MODEL` (`run.ts:30`), so the model grades itself.
  - It drives `createTelegramResponder` (`run.ts:6`), so **app-path quality is never measured**.
  - It needs a live key (`run.ts:23-24`) and has no package script.
- **The native benchmark** (`evals/waldo-native-suite.ts:1-2,9-10`): 36 cases (W01–W24, R25–R36) that are explicitly "development specifications, not executable trials". "None of the 36 original cases has run" (`scenarios/README.md:3`).
- **CI** (`.github/workflows/verify.yml:49-74,107-109`): typecheck, guards, pgTAP, sharded runtime tests, and the scenario config, which runs in plain node with a **scripted gateway in place of the live model** (`vitest.scenarios.config.ts:3-4`). It also tests the grading machinery (outcome grader, provenance, usage reconciliation). No model-graded eval runs in CI. Stryker mutation configs exist (`stryker*.config.mjs`) but no CI job runs them. A grep over all four workflow files finds no `evals/`, `stryker` or `test:mutation`.
- **`owner-do-smoke.yml`.** An opt-in, manually dispatched live-model read smoke. It pins actions by tag (`actions/checkout@v4`, `pnpm/action-setup@v4`, lines 18-22), not by SHA, which breaks security-checklist invariant 5 (`verify.yml` pins by SHA).
- **L3's "no `tools/eval` suite"** is right about the merge gate and wrong if read as "no evals exist".

### Industry bar [inference]

- Langfuse-style tracing with cost and context bytes is at the bar.
- The eval bar is a CI-gated regression suite on the primary surface, with a judge from a different model family, calibrated against human labels, plus alerting on production error rates. Report 04 §3.6 already proposes Waldo-specific bars.

### Three biggest gaps

1. No eval in CI, and none on the app path.
2. A self-judging, same-model judge; the 36 native cases have never run.
3. No alerting.

### Minimal NL demo

- A pull request changes the system prompt → CI runs the app-path eval (for example the reminder, injection and clinical cases) against a scripted world with a different judge model → the merge is blocked when "remind me at 5" stops calling `set_reminder` with the owner's zone.
- **Needs:** an app-path harness (report 04 §3.6 plumbing); a judge from a different family; a CI job with a scoped secret; a stored baseline.

---

## Five findings that most change the picture

1. **The canonical engine is not the one running.** WaldoCoordinator and RunLoopDO (19 test files) sit behind an unset flag with a fake executor. The owner DO carries all traffic, and its engine is *safe but not resumable*: approved effects are idempotent and read back, but an interrupted turn ends `interrupted / effects_unconfirmed` and is never resumed or cancellable [verified].
2. **A live data-loss defect sits on the only live path.** `commit()` writes at `count ?? 0` (`canonical-owner-store.ts:150-153,172-175`). #1080 is an open draft. The 02:41Z send that is our only level-5 evidence is also the send that overwrote a row [verified code; reported incident].
3. **App-only owners are second-class in every engine.**
   - No browsing: Telegram-subject admission; the tool is offered and then rejected.
   - No skills (Telegram-only host).
   - Nothing arms at sign-in; heartbeat and Prep are absent.
   - Reminders fire in UTC unless the zone was set by hand (the automatic write is inert at the pin), or unless a staging secret sets `WALDO_OWNER_TIMEZONE` [unverified].
   - Delivery needs a first chat message, and nothing pushes or polls.
4. **Proactivity is clock-only.** No mail, calendar or health-change trigger exists on the owner path. The `fetch_alert` triage lives only in the unreachable RunLoopDO and TracerDO. Peers (Muse, OpenClaw) react to events or heartbeats with model-decided silence.
5. **Evals exist but don't gate anything.** A real 46-case model-graded runner exists, but it is manual, judges itself with the same model and drives the Telegram responder only. The 36-case native benchmark has never run, and there is no alerting. Tracing and production text-capture discipline are solid.

## Not verified

- Every Worker secret on staging: Browserbase, Brave, speech-to-text, Langfuse, `RESPONSIBILITY_PUBLIC_API_ENABLED`, `WALDO_EVENT_SOURCES`, `WALDO_OWNER_TIMEZONE`.
- No test or eval was run. Pass claims come from file names and reading, not execution.
- The app-reminder duplicate window after a crash (P1) and the "browse_page dominates" latency source (P2) are inferences.
- PRs #1076, #1078 and #1079, and L3's local branches, were not read. #1066 was read only as a diff of the arming hunks.
- I read report 05's claims about Prep, update cards and WhatsApp internals, and spot-checked them only where cited as [verified].
