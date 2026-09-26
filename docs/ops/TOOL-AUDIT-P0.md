# Waldo staging tool audit (P0) — code / configured / live

Scope: every shipped tool. Statuses are separate by design (#177): CODE = handler exists and is wired at beta-mvp 2754a6c; CONFIGURED = required bindings/secrets present on staging per the dated setup record; LIVE = verified end-to-end on staging with receipts.

## Matrix

| Tool | Code (file) | Configured on staging | Live status |
|---|---|---|---|
| get_context | src/context-composer + live/get-context.ts | none extra | LIVE PASS 2026-09-25 (`tg-904957543`, called inside reminder turn) |
| set_reminder (DO alarm) | scheduler + DO alarm | none extra | LIVE PASS 2026-09-25 (`tg-904957543`, alarm fired at the wall-clock minute) |
| web_search (Brave) | live/web-search.ts | BRAVE key set 2026-09-24 | LIVE PASS 2026-09-25 (`tg-904957544`, official docs URL returned) |
| query_calendar | live/google.ts:63 → connectors/google.ts:185 | Google client ID/secret on worker (2026-09-24); consent = calendar first | NOT LIVE-PROVEN (#177: connect route passes, no grant made then; owner may have connected since - unverified) |
| get_communication (Gmail read) | live/google.ts:76 → connectors/google.ts:212 (metadata headers + snippet only) | gmail.readonly scope in combined consent | NOT LIVE-PROVEN; KNOWN BREAK fixed in #208 (populated batch overflow dropped ALL tool results) |
| get_tasks | live/google.ts:87 → connectors/google.ts:223 | tasks scope in combined consent | NOT LIVE-PROVEN |
| propose_calendar_change | live/google.ts:99 → effect desk approval card | none extra | CODE + tests green; console Waiting-on-you queue NOT YET EXERCISED live |
| draft_email | live/google.ts:109 → gmail drafts.create | gmail.compose scope | CODE + tests green; live unproven |
| send_email (approval rail) | live/google.ts:130; canonicalized MIME + sha256 digest + Message-ID reconciliation; oversize-card typed error | gmail.send scope | CODE + 40+ tests green (#202 approvals suite); live unproven |
| connect_service (connect link) | live/google.ts:190; telegram-owner-do.ts:602 mints link | - | LIVE ROUTE PASS (chooser). PRIVACY NOTE: on beta-mvp the minted link is still `/c/<ticket>` (ticket in path); the `/c/?t=` mint + path rejection ship with #202 (awaiting owner merge) |
| read_tool_output | read-tool-output.ts (paginates stored large outputs, 4,000-char slices) | - | CODE + tests; live unproven |
| browse_page / browse_act | live/browser.ts | browser backend binding | CODE; live unproven |
| search_episodes (recall) | live/search-episodes.ts + Vectorize waldo-recall | Vectorize bound on staging | CODE; live unproven |
| MCP tools | live/mcp.ts | none configured | CODE skeleton; issue #195 open (breadth via MCP) |
| Approval card truth | effect desk + approvals.ts (atomic claim, claim-release-on-pre-I/O-throw - on #202 pending merge) | Telegram bot token + owner id set | Console Waiting-on-you NOT EXERCISED live; card delivery + console list must be probed together |

Known live-affecting defects already filed: #161 (Telegram reply bricked by unrenderable history), #149 (model offers capabilities it lacks), #146 (dispatcher fixed-size truncation - mitigated by read_tool_output, still open), #150/E1 (OTP quarantine - quarantineMailItem live in code), #172 (owner timezone at onboarding).

## Fresh live probe pack (synthetic, non-private; run by owner or Mac lane - this lane holds no Telegram webhook secret, per the secrets setup record)

Send each from the owner Telegram chat; capture `tg-<update_id>` hop logs (wrangler tail) + Langfuse trace id per turn:

1. "what's on my calendar today" → query_calendar populated PASS (proves Google grant live)
2. "any new email?" → get_communication populated PASS (the #208 regression case)
3. "what are my open tasks" → get_tasks PASS
4. "put a test event 'probe' tomorrow 1-2pm" → propose_calendar_change card; approve from CONSOLE Waiting-on-you; verify event created; then cancel it the same way
5. "draft an email to myself, subject probe, body probe" → draft_email; verify in Gmail Drafts
6. "send an email to myself, subject probe, body probe" → send_email card; approve; verify in Sent (Message-ID reconciliation)
7. "search the web for the Cloudflare Workers docs" → web_search PASS
8. "connect google" (fresh owner account or after disconnect) → connect link minted; AFTER #202 merges the link must be `/c/?t=` form

Langfuse receipt verification: traces carry WALDO_RELEASE (commit SHA) - each probe trace must name the deployed SHA. This lane can verify receipts via the Langfuse dashboard (vault-fill Google SSO) once probes run.

## Fixes landed in this audit
- #208 @ 86299bb (base beta-mvp 2754a6c): per-item scribe degrade for tool turns + explicit omission receipts - the populated-Google-result break. #204 aggregate guard untouched. CI pending at write time.

## Queued (not worked, per owner pause): internal-taint hardening; redaction-registry/URL-scrubber ports; sentinel egress proxy design.
## Approved-in-parallel (bounded): #204 per-result dispatcher-derived provenance for tool_turns - next PR.
