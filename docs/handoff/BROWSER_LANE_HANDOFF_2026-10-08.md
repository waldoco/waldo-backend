# Browser lane handoff (Core to Dalda), 2026-10-08

Owner decision (relayed 11:08): the entire browser lane moves end to end to Dalda. Core stops browser work after this note.
Status words: merged = on a base branch; live = deployed to staging; tested = ran in CI or on staging. Say which, every time.

## Open PRs / branches (all pushed, none merged, none live)
- #911 `feat/browser-public-web-20261008` head a3013fa6 (plus this doc): public-web grant. `allowedOrigins: ['*']` = any public http(s) page. Blocks private/loopback/link-local/metadata/CGNAT IPs, numeric and hex IP forms, IPv6 literals, single-label and .internal/.local/.localhost names, credentialed URLs, non-http(s). Tested: red-first `test/public-web-policy.test.ts` plus 61 browser tests, CI shards green. Base = common-mail-reads branch (#903 219eed5a).
- #908 `feat/common-browser-registration-20261008` head b13dffca: S0 gate and staging registration. Tested in CI (green). Not merged, not live. Needs a merge-forward of #903.
- Merged earlier on beta-mvp via #902 chain: common browser host and driver (see pointers).

## What exists (file pointers, packages/runtime/src)
- `channels/common-browser-host.ts`: `browse_page` handler (read-only: GET/HEAD, no login, no page writes, no submit), retained task session, 2 tabs, native image, grant validation (line ~30), `authorizeRequest` (~39), target check (~49), `driver.start` (~54).
- `channels/common-public-browser-configuration.ts`: staging policy, allocation/spend reservation, `freezePolicy` (~19, now accepts `'*'`).
- `channels/cloudflare-general-browser.ts`: Cloudflare Browser Rendering driver; `start(allowedDomains | 'public', ...)` (~198); public mode launches with no domain guardrail.
- `channels/public-web-policy.ts` (new in #911): `isPublicWebUrl`, `PUBLIC_WEB_ORIGIN`.
- `channels/cloudflare-browser-adapter.ts` `cloudflareBrowserGuardOptions` (finite domain guard, still used for finite grants).
- `s0-worker.ts`, `channels/s0-network-block.ts`, `wrangler.s0.jsonc` (on #908): S0 probe worker.
- Registration: the staging registration still supplies a FINITE origin list (the file that calls `configureCommonPublicBrowser`; see `common-staging-registration` on the #908 branch).
- Legacy browser path (49-handler legacy loop): `browser-owner-host.ts`, `browser-gate.ts`, `browser-site-custody.ts`, `browser-task-continuity.ts`. The common loop does not admit browse_act yet.

## Provenance of the finite allowlist
Introduced by build agents in 10e33930 / f59c42c7 (2026-10-07) from agent-written planning docs (docs/planning/DESIGN_DRAFTS_BROWSER_TRUSTED_MANIFEST_2026-10-02.md line 12; docs/implementation/cloudflare-public-read-handoff.md:57). No owner rule or ADR. Owner decision 10:39: ordinary public-web browsing.

## S0 recipe (never passed yet)
S0 never passed. The earlier 403 was Cloudflare error 1010 on a Python user-agent, not our code.
1. From the #908 branch: `wrangler deploy --config wrangler.s0.jsonc`
2. `GET /s0/ping` (booleans only), then authenticated `GET /s0/ready` -> `{ready:true,version:'s0-gate-v3'}`, then POST the S0 run. Failure reason is in the `x-waldo-s0` header; a thrown `runS0` returns 502 JSON.
3. Use a browser-like User-Agent from scripts.
Do not enable public mode or any paid/live provider call until S0 passes and ledger caps are wired.

## Caps and caveats
- Test spend cap $20 total; browser prepare-only with a $5/month cap. Owner: ask before exceeding.
- Price constants in #908 need re-verification against current Cloudflare pricing before any spend.
- Hostname checks cannot see DNS rebinding; Browser Rendering runs on Cloudflare's network, not ours.
- Staging and production share one Supabase project (owner confirmed intended).

## Gaps (feature progress)
1. Staging registration still finite; set the policy to `['*']` only after S0 passes.
2. No login/handoff, no `browse_act` in the common loop (common loop admits ~15 of ~70 tools).
3. No approval card for authenticated or consequential browser actions on the common path.
4. No live trace of `browse_page` on staging yet.
5. His owner chat still takes the legacy path because of his task-source row; the common browser is not reachable from his chat until that is cleared (Core is fixing the source gate).

## First complete journey (proposal)
"Open <public site>, read it, tell me X" from the owner's Telegram chat: Telegram turn -> common loop -> `browse_page` (no allowlist) -> screenshot and text -> correct answer. Acceptance: ordinary-user turn on staging, no error events, `http://169.254.169.254` refused, trace id in Langfuse. Then one login-handoff journey with an approval card before any submit. The travel/booking/shopping matrix comes after both.

## Test infra (separate from features)
S0 scripts and recipe above; trace script `/downloads/staging-trace-script-903-908-2026-10-08.md` (Core workspace); Cloudflare Workers observability (owner's logged-in browser) holds `$metadata.error`; Langfuse US project "Waldo Test Shivansh" holds hop traces.
