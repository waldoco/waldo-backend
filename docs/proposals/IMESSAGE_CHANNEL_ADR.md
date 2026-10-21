# Proposed ADR: provider-neutral iMessage relay

Status: proposed for adversarial review; source-only. Owner assignment: issue #507 and the [full design](https://files.instinct.com/file-01M3V4WW7G7BGCDBNAMSG9WXK4), read in all three sections at revision `filerevision-01m3v546v91v938mk1y0aca7sa` on 1 October 2026. No canonical accepted ADR is amended by this proposal.

## Problem and decision

Apple GUIDs, account routes, ordered files and uncertain native mutations cannot truthfully be represented as fabricated Telegram numeric updates. Keep the existing per-owner runtime and admitted `OwnerTurnEnvelope`; put Apple session state behind an isolated relay. Choose imsg as the first reference transport and retain a bridge-neutral contract for a later BlueBubbles wrapper.

The v1 contract lives in `packages/contracts/src/channels/imessage-v1.ts`. IDs are opaque nonblank strings with no whitespace padding or control characters; no UUID assumption or arbitrary provider ID length ceiling. Ingress distinguishes iMessage, SMS and RCS; outbound requires iMessage and `allowSMSFallback=false`. Commands bind owner, verified presence, bridge, account and chat; message mutations require a message GUID and part index. Non-owner, quote, reaction, poll and app metadata remains external context. No generic thumbs-up approval protocol is introduced.

Capabilities separately expose receive, send, exact target and verified host-probe evidence. Every live feature starts disabled. Compiled upstream methods are not readiness or recipient delivery. `local_recorded` requires local database evidence and cannot parse as delivered; delivery requires a transport delivery/readback reference. A reference contract validates shape, not the truth of a future bridge assertion.

S0 locks the contract, synthetic fixtures and source pins. S1 minimally extends the already extracted admitted seam and lookup provider; candidate SQL stays outside canonical migrations and is tested offline. S2 builds signed fixture relay admission, durable bounded spooling/cursors and account mutation quarantine. S3 owner lookup/verification/media storage, S4 rendering/live receipts and S5 BlueBubbles wait for separate review. No live routing, public ingress endpoint, Mac process launch, Apple login, media URL fetch, secret binding or production feature flag is added.

## Alternatives

- Telegram-shaped shim: rejected because GUID/account/service identity would be lost and acknowledgements could lie.
- Import OpenClaw/Hermes runtime: rejected because Waldo already owns memory, admission and effects.
- Direct BlueBubbles webhook: deferred; lacks the trusted signing relay required by this design.
- Hosted Spectrum: no approved vendor terms, cost or backend deployment/license investigation; no dependency introduced.

## Security and recovery contract

Authenticate bounded raw bytes, timestamp and nonce with the account-bound key before parsing or owner lookup. Atomic durable record precedes ACK and cursor advance. Equal event identity with changed bytes is a conflict. Replacement database generations invalidate cursor reuse. Native commands persist before execution; one mutation lane per account. Started or uncertain work survives restart as quarantined; no automatic retry except a proved `not_started`. Read/status work remains available when a mutation lane is poisoned. Unknown senders reach no responder/private context in this scaffold.

Limits are either pinned protocol facts or explicit injected policy with a named source; none is an agent judgment heuristic. The downstream model attachment bound remains its existing contract and never causes silent truncation. No body or filesystem path enters logs or public errors.

## Proof and disposition

Synthetic fixtures cover text, URL-balloon update, reply part, group, ordinary audio and multiple files, custom reaction and edit. Schema tests cover valid/invalid IDs, operations and target binding; host capabilities and actual delivery remain unverified. Fixture events are authored normalized envelopes, not captured live Apple traffic. The source guide's inferred capabilities are hypotheses until a selected host is probed and recipient-device E2E passes.

Rollback is removal of the unmerged scaffold branches. No database or runtime state change is needed. All slice PRs target beta-mvp; dependent branch diffs are cumulative until predecessors are reviewed/merged by Instinct, never Codex.
