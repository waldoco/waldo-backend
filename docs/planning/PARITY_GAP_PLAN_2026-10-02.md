# Parity gap plan against the owner's landscape sheet

Status: proposal for the Core + Dalda build team. Layer: SOURCE audit, no live claims. Basis: the owner's parity workbook (Overview, Matrix, Waldo Gaps, Wedge, Evidence; reviewed 2026-10-02 12:00, Waldo snapshot beta-mvp 8ef75e8) read on 2026-10-02 17:27 IST, plus Core's own merges since. beta-mvp is now de43da6 (#561 Calendar coverage and sign-in retries, Codex, merged; staging verification of it is reported underway by Dalda, unverified here). The sheet's rule applies here: source presence and passing tests do not establish live acceptance, and "Not established" cells are research questions, not facts about competitors.

## What changed since the sheet's snapshot (8ef75e8)

Merged, SOURCE + CI only: #552 read_mcp_tool names and reconnect message (ec553ab), #553 Drive-only consent design (5958a8f), #556 context lineage v3 + tool ACL intersection (e9a45fc), #558 ACL denial reasons, findings and metadata analysis (eb48ced). Open drafts: #555 admission amendment (Codex branch), #564 inert PDF export download helper (bbbe181), dashboard #562 (Dalda). Staging release was 8ef75e8 with read_tools applied as of Oct 2 08:15 IST; it does not include #552 or later until Codex releases.

## Gap rows, in the sheet's priority order

| Capability | Sheet priority | Gap that is real today | Next build (acceptance = the sheet's test) | Owner of the work |
| --- | --- | --- | --- | --- |
| Channels & identity | Foundational | Cross-channel continuity not shown; WhatsApp parity and iMessage reach unverified | Link two surfaces to one owner, resume without rebriefing, revoke one without leaking context. Depends on canonical admission (#555/#556 types) | Codex host slice (DO), Core tests |
| Memory | Foundational | Long-thread relevance and deletion coverage unproved | Remember/correct/forget across channels and restart, with provenance and stale status. Core builds the long-thread retrieval harness and a deletion-coverage test list | Core |
| Permissions | Foundational | Owner responder still uses a local fixture principal; A1 adapter and host binding pending | Canonical principal/tenant, cross-owner denial, stale grant/revocation. Contracts merged (#556, #558). Binding is gated on handler-declared `requires_connector` | Codex host, Core contracts |
| Background & persistence | Foundational | Background rows are audit records, not resumable state | Crash before/after an external write, reconcile before retry. Needs a design of resumable task state first | Core design, then Dalda harness |
| Verification & recovery | Foundational | No representative live effect verification; claim-verify is design only | Build claim-verify in shadow mode from #549; distinguish requested/accepted/running/uncertain/verified | Core |
| Observability | Foundational | No actual-model outcome evidence; native36 is 0 of 30 runnable | First 2 native36 cases, then the full run. Needs the owner's spend decision and a key through a vault link | Core, owner spend |
| Tools / MCP | First wedge | Live Drive read has not succeeded (auth_failed, grant lacks drive.readonly); no read-to-draft-to-approved-effect proof | Consent, then Drive proof, then one real read, draft, approved effect workflow confirmed in the source system | Core + Codex release |
| Proactivity | First wedge | Quiet-vs-action staging proof absent | Track a user-authorized commitment, detect change, notify once, honor pause and stop | Dalda harness, Core review |
| Artifacts / workspace | First wedge | Missing R2 body loses content; export tool and download route unregistered | Create, reopen after eviction, revise, deliver with a stable reference. #564 covers download only | Core (helper), Codex (registration, route) |
| Skills & learning | After admission | Host admission unwired; skills inert | One eligible read-only skill selected with owner/trigger scope; no-skill baseline preserved | Codex host, Core loader |
| Browser / computer | Selected workflows | Private custody not wired into owner chat | One bounded browser task with auth handoff | Later |
| Delegation / interop | Strategic pilot | No wired A2A transport | One scoped assignment surviving disconnect | Later |
| Health/capacity, Portability | Enhancer, later | Not established | Defer behind the foundational rows | Later |

## Proposed split

- Core: dashboard implementation (projections and visual layer), contracts, loader, memory and verification harnesses, artifacts, native36, audit and review of every PR.
- Dalda: review (dashboard and others), coordination, proactivity harness, resumable-task design with Core.
- Codex: staging deploys, `telegram-owner-do.ts` and `console-signin.ts` edits, host slice for admission. Overlapping edits are coordinated with Codex first.
- Merges follow the existing rules: independent review plus exact-head green CI.

## Still the owner's

Spend is split in two. Model-run spend for native36 was relayed by main (5:31) as approved in small chunks with actual spend reported after each; it is not a cap and not blanket approval for other spend. Provider keys already live as Worker secrets on staging (doc claim, not live-verified); a key for a local run goes only through a vault link. Production changes, and approval of the exact Google consent screen. Today's consent screen requests Gmail send and compose and Tasks write along with Drive read; main relayed at 17:26 that the owner said yes to Dalda's asks (relay only, not independently verified here), and nothing in it names that screen, so Core still needs his words on it, or the incremental flow from #553 to ship.

## Reconciled with Dalda's review (2026-10-02 17:39 and 17:54, relayed by main, unverified claims checked against source)

Applied:
- Dashboard: Dalda declined the visual implementation (17:56) and offers review. Core now owns the dashboard implementation, including #562's visual layer and the projections, with Dalda reviewing. Dalda keeps coordination and review, proactivity and resumable state.
- Google/Drive: Tools/MCP row states the live facts (auth_failed, drive scope absent, consent unapproved). Staging is at de43da6 (healthz 200, checked 17:51), which includes #552 only if Codex's release carried it; confirm before the Drive proof.
- Durable follow-through: WorkUnit exists as contract schemas and fixtures only (packages/contracts/src; no reference in packages/runtime/src on beta-mvp), so production WorkUnit execution is not enabled. That matches Dalda's claim. The final outbox (channels/telegram-final-outbox.ts) is a Telegram payload record (chat_id, text, attempts, status, digest), so reuse for durable send needs a generic payload seam, not a copy. Background & persistence row: reuse the outbox's identity, digest and retry model; any DO hookup is a narrow seam coordinated with Codex (single writer of telegram-owner-do.ts).

Kept as the owner's sheet has them, pending an owner decision:
- Health/capacity stays a tested enhancer. Dalda wants first-class permissioned health.
- Proactivity stays first wedge and delegation a strategic pilot. Dalda wants both core.

## Order of work (proposal)

1. Drive proof (Codex releases ec553ab or later, owner approves the screen, Core runs the proof).
2. Handler-declared `requires_connector`, then the A1 host binding.
3. Claim-verify shadow mode and the Memory long-thread harness (no spend needed).
4. First two native36 cases once the owner names option and cap.
5. Resumable task state design, then the proactivity staging proof.
