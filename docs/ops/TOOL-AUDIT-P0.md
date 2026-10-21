# Waldo staging tool audit (P0) — code / configured / live

Scope: every shipped tool. Statuses are separate by design (#177): CODE = handler exists and is wired at beta-mvp 2754a6c; CONFIGURED = required bindings/secrets present on staging per the dated setup record; LIVE = verified end-to-end on staging with receipts. Google reads are split further, per owner review 2026-09-26: GRANT (staging consent completed), EMPTY-READ (typed empty result returned live), POPULATED-READ (owner-facing result with real provider data). Live statuses below are as of the dated turn IDs; re-check before relying.

## Matrix

| Tool | Code (file) | Configured on staging | Live status |
|---|---|---|---|
| get_context | src/context-composer + live/get-context.ts | none extra | LIVE PASS 2026-09-25 (`tg-904957543`, called inside reminder turn) |
| set_reminder (DO alarm) | scheduler + DO alarm | none extra | LIVE PASS 2026-09-25 (`tg-904957543`, alarm fired at the wall-clock minute) |
| web_search (Brave) | live/web-search.ts | BRAVE key set 2026-09-24 | LIVE PASS 2026-09-25 (`tg-904957544`, official docs URL returned) |
| query_calendar | live/google.ts:63 → connectors/google.ts:185 | GRANT: staging Google consent completed 2026-09-26 | EMPTY-READ LIVE PASS (`tg-904957557`, empty next-24h result). POPULATED-READ LIVE FAIL (`tg-904957561`, owner-facing failure). |
| get_communication (Gmail read) | live/google.ts:76 → connectors/google.ts:212 (metadata headers + snippet only) | GRANT: gmail.readonly scope in the completed consent | POPULATED-READ LIVE FAIL (`tg-904957573`, owner-facing). Live Langfuse evidence: `tool_get_communication` COMPLETED, then `llm_reply` failed `forbidden:scribe_sanitise` before send; the exact live Scribe reason was not exported. The batch-overflow break is a SOURCE/SYNTHETIC HYPOTHESIS (not yet distinguished live from other scribe-deny shapes); a post-fix live probe must confirm the actual mechanism. Candidate fix under review (see below); no live post-fix proof. |
| get_tasks | live/google.ts:87 → connectors/google.ts:223 | GRANT: tasks scope in the completed consent | LIVE FAIL on old release `2754a6c` (`tg-904957580`, `transient:invalid_handler_result` - error-path stamp defect in withGoogle's caught transient arm, Langfuse root in #177; fixed at #202 @ `dde1627`). Post-#202 live proof PENDING deploy. |
| propose_calendar_change | live/google.ts:99 → effect desk approval card | none extra | PARTIAL LIVE: Calendar proposal -> visible pending console state -> skip path exercised 2026-09-26 (see Approval card truth row). Still unproven: an APPROVED mutation with provider readback + delivery receipt. |
| draft_email | live/google.ts:109 → gmail drafts.create | gmail.compose scope in grant | CODE + tests green; live unproven |
| send_email (approval rail) | live/google.ts:130; canonicalized MIME + sha256 digest + Message-ID reconciliation; oversize-card typed error | gmail.send scope in grant | CODE + 40+ tests green (#202 approvals suite); live unproven |
| connect_service (connect link) | live/google.ts:190; telegram-owner-do.ts:602 mints link | - | LIVE ROUTE PASS (chooser). PRIVACY NOTE: on beta-mvp the minted link is still `/c/<ticket>` (ticket in path); the `/c/?t=` mint + path rejection ship with #202 (awaiting owner merge) |
| read_tool_output | read-tool-output.ts (paginates stored large outputs, 4,000-char slices) | - | CODE + tests; live unproven |
| browse_page / browse_act | live/browser.ts | browser backend binding | CODE; live unproven |
| search_episodes (recall) | live/search-episodes.ts + Vectorize waldo-recall | Vectorize bound on staging | CODE; live unproven |
| MCP tools | live/mcp.ts | none configured | CODE skeleton; issue #195 open (breadth via MCP) |
| Approval card truth | effect desk + approvals.ts (atomic claim, claim-release-on-pre-I/O-throw - on #202 pending merge) | Telegram bot token + owner id set | PARTIAL LIVE: a Calendar proposal -> visible pending console state -> skip path WAS exercised 2026-09-26. Missing proof: an APPROVED mutation with independent provider readback + channel delivery receipt. Probe approval and delivery together |

Known live-affecting defects already filed: #161 (Telegram reply bricked by unrenderable history - stays open until the step-9 live recovery receipt passes), #149 (model offers capabilities it lacks - two unresolved live paths: invalid Calendar args and disconnected-owner connect affordance; stays open until BOTH pass), #146 (dispatcher fixed-size truncation - mitigated by read_tool_output, still open), #150/E1 (OTP quarantine - quarantineMailItem live in code), #172 (owner timezone at onboarding).

## Fresh live probe pack (run by owner or Mac lane - this lane holds no Telegram webhook secret, per the secrets setup record)

Read probes 1-3 read the owner's REAL provider data; only the write probes (4-6) use synthetic content ("probe" subjects/bodies). Reports must stay content-free: counts, typed statuses, and receipt IDs only - never provider bodies, tokens, or ticket URLs. Capture `tg-<update_id>` hop logs (wrangler tail) + Langfuse trace id per turn:

1. "what's on my calendar today" → query_calendar populated PASS (proves the populated-read break is gone)
2. "any new email?" → get_communication populated PASS (the populated-read regression case)
3. "what are my open tasks" → get_tasks PASS (first POST-FIX live run - the first live attempt already ran on old release `2754a6c` and failed `transient:invalid_handler_result`, `tg-904957580`; this step is the post-#202 proof and waits for that deploy)
4. "put a test event 'probe' tomorrow 1-2pm" → propose_calendar_change card; approve from CONSOLE Waiting-on-you; verify event created; then cancel it the same way
5. "draft an email to myself, subject probe, body probe" → draft_email; verify in Gmail Drafts
6. "send an email to myself, subject probe, body probe" → send_email card; approve; verify in Sent (Message-ID reconciliation)
7. "search the web for the Cloudflare Workers docs" → web_search PASS
8. "connect google" (fresh owner account or after disconnect) → connect link minted; AFTER #202 merges the link must be `/c/?t=` form

Approval probes (4, 6) must each record: the real `proposal_id`; observed pending state in the console; the approval as a separate action; provider readback (event exists / message in Sent); and the channel delivery receipt. A model sentence about buttons is not a receipt.

Langfuse receipt verification: traces carry WALDO_RELEASE (commit SHA) - each probe trace must name the deployed SHA. This lane can verify receipts via the Langfuse dashboard (vault-fill Google SSO) once probes run.

## Candidate fixes under review (open, unmerged, undeployed; no live post-fix proof)

- #212 @ 73f80458 (base beta-mvp 2754a6c): reconciled tool-turn taint - per-item dispatcher-derived sanitise PLUS the final aggregate batch pass (absorbing #204's guard), typed safe omission receipts, compaction only via stored-output ids whose store provenance binds them to the turn carrying the marker. Supersedes #208 @ 86299bb and #209 @ db232c9, which remain open. This is the candidate fix for the populated-read break above. Under review, not live-proven.
- #218 @ 6876f550 (draft): integration head combining #212 @ 73f80458 into #211 @ ba5d02e. Under review, not live-proven.
- #202 @ dde1627: connect-link privacy form (`/c/?t=`), truthful per-outcome approval notices (exhaustive outcome mapping), filtered Google pagination with complete=provider-exhausted semantics, external-stamp on withGoogle's caught transient arm (the `tg-904957580` defect). Awaiting owner merge.
- #211 @ ba5d02e: dynamic context budget. Awaiting owner merge.

## Queued (not worked, per owner pause): internal-taint hardening beyond #212; redaction-registry/URL-scrubber ports; sentinel egress proxy design.
