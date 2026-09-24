# Auth, account, and connection authorization - engineering decision spec (2026-09-24)

Builds on the product-level spec (DASHBOARD_SPEC_V2 section 4) and names what we actually build, against what is already shipped. Owner call 5:15 PM: "spec it properly - best, scalable, secure, trusted; external service allowed."

## What already exists (do not rebuild)

- **Console web sign-in**: invite-gated Supabase EMAIL OTP, working today (identity/console-auth.ts + channels/console-signin.ts). Verify returns the person's DO name; two cookies minted: a DO grant cookie (12h, HttpOnly, SameSite=Strict) and a signed owner-routing cookie.
- **Directory**: owner-directory.ts routes provider+subject (e.g. telegram:5458446350) to the person's DO via signed RPC (route_presence). The runtime holds NO service-role key (ADR-0052) - publishable key + HMAC-signed functions only.
- **Channel linking**: one-time link codes (SHA-256 hashed at rest) redeem a channel identity onto a person. Telegram stranger-gating already runs on it.
- **Token custody**: Supabase Vault; connector-proxy is the only code that touches bearer tokens (owner hard line). Runtime/DO/model never see them.
- **Schema**: waldo.owners / presences / invites / link_codes with RLS forced, proven on the owner's live project today.

## Decision 1 - identity and web sessions

**Recommendation: launch beta on EMAIL OTP (built) + channel-minted dashboard links; add PHONE OTP as soon as an India-capable SMS provider is chosen - not before.**

The product spec says phone OTP primary. The engineering reality: Supabase phone OTP requires an external SMS provider (Twilio / MessageBird / Vonage). For Indian numbers this means DLT-registered templates - a multi-day external gate, per-SMS cost, and a new vendor relationship. Meanwhile: (a) everyone in the invited beta starts on a channel, where transport-verified sender identity IS the session (his confirmed call); (b) web entry for channel users is the minted dashboard link (Decision 2), which needs no SMS at all; (c) email OTP is already shipped and free. Phone OTP then serves exactly one cohort: web-first users with no channel yet. That cohort does not exist in the invited beta - so SMS must not gate D1.

Open owner call: SMS provider choice (Twilio is the Supabase-default path; Indian DLT registration is the long pole - start it alongside Meta verification if he wants phone OTP live for public launch).

## Decision 2 - channel-minted dashboard session links (the manage-everything-from-one-place mechanism)

Waldo messages a short-lived, single-use link ("open my dashboard", under any brief). Mechanics, all extensions of shipped primitives:

1. The person's DO mints a random 128-bit token, stores SHA-256(token) + expiry (10 min) + single-use flag in its own SQLite.
2. Link: `https://<worker>/console/mint/<token>` (GET; safe because single-use + short-lived; robots noindex, never logged with the token).
3. The worker redeems via the existing grant-console DO call, atomically spends the token, sets the same two cookies as email sign-in, 303s to /console.
4. Channel identity binds the mint: only a message from a routed presence (provider+subject verified by the transport) can mint for that person's DO.

Session semantics (owner question 7:38 PM, answered in the spec): the 10-minute lifetime belongs to the LINK (the door key), not the session. Redeeming a link SETS the session cookies (12h). Asking Waldo for the dashboard 5 times in a day mints 5 links - spent/expired ones die - but redemption on a browser that already holds a live session REFRESHES that session instead of stacking a new one. Sessions are per browser/device, never per link: 5 links, 1 session. The console session list shows browsers/devices; sign-out-everywhere (grant version bump) kills all of them at once.

No new auth vendor. Adversarial tests: replay of a spent token, expired token, token for another person, mint requested from an unlinked chat.

## Decision 3 - connection authorization: keep connector-proxy, defer Nango

The v2 product spec recommends Nango for the integration catalog. The engineering tension: our custody hard line (tokens only in Vault, touched only by connector-proxy) is SHIPPED and live-proven; Nango moves token custody to a third party and re-opens the token-path audit for zero beta-phase benefit - the beta needs Google (built) and a handful more.

**Recommendation: keep connector-proxy as the token spine; add providers by hand (each is a small slice: consent scopes + proxy route + live tools). Revisit Nango when the catalog demand is real (>5 providers) or enterprise SSO/team phase starts.** If he wants the catalog sooner, that is his explicit override of the custody design, and the spec for it is a separate document.

## Decision 4 - account management surface (thin web app, his 5:15 list)

Preferences, scope, scoped + granular data deletion, account deletion, trusted people + vault, file pages. All of it rides the existing session (cookies above) + signed RPC pattern (ADR-0052). Deletion semantics follow the fundamentals: real deletes, disclosed retention notes. Account deletion = new signed RPC `delete_owner` that wipes the person's rows (owners, presences, claims, episodes) and destroys the DO storage - one slice with pgTAP + an adversarial "deleted means deleted" probe.

## Session security invariants (checklist additions)

- Cookies: HttpOnly, Secure, SameSite=Strict, 12h, Path=/console; minted tokens single-use, 10-min expiry, stored hashed.
- Sign-out-everywhere = DO grant version bump (invalidates all outstanding grant cookies for that person); session list lives in the DO.
- Channel unlinks already drop all outbound to unlinked chats (shipped W2.5); relinking requires a fresh one-time code.
- No service-role key in the runtime, ever; new auth RPCs follow the signed-function pattern with pgTAP coverage.

## D1 build slices (in order, each gated + live-verified)

1. Minted dashboard link (DO mint + worker redeem + cookies) - exit: owner taps a link in Telegram, lands signed-in on /console; spent-token replay rejected.
2. Presence-based multi-user telegram routing ON for invited users (invite create/revoke already built) - exit: a second telegram account links via code, gets its own DO, stranger without code still gated.
3. Email OTP polish + session list + sign-out-everywhere - exit: two browsers signed in, one click kills both.
4. Phone OTP - BLOCKED on SMS provider decision + DLT; not D1 unless he rules otherwise.

## Addendum 7:34 PM - connect-intent tiers (owner direction, his iMessage)

His vision: connecting a service should be seamless at every distance from the ask. Three tiers, ascending:

**Tier 1 - reactive (IN FLIGHT, the connect_service slice):** the owner asks to connect / link / set up a service, or asks why Waldo can't see their calendar/email -> connect_service answers deterministically with the real link or "already connected". Scales across future services by construction: each connector registers name + state-check + connectUrl with the connector registry, and the tool's service enum extends per connector.

**Tier 2 - graceful (EXISTS for Google; make it the universal connector CONTRACT):** any service tool called while unconnected returns the real connect link in its auth_failed error (the google.ts withGoogle pattern). Today this is per-connector convention; the connector-authoring standard makes it a written contract with a contract test, so every future connector gets it for free and no tool can ever answer an unconnected call with a shrug.

**Tier 3 - proactive (ROADMAP, after B1):** Waldo notices a request would go materially better with an unconnected service and volunteers the suggestion with a one-tap deep link - inline in chat, or into the dashboard - and after consent completes, the original task resumes with its context intact (Codex-app-style). Rides: the connect_service connection-state machinery, the B1 minted dashboard link for the one-tap surface, and the run-loop's existing suspend/resume for continue-where-we-were. Manners are part of the spec: gated by proactivity settings, suggest-once-per-service cooling window unless the owner asks, never interrupts a flow to sell a connection.

Not in the current slice: tiers 2-as-contract and 3 are follow-on slices; the connect_service spec stays bounded.


## Addendum 11:12 PM - tier-2 is now the written connector contract (BUILD_ORDER 12)

Tier 2 graduated from convention to contract. The rule, binding on every current and future service tool:

1. A service tool called while its service is unconnected MUST return `{ ok: false, code: 'auth_failed', error }` - never a shrug, never fabricated data.
2. When the channel can deliver buttons, the error MUST say the connect button was sent; the consent URL travels ONLY through the deliver channel as a button. Model-visible text NEVER contains the URL (belt: the S1 egress guard also strips it if a bug ever puts it there).
3. A provider 403 (scope not granted) maps to the same auth_failed-with-link path - consent adds the scope to the same account.
4. connect_service (tier 1) and pure proposal tools (propose_calendar_change, which only writes to the approval desk) are exempt by design.

Enforcement: packages/runtime/test/connector-contract.test.ts pins the tier-2 handler name list and asserts 1-3 for every entry. Adding a connector means adding its handlers to that pinned list in the same commit; a handler that skips the contract fails CI.
