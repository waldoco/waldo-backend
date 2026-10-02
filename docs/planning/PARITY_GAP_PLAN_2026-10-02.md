# Parity gap plan against the owner's landscape sheet

Status: proposal for the Core + Dalda build team. Layer: SOURCE audit, no live claims. Basis: the owner's parity workbook (Overview, Matrix, Waldo Gaps, Wedge, Evidence; reviewed 2026-10-02 12:00, Waldo snapshot beta-mvp 8ef75e8) read on 2026-10-02 17:27 IST, plus Core's own merges since. beta-mvp is now eb48ced. The sheet's rule applies here: source presence and passing tests do not establish live acceptance, and "Not established" cells are research questions, not facts about competitors.

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

- Core: contracts, loader, memory and verification harnesses, artifacts, native36, audit and review of every PR.
- Dalda: dashboard (#562 and the bounded visual revision), proactivity harness, resumable-task design with Core.
- Codex: staging deploys, `telegram-owner-do.ts` and `console-signin.ts` edits, host slice for admission. Overlapping edits are coordinated with Codex first.
- Merges follow the existing rules: independent review plus exact-head green CI.

## Still the owner's

Spend (any model run), secrets and keys (vault links only), production changes, and approval of the exact Google consent screen. Today's consent screen requests Gmail send and compose and Tasks write along with Drive read; main relayed at 17:26 that the owner said yes to Dalda's asks (relay only, not independently verified here), and nothing in it names that screen, so Core still needs his words on it, or the incremental flow from #553 to ship.

## Order of work (proposal)

1. Drive proof (Codex releases ec553ab or later, owner approves the screen, Core runs the proof).
2. Handler-declared `requires_connector`, then the A1 host binding.
3. Claim-verify shadow mode and the Memory long-thread harness (no spend needed).
4. First two native36 cases once the owner names option and cap.
5. Resumable task state design, then the proactivity staging proof.
