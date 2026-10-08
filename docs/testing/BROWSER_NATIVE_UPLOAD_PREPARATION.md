# Native browser serving actions and files

The existing TelegramOwnerDO serving composition now consumes commonBrowserHost actions through ownerBrowserRuntime. Cloudflare is explicitly selectable; Browserbase remains an explicitly selected alternative. No provider failure selects Browserbase automatically. No live provider/model calls, credentials, migration application, registration update or deployment is implied by this source change.

## Ordinary owner journey

The real two-argument ownerDO test uses the actual dispatcher, owner runtime, common host, native driver, approval desk/effect ledger and workspace store/metadata. Only external boundaries are faked. A first turn reads public A, types into an observed input, reobserves A without reloading the value, and opens B. An explicit session_handle on the second turn switches to A, proposes an exact owner workspace file and saves a native screenshot. The real owner approval callback selects the file once; duplicate callbacks cannot repeat selection. The workspace screenshot export matches the stored PNG bytes and SHA. Cancel then a new task proves fresh allocation and exact cleanup. Fake provider transport cannot establish Cloudflare compatibility.

The command contract adds open_tab, switch_tab, close_tab, screenshot and upload. Existing native reference actions support type/fill, click, pixel scroll, goto, read/inspect and cancel. Legacy synthetic hosts refuse the new commands before resolving/proposing. The old fresh-session executor refuses both continuation and commonBrowser proposals before a Browserbase request.

## Approval and files

Upload proposals bind current owner/session, native observation revision, action digest and immutable workspace file identity/revision/name/MIME/size/SHA. The existing desk renders the facts; oversized review is review-only. Native setInputFiles executes only after a matching current owner approval, original grant, unchanged live document and exact workspace export. The driver copies the descriptor and bytes, hashes actual bytes, reobserves the input and verifies the selected native FileList. Durable claimed/uncertain state prevents replay.

Selection returns acknowledged_unverified: FileList SHA/size/name/MIME proves selection, not upload transmission, website acceptance or task completion. Arbitrary POST and native form submission remain refused by the original GET/HEAD egress guard; this slice does not add general approved website sends. Screenshot receipts use existing authenticated owner workspace retrieval, with actual PNG and metadata readback. Telegram inline photo delivery is not claimed.

## Retention and loss

The trusted serving owner runtime enables a dedicated native context created with serviceWorkers:block. The installed Cloudflare Playwright1.3.6 creates it with CDP disposeOnDetach:true. It stays connected across explicitly admitted owner turns under the original paid session/grant deadline. HTTP routes stay installed; idle operations lack authority, non-GET/HEAD requests and WebSockets are blocked. Turn finish clears model attachments and active run authority without renewing the grant or budget. Unrelated runs keep ordinary model accounting; admitted continuation calls use the original browser allocation and metered physical ordinals.

Explicit cleanup closes the context before disconnect and terminates the exact paid session independently. Actual detach disposes the dedicated context; page/form state is not durable across Worker eviction. A disconnected cached driver returns session_lost for old refs. Explicit recovery can create a fresh disposable context in the same paid session and reports previous_document_lost/document_state:recreated. Pending approval cannot reconstruct a replacement browser or adopt changed facts.

The application checkpoint cap is128KiB of UTF-8 JSON, with1KiB reserved before observation/proposal publication. Oversize clears stale action eligibility and returns observation_oversize. Cancellation discards observations/pending evidence before writing cleanup intent. Maintenance snapshots the native KV iterator before asynchronous cleanup. These are application bounds, not provider quota claims.

## Local native proof

Run from packages/runtime, using existing installed local paths:

```sh
pnpm exec tsx test/fixtures/general-browser-session-probe.mjs /path/to/playwright-core /path/to/local/chrome
```

The fresh-profile loopback fixture blocks external DNS and has a60s watchdog. Its receipt proves real CDP disconnect/reconnect, native upload bytes, two tabs/input retention, text/PNG, stale ref and authority rejection, a disposable context across owner turns, idle POST blocking, actual CDP detach disposing documents, lost refs and fresh same-paid-session recovery. It independently verifies local Chrome process exit/absence. Latest receipt: connections14; screenshot bytes15154/15346/15937. Local Playwright-core1.57.0 is not Cloudflare1.3.6 compatibility acceptance. No private login, CAPTCHA or cloud provider call occurs.

## Staging acceptance (parent-controlled)

1. Pin the reviewed exact source head, preserve the frozen deployment until the parent releases it, and reconcile the existing staging grant/account allowance. Do not create keys, change limits, enable a cohort or migrate data as part of acceptance.
2. With one approved staging owner and public synthetic site, explicitly select Cloudflare. Run the first-turn read/type/read/two-tab journey and a second turn using the returned owner-local session_handle. Verify useful page text and observed values, not just transport200.
3. Save screenshot and retrieve it as that authenticated owner; check actual PNG bytes/size/SHA and refuse a different owner.
4. Propose a bounded synthetic owner workspace file. Before approval, prove no selection; after approval, verify native selected bytes once and truthful acknowledged_unverified. Replay, changed revision/target, denied/expired approval and cross-owner requests must select nothing.
5. Withdraw authority, stop and expire the session. Verify exact provider session absence within the original prepaid cleanup allowance. Simulate disconnect/eviction: stale refs/approval fail; explicit fresh document recovery must neither retain old form state nor allocate a paid alternative.
6. Separately test explicit Browserbase only if its existing allowance is authorized. Cloudflare failures including402 must remain bounded typed failures with no paid switch. Denied content/timeouts are failed acceptance; provider transport success is not task completion.

Provider detection timing on abrupt Worker loss and actual deployed Cloudflare adapter behavior remain unverified until this bounded acceptance. Private encrypted Vault/human login/live-view and native download source exist separately but remain dark/unaccepted; see BROWSER_PRIVATE_INTEGRATION_STATUS.md. They are not complete serving browser claims.

Primary provider references: [Cloudflare Playwright](https://developers.cloudflare.com/browser-run/playwright/), [session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/), [guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/), [CDP context lifecycle](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-createBrowserContext), [Playwright input files](https://playwright.dev/docs/api/class-locator#locator-set-input-files), and [Browserbase contexts](https://docs.browserbase.com/platform/browser/core-features/contexts). Installed Cloudflare SDK evidence is lib/playwright-core/src/server/chromium/crBrowser.js (disposeOnDetach:true), types/protocol.d.ts and Target.disposeBrowserContext. No instantaneous Worker-loss disposal timing is assumed.
