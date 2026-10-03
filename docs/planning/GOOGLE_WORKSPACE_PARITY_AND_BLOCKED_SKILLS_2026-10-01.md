# Google Workspace parity and the five blocked skills (plan, staging only)

Status: draft plan. Evidence layers are kept apart: SOURCE (code in repo), CI, STAGING, LIVE. Nothing here is LIVE-proven.
Owner words: 2026-10-01 22:02 ("we do have google account connected in staging"), 22:03 ("let's add other google services now"), 22:11 ("let's resolve these", the five blocked skills). Limits: staging only, no spend, no secrets in chat, no production, writes stay approval-gated.

## Part 1. Google Workspace parity

Source for endpoints, APIs and scopes: https://developers.google.com/workspace/guides/configure-mcp-servers (fetched 2026-10-01). Drive scope classes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth.

| Service | Today in Waldo | Path | Scopes (minimal) | Reads | Writes (approval-gated) |
| --- | --- | --- | --- | --- | --- |
| Gmail | native, SOURCE+tests | keep native | gmail.readonly, gmail.send, gmail.compose (existing) | search/read threads | send, draft |
| Calendar | native | keep native | calendar.events, calendar.events.freebusy (existing) | events, freebusy | create/move/cancel |
| Tasks | native | keep native | tasks (existing) | list | create/update |
| Drive | #524 draft, MCP | MCP drivemcp.googleapis.com/mcp/v1 | drive.readonly | list/read files | none in slice 1 |
| Docs | none | MCP docsmcp.googleapis.com/mcp/v1 | documents.readonly (read); documents (write) | read_doc | update_doc |
| Sheets | none | MCP sheetsmcp.googleapis.com/mcp/v1 | spreadsheets.readonly (read); spreadsheets (write) | get_spreadsheet, get_values | update_spreadsheet, update_values, update_formulas, insert_dimension |
| Slides | none | MCP slidesmcp.googleapis.com/mcp/v1 | presentations.readonly (read); presentations (write) | read_presentation | update_presentation |

Tool names for Docs, Sheets and Slides are from Google's per-server MCP reference pages. Drive and Gmail tool names are not listed on those pages; fill `allow_tools` from a `tools/list` call. Calendar MCP reference page did not resolve; Calendar stays native.
Docs/Sheets/Slides MCP servers also list drive.readonly and drive.file in their scope lists, so read tools need drive.readonly.

### Phased plan
1. Read-only first (one reconnect): add drive.readonly, documents.readonly, spreadsheets.readonly, presentations.readonly to the consent set. Register four read-only MCP entries with `requires`, an explicit `allow_tools` of read tools only.
2. Writes later, each behind the existing approval card and a receipt: Docs update_doc, Sheets update_*, Slides update_presentation. These need documents, spreadsheets, presentations (full), so ask for them in phase 2, not phase 1, unless the owner wants one reconnect for everything (trade-off: one reconnect vs minimal scopes).
3. Each service gets a live staging proof (owner reads a real file) before it is called usable.

### Verification impact (Waldo app is test-users-only)
- Test-users-only apps can use any scope for listed test users without Google verification, so staging works now. Public launch changes this.
- drive.readonly is a restricted scope (Google's Drive auth page). Restricted verification and possibly a security assessment apply if data is stored or transmitted through servers. drive.file is non-sensitive but only covers files opened with the app or picked, so it cannot read arbitrary Drive files.
- Docs, Sheets and Slides scope classes were not verified in this pass. Treat documents, spreadsheets, presentations as sensitive until checked against Google's scope tables.
- Gmail scopes already in use are Google restricted-class; verification cost exists today.

### Source changes needed (draft PRs)
- #524 (merged first): Drive read slice, feature on scope_missing cards.
- Next: add the three other readonly scopes to GOOGLE_FEATURE_SCOPES features (docs, sheets, slides), keep them out of GOOGLE_CONSENT_SCOPES until the owner approves the consent change; connectUrl must stop ignoring `feature` or the consent set must include them. Do not claim any of them usable until that lands.
- Add `requires` to every Workspace entry in WALDO_MCP_SERVERS; an entry without it gets no scope gate.

### Owner checklist (Google Cloud console, his actions)
1. In the Waldo Google Cloud project, enable APIs: Drive, Docs, Sheets, Slides (plus existing Gmail, Calendar, Tasks). `gcloud services enable drive.googleapis.com docs.googleapis.com sheets.googleapis.com slides.googleapis.com`.
2. Enable the MCP services: `gcloud services enable drivemcp.googleapis.com docsmcp.googleapis.com sheetsmcp.googleapis.com slidesmcp.googleapis.com`.
3. OAuth consent screen, Data Access: add the readonly scopes listed above (phase 1). Keep the app External with test users; confirm his account is listed.
4. Merge the scope PR, set `WALDO_MCP_SERVERS` on staging with `requires` and `allow_tools` per entry (no secrets in it; Google bearer comes from the owner grant).
5. Sign in on staging and reconnect Google once.
Nothing here needs a secret in chat.

## Part 2. The five blocked skills: sequenced plan

Source of the five: the pack generator script (workspace file, not a committed artifact). Each is blocked because the tool it needs does not exist; changing a status flag cannot create it. Order is after vault, Workspace parity, memory and Drive merge.

| Order | Skill | Adapter/tool needed | Smallest slice | On the owner |
| --- | --- | --- | --- | --- |
| 1 | rich-artifact-export | renderer for HTML/PDF/chart output plus binary storage and exact-MIME delivery | render one document to PDF in staging, store privately, deliver as attachment | none beyond review |
| 2 | trusted-person-coordination | verified peer transport plus disclosure/commitment policy | read-only: verify a peer, answer status, no commitments | choose whether Waldo joins the Instinct-to-Instinct network |
| 3 | browser-task | logged-in browser driver with credential broker | one read-only task on a staging account; sign-in through the vault private link | vault must exist first; supply a test account himself |
| 4 | document-signing-preparation | signing-service adapter, field placement, pixel review | prepare fields on a sample document, never sign | pick the signing service; no signing without per-document approval |
| 5 | ride-preparation | ride-service adapter plus fresh location and payment choice | quote only, no booking | pick the service; spend needs explicit per-ride approval, so staging stops at the quote |

First slice with no owner dependency: rich-artifact-export (item 1).
Each slice keeps the blocked status until a read-only trial passes and its required tools and connectors are verified.

## Unverified in this plan
Scope sensitivity classes for Docs/Sheets/Slides/Gmail; Drive and Gmail MCP tool names; Cloudflare Containers fit for the browser driver (GUI/VM support not verified).
