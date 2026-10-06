# Cloudflare public-page read slice

Base: beta-mvp `6f0648f292344d4d251cd30f5a176975f47ca42c`. Source, fake runtime and local bundle proof only; no provider/model calls, publication or deployment performed by this lane. Parent owns publication timing, deployment and the coordinated $1 staging test allowance.

## Serving behavior

An ordinary `browse_page` task selects `cloudflare_playwright` or `browserbase_stagehand_http_v3`. Production and ordinary library callers preserve the existing Browserbase default. The reviewed staging entrypoint registers the pinned Cloudflare SDK before Worker requests and registered two-argument DO construction; its trusted configuration selects Cloudflare by default. Missing Cloudflare setup returns a typed failure. Failure never selects Browserbase automatically. Existing configured Browserbase keys are required for explicit Browserbase requests; trusted handler policy can disable that provider independently of model arguments.

The only `telegram-owner-do.ts` changes are the configuration import and the existing `browsePageHandler` composition call. No owner-turn, curated-host, console-signin, fixture authority, credential, grant or migration change is included. The existing public-read ACL, finite egress policy, source custody and canonical run admission apply. The model cannot provide owner/session identifiers, loader, binding, egress roster or provider permissions.

Cloudflare uses the already pinned `@cloudflare/playwright` 1.3.6 and existing guard options. One invocation owns one dedicated acquired session and isolated public context; it never loads/restores owner login state. Connect uses the supported direct binding plus exact session ID, with the pinned runtime's persistent option. There is no fresh allocation fallback during reconnect/cleanup. The adapter returns observed final URL, title and body text, marked external for the existing dispatcher. It returns source/read/navigation/empty/cleanup failures without raw provider error bodies. Provider HTTP diagnostics retain only status and bounded code/request ID; 402 does not infer billing cause or authorize payments, retries or provider switching.

Loading a page is transport, not task completion. A nonempty HTTP200 challenge page can still be unusable; no speculative text classifier declares it successful research. The serving model must judge relevance from observed page evidence, and staging acceptance requires useful content rather than a challenge/timeout/access-denial receipt.

## Egress and lifecycle

Provider guardrails latch the initial hostname. Every GET resource is vetted against the existing public egress policy; service workers and non-GET requests are blocked. `route.fetch(maxRedirects:0)` prevents automatic redirect-chain bypasses. Top-level same-host redirects are followed by separate source-admitted, vetted navigations within the same private session. The [documented Playwright maximum of20redirects](https://playwright.dev/docs/api/class-route#route-fetch-option-max-redirects), verified in the pinned request implementation, is retained for manual chains; a non-advancing host clock cannot create an unbounded loop. Credential-bearing/private-port/cross-host redirects and redirect loops are denied before following. Subresource redirects and cross-host resources remain unsupported in this slice. This may make some sites incomplete; it does not justify automatically expanding egress or switching to a paid provider.

The canonical run deadline bounds work; the existing browser extraction timeout supplies a30second upper bound when shorter run deadlines are absent. Navigation/DOM operations use10second timeouts. Cleanup gets an independent10second deadline and does not require live source permission. These are operation deadlines, not new grants or provider billing caps. Allocation identity can be unknown if transport is lost; idle keepalive is10seconds but cannot prove physical closure or enforce a dollar ceiling.

The adapter closes its isolated context, sends physical `Browser.close`, reads provider sessions for exact-ID absence, and disconnects. A lost acknowledgement is acceptable only when absence is independently observed. Failed absence readback means cleanup is unknown and no successful read is reported. Context damage does not skip physical termination. Hooks currently project a clone of native AbortSignal which fails native getter access in Workers; this adapter uses the surviving canonical `runScope.admit()` capability/deadline and source checks, without editing shared registry code.

Public one-shot state is deliberately ephemeral. A Worker crash may leave a provider session until provider expiry; this slice does not provide durable public-read reconstruction or authenticated reuse. Existing fixture continuity and encrypted owner/environment/origin/account/generation custody are preserved for subsequent browser work.

## Reviewed staging configuration

Only `env.staging` adds:

```json
{
  "main": "src/staging-browser.ts",
  "compatibility_flags": ["nodejs_compat"],
  "browser": { "binding": "BROWSER" }
}
```

Top-level production config/entrypoint and finite staging egress hosts are unchanged. No plan, cap, payment, key, private login, broad OPEN_PUBLIC permission or production activation is included. `scripts/deploy-runtime.sh --env staging` forwards the selected environment to Wrangler and stamps `WALDO_RELEASE` from the clean committed head; Wrangler selects the staging main from that environment. No deploy script changes are required.

Authorization receipt supplied by parent: on2026-10-06 at09:23:31UTC the assistant asked to add staging BROWSER+Node compatibility, then enable public-page reading after review/tests, within$1 and without paid-plan/production change (message `Sentinel_70437b26d7088191b4353082a0bbc6ab`). At09:24:08UTC the owner answered “yes you can” (message `Sentinel_efff2c1904a08191816d320f1a11e1a9`). This authorizes the reviewable source/config change; parent retains deployment/live-test coordination and serial CI publication clearance after#839/#859.

## Verified provider documentation (2026-10-06)

- [Cloudflare Playwright](https://developers.cloudflare.com/browser-run/playwright/): native Node filesystem support needs `nodejs_compat` and compatibility date>=2025-09-15; current2026-06-16 date qualifies. `launch.close()` terminates; connected browser `close()` disconnects. The pinned SDK source/probe verifies direct binding connection uses the exact retained ID, without acquiring another session.
- [Cloudflare limits](https://developers.cloudflare.com/browser-run/limits/): idle timeout defaults60seconds and can reach600000ms; no fixed active-session lifetime, and releases can close sessions. Idle keepalive consumes browser time, so it is not a hard budget.
- [Cloudflare storage state](https://developers.cloudflare.com/browser-run/playwright/#storage-state) documents cookies/localStorage/IndexedDB (`indexedDB:true`). [Playwright session storage](https://playwright.dev/docs/auth#session-storage) is separate. None is enabled by this public slice; future sign-in persistence requires appropriately encrypted owner-scoped custody and approved credential/grant flows.
- [Cloudflare FAQ](https://developers.cloudflare.com/browser-run/faq/) documents bot-identifiable traffic and no per-request IP rotation. Protected-site success is unproved. [Live View](https://developers.cloudflare.com/browser-run/features/live-view/) is supported but not integrated here; its bearer URLs require owner-bound custody. [Download issue93](https://github.com/cloudflare/playwright/issues/93) is a follow-up investigation, not proof of universal inability.
- [Browserbase keepalive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive) and [session creation](https://docs.browserbase.com/reference/api/create-a-session) have different lifecycle/paid-plan rules; the existing hosted Stagehandv3 public handler remains selectable. [Cloudflare Stagehand](https://developers.cloudflare.com/browser-run/stagehand/) supports v2.5, so its endpoint cannot replace the hosted Stagehandv3 base. No provider parity claim is made.

## Evidence and acceptance

Local fake tests cover selected-provider routing/no fallback, missing setup, denied paid provider, finite/private/credential/port/subresource egress, manual redirect validation, source withdrawal, known-ID cleanup after allocation/connect/extraction failure, malformed IDs, HTTP403/429/500, timeout/empty content, unknown cleanup, bounded402 metadata, concurrent owners and actual pinned-SDK request serialization. The actual ordinary two-argument ownerDO test runs inbox→source custody→browse_page→synthetic menu text→model tool output with one fake allocation/physical close, no fixture grants and external fetch denied.

Bundle tests run Wrangler dry-run plus Miniflare. The actual staging entrypoint loads the SDK/registers the provider and preserves the default Worker/all DO class exports. A registered two-arg DO is constructed. The default production bundle remains SDK-free and starts under its unchanged compatibility. Local startup is not Cloudflare upload acceptance. These tests are included in `verify:guards`; browser Node/fake tests run in the existing continuity gate.

The Linux-only pgTAP guard cannot bootstrap on this macOS executor (`/etc/os-release`/`dpkg` missing). The complete Supabase/CI wall and real provider journey remain pending; no database reset/migration was performed. Final test counts and exact reviewed head are in the lane handoff/PR body.

After parent clears review/serial publication and stages the exact head, Core should run one public synthetic menu-like target already on the finite egress list through the real Telegram host. Verify health/release/version/traffic and BROWSER binding first without credential exposure. Request Cloudflare explicitly (or rely on staged trusted default), require actual final URL and useful quoted menu evidence, and read back exact session absence. Use one bounded browser/model allowance within$1; stop on denial/timeouts/challenge content, exhausted allowance or unknown cleanup. Negative controls: missing binding, finite off-roster URL, source withdrawal and explicit Browserbase denied/unconfigured. None may launch a paid fallback. HTTP200 provider transport or a challenge page cannot pass acceptance.

Rollback: parent reverts the three staging Wrangler additions (ordinary index/compatibility/no browser binding) and deploys the prior exact staging release. Production remains excluded. Later slices own reusable/disconnected sessions, crash recovery, encrypted sign-in state, owner Live View, screenshot delivery and proven download retrieval; no credentials, CAPTCHA solving or private account login are authorized here.
