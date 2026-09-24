# Live verification checklist (2026-09-24) - living doc

Rule: nothing counts as DONE on tests-only evidence. Every slice below lists its deploy state and the exact live repro that closes it. Update this file in the same commit whenever a slice ships or verifies.

Staging worker: https://waldo-runtime-staging.piyushfulper3210.workers.dev
Owner Telegram id: 5458446350. Supabase project: togdshayyxycitzckpqv.

## Deploy state tracker

| Commit | Slice | Pushed | Deployed to staging | Live-verified |
|---|---|---|---|---|
| 74228de | connect_service tool | yes | unknown (pending ship.sh) | no |
| dfbcdc5 | web_search (Brave) | yes | unknown | no |
| 481b879 | B1 per-browser sessions | yes | unknown | no |
| c1b9cc5 | session list + sign-out-everywhere | yes | unknown | no |
| 807220f | L2 setup checklist | yes | unknown | no |
| b9a4174 | connect button pattern (URL never in model text) | yes | unknown | no |
| 240214a | Claude: consent rework (PKCE, single-use state, result pages, trace hops) | yes | Claude said it deploys directly - UNCONFIRMED | no |
| b10544c | L3 handoff approvals in-dash | yes | unknown | no |
| 47ccbbf | L7 usage surface | yes | unknown | no |
| 7c9403d | L6 account deletion | yes | unknown | no |
| dec8f2e | browser tool spec (doc only) | yes | n/a | n/a |
| 5c35c98 | B-tool-1 browse_page (read-only) | yes | unknown | no |
| 66ab045 | B-tool-2 browse_act (bounded actions) | yes | unknown | no |
| 29a7da3 | get_communication live Gmail handler (BUILD_ORDER 10) | yes | unknown | no |
| (this commit) | B-tool-3 approval-bound browser submit | yes | unknown | no |

One ship.sh run covers every pending lane commit. After ANY deploy, record the deployed version id here and flip the column.

## Live verification steps (run in order after deploy)

1. CONNECT LINK AS BUTTON: ask the bot "give me google connector link". Expect: a Telegram message with an inline "Connect Google" URL button, NOT a pasted URL in text. Evidence: screenshot/verbatim of the button message.
2. CONSENT END TO END: tap the button, approve consent. Expect: "Google connected" page with a back-to-chat button (not a blank screen, not "link expired"). Then a waldo.connections row exists (names/flags only, never tokens). Evidence: page screenshot + connection row.
3. CALENDAR FROM REAL DATA: ask "what's on my calendar tomorrow?". Expect: real events. Evidence: verbatim answer.
4. FAILURE HONESTY: repeat an expired/used consent link. Expect: failure page naming the real reason class (state expired/invalid vs exchange failure), not a generic "expired". Evidence: screenshot.
5. CONNECTED STATE: after consent, ask "give me google connector link" again. Expect: "Google is already connected." and NO new button. Evidence: verbatim reply.
6. WEB SEARCH: ask a question needing current public info. Expect: an answer sourced from the web (external taint intact). Evidence: verbatim answer.
7. SESSIONS: /console, open the link on two browsers. Expect: both work; the console session row says "on 2 browsers"; redeeming a second link on the same browser keeps ONE session. Sign out everywhere kills both. Evidence: console screenshot + both browsers signed out.
8. SETUP CHECKLIST: open /console. Expect: checklist reflects reality (Telegram Done, Google Done after step 2, Gmail per scope, quiet hours per settings). Evidence: screenshot.
9. APPROVALS IN-DASH: trigger a calendar proposal in chat ("move my gym to 7am tomorrow" if it proposes), then act from the console Waiting-on-you section. Expect: Do it applies to the real calendar; Not now leaves it; Undo within 10 min reverts; deciding in one channel makes the other say "already handled". Evidence: calendar state + console notice.
10. USAGE: open the Usage section after some chat. Expect: per-model rows with calls/tokens/cost and a total, matching /usage in Telegram. Evidence: screenshot.
11. VOICE NOTES: already live-verified 7:30 PM (two voice notes transcribed + answered). No action.
12. TRACE HOPS: after the consent flow, check logs for oauth_callback / proxy_exchange / google_linked hops with metadata only (no codes, tokens, or full URLs). Evidence: log excerpt.

13. ACCOUNT DELETION: in /console danger zone, confirm Delete account. Expect: telegram signs out ("This account has been deleted"), waldo.owner row gone, all connections and vault secrets gone (waldo.connections empty for the owner, vault secrets for the owner's connection ids deleted), DO storage wiped. Deleted-means-deleted probe: a new telegram message from the same owner starts FRESH onboarding (no prior state). Evidence: console notice + post-delete chat behavior + empty connections.

14. BROWSE PAGE: ask the bot to read a live public page that defeats snippets (e.g. "browse https://example.com and tell me the heading"). Expect: answer from the real rendered page. Then a failure case: browse a dead URL - expect an honest transient error, not a fabricated answer. Requires BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID in staging secrets (Mac-side wrangler secret put). Evidence: verbatim answers + trace hop.
14b. BROWSE ACT: ask the bot to do a small multi-step read on a public page (e.g. "browse the Hacker News front page, open the comments on the top story, and summarise them"). Expect: actions taken listed, page summary, and on any submit/pay/send-shaped step an honest "stopped before <action>" instead of doing it. Evidence: verbatim reply + Activity/ledger rows per browser_action.
14c. GMAIL READ: after Google consent (step 2), ask "any new email?". Expect: real inbox messages with from/subject/snippet/time. Before consent: honest auth_failed with a connect BUTTON, never a pasted URL. Evidence: verbatim answers.
14d. APPROVAL-BOUND SUBMIT: on a harmless irreversible-ish flow (e.g. a demo shop checkout), let browse_act reach the final step. Expect: a Telegram card "Approve this browser action? <action> on <url> (<binding>)" with Do it / Not now, NOTHING acted before approval. On Do it: the executor re-reads the page and completes only if the binding still matches. Tamper test: change the cart between proposal and approval - expect "I did NOT do it - the page changed". Evidence: card screenshot + both outcomes + ledger rows.
15. MULTI-USER ROUTING (BUILD_ORDER item 5 - already built, needs live proof): from a SECOND telegram account, message the bot with no link code - expect silence (no owner DO woken). Then /start <code> with a fresh code from the invited user's console - expect "Linked." and routing to that user's own DO. Evidence: both transcripts.

## Slices assessed as covered by existing surfaces (no new code needed)

- L4 patrol log: the console Activity section already renders the real trace log (what Waldo did, per hop, with failures) and the approval ledger; spots/constellation sections show what it noticed with provenance. L3 added approvals as their own acting surface. Live verification of L4 = steps 8-9 above confirming real rows appear.
- L5 memory read + correct/forget: console spots section has Confirm/Dismiss/Forget wired to real memory mutations (spot.confirm/dismiss/forget, node.forget actions). Live verification: confirm a spot in-console, watch its facet change; forget one, watch it disappear and stay gone.

## Still building (not in this checklist until shipped)

- B-tool-2/3: bounded observe/act actions, then approval-bound submit (spec signed off).

### S1 - egress guard + history scrub + console sign-in hop (CONNECT_FLOW_DESIGN slice 1)
Built: deterministic narrow-scope redaction of secret-bearing URLs (Google OAuth, first-party /c/<ticket>, /oauth/*/callback, state=/code=/code_challenge= URLs) at three seams: (1) every sendMessage/editMessageText leaving the DO (egressGuardedCaller wraps the gated caller, logs hop 'egress_redacted' with count only), (2) every conversation-store save (never persists), (3) one-time history scrub migration gated on storage flag 'scrub:v1' (hop 'egress_scrub'). console-auth sendCode now returns boolean; console-signin logs 'console_signin' hop on silent not-allowed (no email in logs). Tests: 10 egress-guard + scrub + store-write adversarial tests green.
- [ ] LIVE: after next deploy, send a model-authored message mentioning an old-style Google URL and confirm it arrives as [link removed] and the trace shows egress_redacted
- [ ] LIVE: confirm the scrub migration fires once on first turn after deploy (trace hop egress_scrub) and stored history no longer contains the corrupted 20:28 consent URL

### BUILD_ORDER 12 - connector contract + tool outputs in context composer
12a: tier-2 auth_failed-with-link is the written connector contract (AUTH_DECISION_SPEC addendum) pinned by connector-contract.test.ts. 12b: tool outputs now flow into the context composer - conversation/tool-output-ledger.ts (per-owner ring of the last 6 outputs, 500-char summaries), telegram-turn records each tool event and flushes with the conversation save, the local composer stages them as tool_result sources (provenance + per-fragment taint, 6-fragment cap, scribe rewrite allowed), prompt renders a <recent-tool-results> section. Pinned ctx_ hash updated.
- [ ] LIVE: after next deploy, run two turns where the first calls a tool; confirm the second turn's composed prompt shows the first tool's output (trace/prompt inspection)
