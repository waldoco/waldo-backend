# Browser tool slice spec (2026-09-24) - SPEC FIRST, no build until owner sign-off

Sequencing per owner: this spec is reported before any code. Builds on RUNTIME_BROWSER_RESEARCH.md (2026-09-20); currency re-verified 2026-09-24: the Stagehand v3 hosted HTTP API is still the documented path (official repo packages/server-v3/openapi.v3.yaml, v3.1.0; regional API endpoints documented). v4 SDK exists but is a browser-side runtime - NOT used.

## Decision (unchanged from research, re-verified)

Browserbase + Stagehand v3 hosted HTTP API, called with plain fetch from the Worker. No Node host, no new compute provider. Base https://api.stagehand.browserbase.com/v1. Endpoints: sessions/start, navigate, observe, extract, act, end.

## Tool surface (follows the web_search.ts pattern exactly)

- contracts: browserTaskArgsSchema (zod) + TOOL_PERMISSIONS entries per trigger type, same roster mechanics as web_search.
- tools/live/browser.ts: browserTaskHandler(apiKey, projectId, fetcher) - provider key and project id stay server-side env, NEVER in model-visible text (existing signed-URL invariant extends: Live View URLs and session ids are capabilities, structured channels only).
- Error discipline identical to web_search: 401/403 -> auth_failed, network/5xx -> transient, structured result with source_taint: 'external'.

## Bounded job model (adopted from research, matches Hermes provider separation)

1. Session per task: start -> navigate -> loop(observe -> validate -> act) -> extract -> end. Durable continuation record after each step (DO storage), so a lost session rebuilds from its Browserbase Context.
2. observe-before-act seam: act only on action objects returned by observe (selector + method + args validated against the task), never freeform autonomous browsing. No /execute-style autonomous path for exact-approval flows.
3. Timeout after act = uncertain external effect: inspect/reconcile, never blind retry.
4. Contexts: one Browserbase Context per (waldo user, site, account); writes serialized per context; sessions closed on completion/cancel; end-of-session persists login updates.

## Approval gate (hard security line, deterministic)

Research/form-filling can run bounded-autonomous. Final submit on bookings/messages/purchases requires exact owner approval bound to destination + content/items + price, re-read from the page immediately before execution. This is a deterministic reject line, not model judgment.

## Slices

- B-tool-1: session lifecycle + navigate/extract only (read-only info gathering). Proves the HTTP path, key custody, error mapping.
- B-tool-2: observe/act bounded actions with a per-task action cap and full action log to trace_log.
- B-tool-3: approval-bound submit flows (binds into the existing approvals channel from L3).

## Open-source benchmarking (standing directive)

- Stagehand (browserbase/stagehand, MIT): adopted observe/act/extract seam + hosted HTTP lifecycle. Diverge: no SDK dependency - raw fetch keeps the Worker dependency-free.
- browser-use cloud: comparable managed browser ($0.02/browser-hour V4 vs Browserbase $20/100h); Browserbase kept for Contexts + Live View maturity.
- Hermes: adopted driver/provider separation + session cleanup discipline.
- Cloudflare Browser Run: rejected for beta (bot-identified IPs, Stagehand guide pinned to v2.5.x, 60s inactivity timeout).

## Open unknowns flagged in research (still open)

- India latency: Browserbase APAC regions are enterprise-request only - measure before promising.
- Session-end login persistence timing (docs advise seconds before context reuse).
- Plan/session lifetime limits on the chosen tier.

## Testing plan (industry bar)

Contract tests with injected fetcher (same pattern as web-search): auth_failed on 401/403, transient on 5xx/network, schema validation, permissions roster entries. Adversarial: provider key and Live View URL never appear in model-visible output (grep-level invariant test like the connect button pattern); approval gate rejects submit without matching approval; action cap enforced; session always ended on task abort.
