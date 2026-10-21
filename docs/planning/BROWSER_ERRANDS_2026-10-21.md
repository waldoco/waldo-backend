# Browser errands: logged-in errands behind a flag, and the bake-off that picks the engine

21 October 2026. This note goes with the PR that adds `channels/browser-errand.ts`, `channels/browser-login-handoff.ts`, `channels/browser-use-errand-engine.ts`, the checkpoint contract `@waldo/contracts` `runtime/browser-errand.ts`, and `evals/browser-errand-bakeoff/`. Nothing here is wired into the owner object, a model tool or a Worker binding, and nothing is switched on in any environment.

Sources read first: `tools/live/browser.ts`, `channels/browser-task-continuity.ts`, `channels/approvals.ts`, `channels/owner-effect-ledger.ts`, `channels/browser-state-custody.ts`, `channels/native-browser-handoff.ts`, `channels/browser-handoff-console.ts` and contracts `runtime/browser-session.ts` at `f1bd5d09`, plus the build plan sections "Browsing", "Browser Use: where it fits" and "Non-OAuth sign-in".

## Where the engine sits

The code has no `BrowserProvider` interface. The name appears only in `cloudflareBrowserProviderReadiness`. The browser seams that exist are:

- `BrowserExecutor` and `BrowserSessionBoundary` in contracts (`issue` and `recover` per command);
- `BrowserTaskDriver` in `browser-task-continuity.ts` (inspect, fill and submit on one page).

Both seams are page-level, and the task host is fixed to `mode: 'public'` with no stored login. A hosted agent works one level up: it takes a task and returns a result, and it cannot honestly supply a page state digest. So errands get their own errand-level seam, `BrowserErrandEngine`, rather than widening the public task host. The engine's operations:

| Operation | What it does | Who decides success |
|---|---|---|
| `prepare` | Runs to the final review screen, stops before the final step, and holds the browser for `holdSeconds`. Returns the review URL and the facts on that screen, or a structured block. | Nobody. It produces a card. |
| `submit` | Runs one narrow step in the held browser: the approved final action. | Nobody. It starts a run. |
| `findSubmit`, `run` | Read back a submit run. | Nobody. `vendorClaim` is the agent's own report and is never used. |
| `verify` | A separate read-only look at the account for the declared postconditions. | The seam compares what it observed with `expected`. |
| `release`, `fence` | Stop the held browser. `fence` also ends the engine session, so nothing queued or in flight can start afterwards. | Not applicable. |
| `login.start`, `login.confirm` | Live view for the owner, then one read of the signed-in account. | The seam's state machine. |

The engine is a worker behind an approval and never the authority. `browserErrand(...)` plugs into the approval desk's existing hooks: `browserSubmit`, `browserReconcile`, `browserDeny` and `browserReceiptVerified`. `OwnerEffectLedger` stays the one retry owner. The test "runs through the approval desk and effect ledger" drives that path.

### Which engine submits

`executeBrowserSubmit` (Stagehand on Browserbase) opens a fresh session with no login, so it cannot submit inside a Browser Use profile. The engine that prepared a logged-in errand must also do its submit. "Stagehand stays the guarded path for final submits" is therefore implemented as `submitAdopted(errandType)`: an allowlist of errand types the bake-off adopted, empty by default. A Browser Use submit for any other type is refused, and the held browser is closed. Every non-adopted type stays on the existing Stagehand path end to end. A Stagehand errand engine behind the same seam is not built (see Follow-ups).

## The errand flow

1. **Plan.** The model plans the errand. The host builds a `BrowserErrandPlan` with type, origin, goal, final action, `expected` postconditions and a verify check. `healthAdjacent` comes from ingress classification; a health-adjacent errand is refused before any engine call.
2. **Browse to the review screen.** The host admits `prepare`, and the seam saves a `preparing` checkpoint before the engine call. The engine stops on the review screen. A review on another origin is refused.
3. **Hold the session.** The checkpoint moves to `awaiting_approval` with `holdExpiresAt = now + holdSeconds`. The card's `approvalExpiresAt` is set to the hold minus a two-minute submit margin. The desk already caps a browser card at `min(created + 30 min, approvalExpiresAt)`.
4. **Approval card with exact details.** The card is a `BrowserSubmitProposal` carrying the review facts as `binding`, the final action and a `continuation` holding errand id, proposal id and scope digest. Vendor ids never appear in it (tested).
5. **Submit once.** The submit is refused if the proposal id, scope digest, URL or facts digest differ from the stored review, if the approval expired, if the type is not adopted, or if the host does not re-admit. Otherwise the seam saves `submitting` before the request leaves, then saves the run reference as soon as it returns.
6. **Verify.** When the run has finished, the seam runs a separate read-only check of the account. The errand reaches `verified` only if every `expected` key matches, compared trimmed and case-insensitive. The receipt is bound to the review facts digest. The desk promotes the approval to done only through `receiptVerified`. The agent's success report never decides this: an engine that claims success while the account shows otherwise ends `acknowledged_unverified` (tested in the seam, the adapter and the bake-off).
7. **Receipt.** `verified_with_receipt` carries the confirmation id, or a digest of the observed facts when the site shows no confirmation number. Then the browser is released.

### Crash windows and duplicate approvals

| Point of failure | State on disk | What happens next |
|---|---|---|
| Before the submit request | `awaiting_approval` | The approval can be decided again; nothing was sent. |
| After the request, before its run reference was saved | `submitting` with no run reference | The seam fences the engine session so nothing more can start, then lists the session's runs. One unknown run means it follows that run. No run means `not_applied`. A failed listing means `unknown`. It never re-posts. |
| After the run reference was saved, before verify | `submitted` | The next approval or reconcile follows that run, then verifies. |
| Run still going | `submitted` | Reported as still running; the alarm or the next reconcile checks again. |
| Duplicate or concurrent approval | Any of the above | The per-errand mutex orders the calls. Every later call reads back. The tests show one engine submit across concurrent approvals, a replay after success, and a restart. |

An approval that times out is closed by `sweep` from the owner object's alarm, or by the late approval itself. Either way the held, signed-in browser is stopped and nothing is submitted. The desk's own `expireDue` does not call `browserDeny`, so the seam owns this cleanup. If the engine says the held browser is gone, the errand returns to `ready` and needs a fresh review and a new card. An old approval never carries over.

## Login handoff

`browser-login-handoff.ts` is a small state machine:

- **States:** `requested`, then `owner_in_control`, then `owner_done`, then one confirmation, ending in `signed_in` or `failed`.
- **Exits:** `expired` and `cancelled` can be reached from any state that is not terminal.
- **Late completion:** a completion after the deadline expires the handoff instead of reviving it.

While the state is `requested` or `owner_in_control`, no engine run, page read or screenshot happens. The agent's browser is released before the live view opens, and the seam refuses `prepare` (tested). After the owner hands back control, the seam does three things:

1. It clears the live-view link from custody.
2. It makes one read confirming the intended account.
3. It sets the errand to `ready` for a fresh review.

Credentials never pass through Waldo. The owner types them into the vendor's live view. v1 sends no `secretBindings`, since they would put the owner's password in a vendor job payload. Codes and magic links are never pasted into chat or read from the inbox (build plan, "Non-OAuth sign-in").

`liveView` returns the link only to its caller, which will be the authenticated console route. Today's console page (`browser-handoff-console.ts`) pins `frame-src https://live.browser.run`. Showing a Browser Use live view needs that route extended with `https://live.browser-use.com`, the host documented at docs.browser-use.com/cloud/browser/live-preview.md.

Vendor-side recording is outside Waldo's control unless the project has zero data retention. The adapter does not request recording.

## Session custody

- **Where references live.** Vendor session, run, profile and live-view references are kept only in the checkpoint's `custody` field, in DO storage. Cards, outcomes, the `view()` projection and logs are built from the other fields. A test asserts that none of those references appear in any of them.
- **Live-view links.** They are cleared as soon as the owner hands back control or the errand ends.
- **Failed browser stops.** A stop that fails keeps its reference so the next `sweep` retries it.
- **Logs.** Only a fixed event name and the engine are logged.
- **Profiles.** v1 uses one Browser Use profile per owner, as the vendor advises (docs.browser-use.com/cloud/guides/authentication.md). Its id is supplied by the host and never shown to the model.
- **Saved logins.** `browser-state-custody.ts`, the encrypted storage-state blob, stays as it is. It becomes relevant when Waldo drives its own browser.

## Structured blocks

`prepare` returns `{ status: 'blocked', blocked: 'challenge' | 'login_required' | 'js_required' }`.

- **Where the reason comes from.** It is a field in the engine's structured output, validated by Zod. Free text that does not parse is reported as a failure, never as a guessed block (tested).
- **What gets released.** Only `login_required` keeps the browser, for the handoff. The other two release it.
- **How the model sees it.** Exposing these outcomes in a model tool is for the tool owners (harness-prompt); this PR registers no tool.

## Vendor facts (checked 21 October 2026, primary sources)

**Browser Use Cloud API v4.** Base URL `https://api.browser-use.com/api/v4`, header `X-Browser-Use-API-Key` (docs.browser-use.com/cloud/api-v4-overview.md). The endpoints come from the embedded OpenAPI spec at docs.browser-use.com/cloud/openapi/v4.json.

- **Runs, not tasks:**
  - `POST /runs` takes `task`, `outputSchema`, `model`, `sessionId`, `keepAlive`, `browserSettings` (`profileId`, `proxyCountryCode`), `maxCostUsd`, `secretBindings` and `judge`. It accepts no unknown fields.
  - Other endpoints: `GET /runs/{id}/status`, `GET /runs/{id}`, `GET /runs?sessionId=`, `POST /runs/{id}/cancel`, and `DELETE /sessions/{id}`, which cancels the in-flight run and queued messages.
  - There is no `isSuccess`. The docs say the agent-reported outcome must be verified independently (docs.browser-use.com/.well-known/llms-full.txt).
- **keepAlive:** 120 to 14,400 seconds, never past the browser's 4-hour lifetime. Free-tier and ZDR projects always get 120 seconds, so holding a browser across a card needs a paid project.
  - A follow-up after the hold ends gets a fresh browser with the same profile and no tabs.
  - A client timeout does not cancel the server-side run.
  - Source: create-run.md.
- **No idempotency key on `POST /runs`.** Reconcile therefore lists the session's runs after fencing it. The queue endpoint's `X-V4-Queue-Deduplicate` header has no documented meaning, so it is not used.
- **Zero data retention: contradictory.** Create Run lists a 403 for "Zero Data Retention is enabled on the project (V4 unsupported)", while other pages describe ZDR behaviour on V4. Treat V4 with ZDR as unavailable until Browser Use confirms. Health-adjacent errands stay refused.
- **Profiles:** they hold cookies, local storage and login state. State is saved when the browser stops. Use one profile per end user (authentication.md).
- **Live view:** on `live.browser-use.com` (live-preview.md).
- **secretBindings:** per run. The agent cannot read the values, and domain checks apply to the focused field's frame, not to navigation (guides/secrets.md). Not used in v1.
- **Pricing:**
  - Browser time is $0.02 an hour, billed per minute.
  - Residential proxy is $5/GB; a direct connection or your own proxy is $0.20/GB.
  - Tokens cost the model rate plus 20%.
  - Sources: browser-use.com/pricing, guides/billing.md.
  - The adapter turns the proxy off (`proxyCountryCode: null`) and reports cost from the vendor's `totalCostUsd`, `browserCost` and `proxyCost`. A part the vendor does not report stays null and fails adoption; it is never estimated.

**Browserbase and Stagehand.**

- **Sessions:** timeout 60 to 21,600 seconds; `keepAlive` is a boolean.
- **Contexts:** persist only with `persist: true`.
- **Recording:** on unless `recordSession` or `logSession` is false.
- **ZDR:** Enterprise only.
- **Developer plan:** $20 with 100 hours, then $0.12 an hour; 1 GB of proxy, then $12/GB.
- **Sources:** docs.browserbase.com/reference/api/create-a-session.md, .../keep-alive.md, .../contexts.md, account/billing/plans.md, account/enterprise/zero-data-retention.md.
- **Stagehand on npm:** `latest` is 4.3.0 (registry.npmjs.org/@browserbasehq/stagehand). v4 removes `agent()`. `act` `variables` (`%name%`) are not shared with the model (docs.stagehand.dev/v4/basics/act.md).
- **What the repo uses:** the hosted v3 HTTP API (`tools/live/browser.ts`), which is unchanged.

**Cloudflare Browser Run** (formerly Browser Rendering).

- **Limits on Workers Paid:** 200 concurrent browsers per account, 3 new browsers per second, 60-second default idle, `keep_alive` up to 20 minutes.
- **Cost:** 10 hours included, then $0.09 an hour.
- **Human in the loop:** `Cloudflare.handoff` waits at most 30 minutes, with the live view on `live.browser.run`.
- **Sources:** developers.cloudflare.com/browser-run/limits/, .../pricing/, .../features/human-in-the-loop/, .../features/live-view/.
- **Fit:** the 20-minute ceiling is shorter than a 30-minute card. That is why Browser Run stays the public-read tier, not the logged-in errand engine.

## Flag and configuration

`browserUseErrandEngineFromEnv(env)` returns an engine only when all three hold:

- `BROWSER_ERRANDS_ENGINE=browser_use_v4`;
- `BROWSER_USE_API_KEY` is set;
- `WALDO_ENVIRONMENT !== 'production'`.

The production refusal is in code and tested. Neither variable exists in any wrangler config, and the key would be a Worker secret, never a repo value. `.env.example` is not edited in this PR.

## Bake-off

`evals/browser-errand-bakeoff/` contains three parts:

- **`specs.ts`:** 20 errand types across cancellations, bookings, forms, refunds, a bill dispute and account changes.
- **`runner.ts`:** drives the real seam and scores the results.
- **`live.ts`:** the operator entry point.

**What `runErrand` measures:**

- **Verified completion:** an account oracle independent of both engines shows every expected value.
- **Minutes.**
- **All-in cost:** model, browser and proxy.
- **Owner takeovers:** login handoffs.
- **Unapproved submits:** the account changed before the card was approved, or changed without a submit.
- **False verifications:** Waldo said done but the oracle disagrees.

**Adoption rule per errand type and engine (`scoreBakeoff`).** All of these must hold:

- at least 5 runs;
- at least 80% verified completion;
- zero unapproved submits;
- zero false verifications;
- cost fully reported and $0.20 or less per errand.

Anything else stays on Stagehand.

**Tests (CI, fakes only)** include an engine that commits before approval and one that over-reports success. Both fail adoption.

**Live runs** need `BAKEOFF_LIVE=1`, `BAKEOFF_SPEND_CAP_USD` (at most $50), a `bu_` key and a local targets file. They stop before a run that could pass the cap, and stop if a run's cost was not fully reported. The operator acts as the oracle and types what the test account shows. Nothing was run against a paid service.

## Follow-ups (not in this PR)

1. **Wiring.** Construct `browserErrand` per errand in the owner object (store, alarm `sweep`, desk hooks). Add the Browser Use live-view host to the console handoff route. Register an errand tool, with tool owners harness-prompt and harness-turn.
2. **Stagehand errand engine.** Put Stagehand behind `BrowserErrandEngine` so the bake-off can compare both engines on the same tasks. Today the harness accepts any engine, but only Browser Use is implemented.
3. **Oracles.** Write a per-site oracle for each errand type the owner picks: a sandbox API, a mailbox receipt, or the operator.

## Rollback

Revert the PR. No migration, binding, secret or route is added. No caller constructs these modules outside tests, so reverting changes no runtime behaviour.
