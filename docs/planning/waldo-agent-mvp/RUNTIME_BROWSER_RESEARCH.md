# Waldo runtime, browser, and open-agent research

Checked 2026-09-20 against public primary documentation and official source repositories. Research lane only: no package installed, live browser workload tested, credentials read, or account changed. Working requirements supplied by parent: cloud execution with laptop off; API-first tools; managed browser fallback; reversible actions can run within a bounded request; messages, bookings, and purchases require exact approval; health-aware, app-first, India/iPhone invited beta. Dates, costs, and exact target sites remain unset.

## Provisional recommendation

**[Inference] Keep Waldo's own app/domain/runtime and buy the browser infrastructure. Start with Browserbase + its documented hosted Stagehand HTTP API as the browser implementation, behind a small Waldo browser interface; retain Cloudflare for orchestration and add Cloudflare Sandbox only when file/code tasks demand Linux. Do not put Cloudflare Computer, an entire Hermes install, or an entire OpenClaw gateway on the beta critical path.** This favors documented persistent login contexts and mobile takeover over optimizing cents per browser-hour. Cloudflare Browser Run remains a plausible simpler-vendor alternative if the selected beta sites and iPhone handoff pass the same proof; do not implement both before that decision. The hosted HTTP lifecycle is documented under v3; Stagehand also now documents a v4 SDK, so v3 must not be described as the latest SDK.

This recommendation is provisional because no representative-site test has occurred. It does not claim either managed provider achieves Instinct parity or universal website access.

## Browser and execution choices

| Candidate | Verified capabilities/status | Cost snapshot and choice-changing limitation |
|---|---|---|
| Cloudflare Browser Run | Formerly Browser Rendering. Managed headless Chrome; direct browser control through CDP, Puppeteer, Playwright. Live View/human takeover are documented and marked beta in navigation. | Workers Paid includes 10 browser hours/month, then $0.09/hour; 10 concurrent browsers averaged over daily peaks, then $2/additional average browser. Workers charges remain separate. [Overview](https://developers.cloudflare.com/browser-run/), [pricing](https://developers.cloudflare.com/browser-run/pricing/), [takeover](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/). |
| Browserbase + Stagehand | Managed browser infrastructure; Stagehand v3 combines natural-language observation/action/extraction with code. Browserbase Contexts preserve login data; Live View can be embedded on desktop/mobile and allows manual interaction. | Developer $20/month includes 100 browser hours, 25 concurrent sessions, 1GB proxies; overages $0.12/hour and $12/GB. Startup $99/month includes 500 hours, 100 concurrent, 5GB proxies; overages $0.10/hour and $10/GB. Model charges are extra. [Pricing](https://www.browserbase.com/pricing), [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts), [Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view), [Stagehand](https://docs.stagehand.dev/v3/first-steps/introduction). |
| Cloudflare Sandbox/Containers | GA infrastructure. Sandbox supplies command/file/process APIs over isolated Linux Containers. Current stable SDK and 1.0 preview coexist; Cloudflare currently recommends next for new projects. | Metered Containers resources plus Workers and Durable Objects, with optional logs. Do not budget as browser-hours. Pin one SDK/image release line together. [GA](https://blog.cloudflare.com/sandbox-ga/), [SDK](https://developers.cloudflare.com/sandbox/), [pricing components](https://developers.cloudflare.com/sandbox/platform/pricing/). |
| Cloudflare Computer | Durable Object SQLite filesystem with container, isolate-shell, and isolate-JavaScript backends. | Official README explicitly excludes production use at present: preview APIs/design are unstable. Its specification is forward-looking. Suitable for a later experiment, not a required beta dependency. [Official source](https://github.com/cloudflare/computer). |
| Browser Use Cloud | Material alternative: managed CDP browser, persistent profiles, live-view takeover, geolocated residential proxies; optional fully hosted agent. | Current V4 pricing page: $0.02/browser-hour plus $5/GB residential proxy (default) or $0.20/GB direct/own proxy; hosted agents add model cost +20%. Credits start at $5, initial concurrency 10. Older official V2 repository document says $0.05/hour; do not combine versioned prices. [Current pricing](https://browser-use.com/pricing), [browser capabilities](https://browser-use.com/stealth-browsers), [older V2 source](https://github.com/browser-use/browser-use/blob/main/CLOUD.md). |

### Integration traps that change the plan

- Cloudflare's current Stagehand guide explicitly supports **v2.5.x only**, excludes v3+, and its example requires Zod 3. Do not write “Cloudflare Browser Run + latest Stagehand” into the build plan as a verified combination. CDP support by itself does not prove that unsupported integration works. [Official compatibility guide](https://developers.cloudflare.com/browser-run/stagehand/).
- Browser Run requests are identified as bots by Cloudflare, originate from Cloudflare IP ranges, and cannot rotate IP per request. A third-party site's blocking behavior can determine whether it is viable. [FAQ](https://developers.cloudflare.com/browser-run/faq/).
- Browser Run has a 60-second default inactivity timeout, configurable to 10 minutes. Active sessions have no fixed lifetime but can close on releases. Paid defaults are 200 concurrent browser instances and 3 starts/second; these limits differ from included billing concurrency. [Limits](https://developers.cloudflare.com/browser-run/limits/).
- Browserbase saves Context changes when sessions close; docs advise waiting a few seconds before reuse, avoiding simultaneous sessions on one Context, and one Context per site/login. Contexts do not make website login expiry disappear. **[Inference]** Allocate by Waldo user + site + account and serialize writes to each Context. [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts).
- Browserbase pricing advertises Asia Pacific regions as enterprise-request only. **[Unknown]** Measure India-to-browser and iPhone takeover latency; do not promise Indian browser execution geography. [Pricing/regions FAQ](https://www.browserbase.com/pricing).
- Browserbase's pricing page has inconsistent retention text between plan cards and comparison table. Do not finalize retention assumptions from that page; inspect selected project configuration and vendor confirmation before copying it into a contract.

### Minimal browser action pattern

**[Inference]** Use bounded browser jobs returning structured results and artifacts. Keep the final submit separate from research/form preparation. Stagehand `observe()` returns action objects (selector, description, method, arguments) which can be validated before `act()`, and has placeholder handling for values; this is a useful implementation seam, not an automatic authority mechanism. [Observe API](https://docs.stagehand.dev/v3/references/observe), [Act API](https://docs.stagehand.dev/v3/references/act).

For bookings/messages/purchases, Waldo must bind approval to the displayed destination, content/items, price, and action, then re-read before execution. Do not rely solely on “stop before checkout” in an unrestricted autonomous browser prompt. For novel irreversible paths, hand the actual final step to the user until a bounded adapter is implemented. Keep authenticated sessions and provider secrets outside model-visible prompts. This is a small executor boundary, not a large governance program.

### Verified HTTP deployment path: no separate Node host required by the interface

The documented hosted base is `https://api.stagehand.browserbase.com/v1`. Its HTTP lifecycle is:

| Call | Purpose | Primary API evidence |
|---|---|---|
| `POST /sessions/start` | Create hosted session; return ID. Supports Browserbase creation parameters or an existing Browserbase session ID. Creation options include Context ID/persist, keepAlive, timeout and region. | [Start](https://docs.stagehand.dev/v3/api-reference/python/start-a-new-browser-session) |
| `POST /sessions/{id}/navigate` | Navigate to supplied URL. | [Navigate](https://docs.stagehand.dev/v3/api-reference/python/navigate-to-a-url) |
| `POST /sessions/{id}/observe` | Return available action objects, without executing those suggested actions. | [Observe](https://docs.stagehand.dev/v3/api-reference/python/observe-available-actions) |
| `POST /sessions/{id}/extract` | Return structured page information. | [Extract](https://docs.stagehand.dev/v3/api-reference/python/extract-data-from-the-page) |
| `POST /sessions/{id}/act` | Execute a predefined Action object or natural-language instruction. | [Act](https://docs.stagehand.dev/v3/api-reference/java/perform-an-action) |
| `POST /sessions/{id}/end` | Terminate session and release resources. | [End](https://docs.stagehand.dev/v3/api-reference/python/end-a-browser-session) |

**[Inference]** Existing Cloudflare Workers can call these standard HTTPS JSON endpoints with `fetch`; this path does not require running a Node browser driver or adding a second compute provider for Waldo's code. The vendor hosts execution. Provider key, project ID, and model key use API headers; keep these server-side, with only an authorized short-lived Live View handed to the app. Waldo must map user/site/account to Context ID and task to session ID; provider IDs are capabilities, not user-supplied authority. Browserbase Context is browser-login storage, not Waldo's profile memory. Use a durable continuation after each step, close sessions on completion/cancel, and rebuild from Context after loss. Test whether session ending persists required login updates and verify allowed plan/session lifetime.

**Boundary:** Observe/extract do not execute their returned suggestions, but loading a website can itself have site-defined effects. Waldo should use named bounded tool operations, action limits, and allowlisted supported flows rather than claiming arbitrary web navigation is intrinsically read-only. Do not expose the autonomous `/execute` path for exact-approval flows. A timeout after `act` is an uncertain external effect: inspect/reconcile, never blindly retry.

The API documentation remains under v3 while [current v4 documentation](https://docs.stagehand.dev/v4/first-steps/introduction) describes a browser-side runtime and different APIs. The [v4 deployment guide](https://docs.stagehand.dev/v4/best-practices/deployments) demonstrates a Node server deployment and marks Functions-with-Secrets preview. **[Unknown]** Exact version pinning/long-term support of the hosted HTTP endpoint and any v4 migration should be confirmed in the implementation spike. Do not mix those examples, silently assume v4 SDK works on Workers, or add Vercel solely to run browser control.

### Managed connector purchase decision

Nango supplies token storage/refresh and broken-connection notifications; preapproved OAuth apps help development, but its own guidance recommends a custom app before launch. Current pricing is Free (10 connections, 10 compute hours/month, 10GB) or $50/month PAYG with $50 credits; rates are $0.29/connection-month, $0.72/compute-hour, $0.50/GB. [Auth](https://nango.dev/platform/auth), [pricing](https://nango.dev/pricing).

Composio bundles per-user connected accounts, token refresh and tools; it supports custom scopes and OAuth apps. Its docs recommend own OAuth applications for production control and note shared quota in managed defaults. A managed connection does not automatically mean the Waldo brand/scopes are ready for launch. [Authentication](https://docs.composio.dev/docs/authentication), [custom auth](https://docs.composio.dev/docs/auth-configuration/custom-auth-configs).

**[Inference]** If launch integrations are Google Calendar plus a narrow Gmail surface and Waldo already has usable encrypted token custody/refresh, use direct typed Google adapters. Another proxy does not eliminate action design, exact approvals, dedupe, or Google app setup. If the repo lacks a viable connection layer and several providers are launch-critical, Nango is the smaller managed-auth purchase: buy auth/refresh, keep Waldo's typed domain tools. Composio is a stronger fit only if a broad ready-made tool catalog is explicitly needed now. Do not add both, or bring a generic tool router merely to avoid a few Google endpoints. This is conditional on the parent's repo audit; this lane has not established whether Waldo's existing OAuth path is sufficient.

## Hermes Agent: reuse its mechanics, not its whole personal installation

**Observed:** Hermes is an MIT-licensed self-hostable agent with a gateway for multiple chat platforms and scheduled jobs. The official repository describes cloud-hosted operation without a laptop dependency. [Official repository](https://github.com/NousResearch/hermes-agent).

**Observed memory mechanics:** Two small curated files (`MEMORY.md`, `USER.md`) are loaded as a frozen session-start snapshot; history is separately searchable through SQLite FTS5. Its feature documentation says session search returns actual messages; the repository's shorter overview still mentions LLM summarization, so treat that as a documentation discrepancy and consult pinned implementation before copying. Current memory docs also identify the cost/freshness problem with indefinitely growing chat sessions. Memory and skills writes can be staged for user approval. [Memory documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

**Observed skills:** On-demand procedural documents follow progressive disclosure and the Agent Skills standard. The agent can create and update procedures from successful workflows and corrections; human review can gate writes. [Skills source](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md).

**Observed routines/recovery:** Cron supports one-shot/recurring jobs, fresh sessions, skill attachments, event triggers, and script-only jobs with no LLM. Optional continuity brings prior substantive outputs forward while suppressing unchanged reports. Provider fallbacks are supported, and run, scheduler-handoff, and delivery errors have separate fields. These are useful distinct failure states. [Cron docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

**Observed browser:** Hermes separates the browser driver from provider; it can use cloud browsers rather than the user's local Chrome. It supports task sessions, inactivity cleanup and provider selection. [Browser docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser/).

**[Inference] Adopt:** compact user context + searchable history; reusable procedures loaded only when needed; scheduled jobs distinct from chat; deduped quiet monitoring; explicit run/delivery errors. **[Inference] Avoid for beta:** importing Hermes' home-directory model as Waldo's tenant storage, automatic skill self-modification from day one, or a separate framework gateway competing with the existing app identity/runtime. Hermes itself warns against two writers sharing one Hermes home; a hosted multi-user Waldo product needs stronger tenant design than a profile directory. No claim is made that the whole framework cannot be hosted; it simply introduces a migration/integration project beyond these reusable mechanics.

## OpenClaw: reuse continuity and delivery patterns

**Observed:** OpenClaw is an MIT self-hosted gateway spanning chat channels, models, sessions, web controls, and mobile nodes. Its docs describe a server deployment, so it need not depend on a user's laptop. [Overview](https://docs.openclaw.ai/).

**Observed memory:** It separates a compact user profile, curated long-term memory, dated working notes, and background consolidation. The docs explicitly distinguish memory from scheduled reminders and from enforcement of approval rules. [Memory overview](https://docs.openclaw.ai/concepts/memory).

**Observed scheduling:** Heartbeats and user-authored jobs share a persisted automation scheduler; the default heartbeat stays quiet when nothing requires attention. Explicit recurring work belongs in jobs rather than being inferred from old chats. [Heartbeat](https://docs.openclaw.ai/heartbeat), [automation](https://docs.openclaw.ai/automation).

**Observed recovery:** Background task records distinguish queued/running/succeeded/failed/timed_out/cancelled/lost and distinguish execution success from delivery failure. Durable run history informs recovery; retained session metadata alone is not treated as proof of live execution. [Tasks](https://docs.openclaw.ai/automation/tasks).

**Observed mobile/channel reality:** Its iPhone app connects to a gateway, supports opt-in Health summaries and a durable offline chat outbox with idempotent retries. These are product patterns to study, not a Waldo mobile implementation. Its WhatsApp integration uses linked WhatsApp Web through Baileys. Its usual iMessage integration depends on a signed-in macOS Messages host (remote gateway can SSH to that Mac). These are materially different from a cloud business messaging API. [iOS](https://docs.openclaw.ai/platforms/ios), [WhatsApp](https://docs.openclaw.ai/channels/whatsapp), [iMessage](https://docs.openclaw.ai/channels/imessage).

**[Inference] Adopt:** one app identity across channels; durable outbox; cancel/retry/resume visible to the user; completion delivery separate from execution; small curated memory; quiet scheduled monitoring. **[Inference] Defer:** whole gateway adoption and linked-device channels. They do not remove the work of Waldo's app, health contracts, tenant isolation, and exact-action approvals. Telegram is an easier later adapter; WhatsApp business APIs and a commercial iMessage path require separate feasibility checks.

## Small proof required before locking implementation

1. Test one real supported India-facing target, one login/MFA flow on iPhone, one long task that survives browser loss, and one prepare/approve/submit path. Record completion, latency, actual browser/proxy/model cost, and failure reasons.
2. Verify SDK/runtime compatibility in the intended Cloudflare deployment. Use one browser provider in that prototype; evaluate an alternative only if a choice-changing failure appears.
3. Kill the runner after an external submit and prove it reconciles the result instead of repeating the write. Revoke the connector and prove queued work stops using it.
4. Prove app reconnect retrieves final state, user cancellation stops execution, and notification failure does not turn successful work into a rerun.

No overall vendor-cost forecast is possible without task mix, duration, concurrency, proxy bytes, and model-token measurements. Browser infrastructure price alone is not task cost. No competitor parity, production reliability, or health-data suitability was tested by this note.
