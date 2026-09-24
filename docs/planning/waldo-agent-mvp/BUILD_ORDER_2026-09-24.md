# Build order - finalized 2026-09-24 7:42 PM (owner ask: exact order, executor per slice)

Executor key: CLAUDE = code slices on the Mac (gates, commit, push, ship.sh deploy) under a bounded lane spec, lane reviews the diff before redeploy. LANE = specs, review verdicts, docs, adversarial-test requirements, in-sandbox gate re-verification. Every code slice: gates green -> commit -> push -> ls-remote -> ship.sh staging -> live repro -> report.

## NOW (tonight)
1. [CLAUDE] Finish Google consent proof end to end (consent -> grant exists -> calendar question from real data). Connector-proxy is deployed + signature-verified; vault-pulled HMAC set.
2. [CLAUDE] connect_service slice per the bounded spec (connect-intent bug, hard gate). Live repro: "Give me google connector link" -> real link. LANE reviews diff before deploy.

## NEXT (auth + console seam, unlocks the dashboard)
3. [CLAUDE] B1 minted dashboard link (auth spec decision 2): DO mints single-use 10-min token, worker redeems via grant-console, cookies set, 303 to /console. Adversarial: replay, expiry, cross-person, unlinked mint, double-redeem-on-one-browser = ONE session (refresh-not-stack, 0628a12).
4. [CLAUDE] Session list + sign-out-everywhere (grant version bump) + email OTP polish.
5. [CLAUDE] Multi-user telegram routing for invited users (presence routing on for invites; stranger gating holds).

## THEN (dashboard build-out from spec v2.1, visual verification against Figma, not "close enough")
6. [CLAUDE] P0 shell: greeting + setup checklist, briefs + handoff card + protected day plan. Exit: owner opens /console from a minted link and sees today's brief with real data.
7. [CLAUDE] P1: memory explorer (spots + constellations), patrol activity log, insight card. NO health card (his call).
8. [CLAUDE] P2 trust mutations: handoff approvals in-dash, memory correct/forget, quiet hours, autonomy, scoped + granular deletion, account deletion (delete_owner RPC + adversarial deleted-means-deleted probe).
9. [CLAUDE] Usage + cost surface.

## TOOL SURFACE (fills the thin live-tool roster)
10. [CLAUDE] Gmail fetch as the get_communication live handler (google client 'mail' infra exists).
11. [CLAUDE] web_search live tool (Brave key staged + terminal-verified).
12. [CLAUDE] Tool outputs into the context composer; tier-2 auth_failed-with-link becomes the written connector contract + contract test.

## BRIDGE (when Ashish's review lands; 9 decisions locked)
13. K1+B1 pairing (kennel lane K1 public pairing API + CLAUDE backend /devices/pair+redeem+WSS+heartbeat). Then the 6-phase interleave per WALDO_KENNEL_BRIDGE_2026-09-24.md, machine context S1-S8 per MACHINE_CONTEXT_LAYER_2026-09-24.md.

## LATER / BLOCKED
- Phone OTP: BLOCKED on SMS-provider + Indian DLT decision. Not beta.
- Tier-3 proactive connect suggestions: after B1 (rides minted links + suspend/resume).
- Meta/WhatsApp business verification, Discord, Maps: deferred by owner.
- Memory-MCP public surface, AppleScript governed job class: later layers, named not scoped.
- Housekeeping rulings still open: Langfuse text retention, DO token fallback, stated-vs-inferred migration framing, six eval-finding rulings, gpt-5-mini enablement.

## LANE responsibilities end to end (mine, no Mac needed)
Specs for every slice above, diff review before every redeploy, docs, adversarial-test design + mutation-proof requirements, in-sandbox gate re-verification on every push, live-repro criteria, bug-log discipline (every bug gets adversarial test + checklist line + bug-log row in the same commit).

## Access truth (verified 7:42 PM against the live tool surface)
- LANE -> Mac: NO direct access exists. No SSH/Tailscale/remote-exec capability in my tool surface - verified, not assumed. Codespaces being dead (Pin4sf billing 402) does NOT break the chain: the lane never executed on the Mac; Claude does.
- What the lane can do directly: github tool (repo inspect/update), full sandbox clone with gates runnable, all docs/specs, review.
- What only the Mac can do: ship.sh staging deploys, supabase functions deploy/secrets, wrangler secret pushes, anything reading his local env. All via Claude.
- If direct lane->Mac access is ever wanted, it needs an always-on reachability layer on the Mac (Tailscale + SSH, or a Kennel-side command ingress - which is literally bridge K6). Not needed for the current chain.
