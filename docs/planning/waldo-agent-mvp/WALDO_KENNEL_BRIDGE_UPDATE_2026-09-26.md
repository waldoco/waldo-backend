# Waldo <-> Kennel bridge: update (2026-09-26)

Update to WALDO_KENNEL_BRIDGE_2026-09-24.md. Covers the pivot accepted on 2026-09-26, the memory research that has since landed in waldo-backend, the ambient-capture direction, the unified architecture, and the revised sequencing. Read together with WALDO_KENNEL_BRIDGE_2026-09-24.md (the base design, unchanged where not amended here) and KENNEL_K0_SOURCE_MAP.md.

## 1. Pivot accepted

The build lane has pivoted from the security-hardening program to agent-experience parity with the leading personal agents (Instinct, Meta Muse, Hermes, OpenClaw). The bridge plan from WALDO_KENNEL_BRIDGE_2026-09-24.md stands as the architecture: Waldo is the entry point and memory home; Kennel is the Mac execution and machine-eyes layer. K0 (pairing + first round trip) remains the first bridge milestone. Everything below is additive to WALDO_KENNEL_BRIDGE_2026-09-24.md, not a replacement.

## 2. Memory research learnings - landed and landing in waldo-backend

Research pass over three mature agent memory systems, and what we took from each:

- **OpenClaw**: claim origin classes (stated / observed / inferred) with session-kind gating - which memory writes are allowed depends on what kind of session produced them - and recall-loop prevention (recall results must not re-enter memory as fresh claims). Landing as #235 (claim origin classes + nightly speaker-split grounding, merged) and reflected in the recall paths.
- **Hindsight**: observation consolidation - raw observations consolidate into durable claims on a schedule instead of accumulating raw. Landing as #234 (memory admission gate at the claim seam, merged) and #237 (consolidation validation at the promotion seam).
- **Honcho**: two-layer injection - a small always-on identity layer plus a larger on-demand recall layer, instead of one monolithic context dump. Reflected in the console memory review surface (#238) and the injection paths it governs.

These land as waldo-backend PRs #234 (merged), #235 (merged), #237, #238 - the memory layer is being built inside waldo-backend, not as a Kennel-side subsystem.

## 3. Ambient capture direction

Capture stays a Kennel-side, daemon-level subsystem built on official Apple APIs (Accessibility / AX tree, ScreenCaptureKit where AX cannot answer) with per-capability TCC consent. No screenshot-first capture: AX-tree-first, pixels on demand only where AX cannot answer, per the 2026-09-24 bridge doc. Captured context distills into typed context episodes over the Kennel->Waldo CDC rail and feeds waldo-owned open loops with evidence - Kennel never writes user memory directly; waldo owns the memory store and the open-loop registry. Comparative research on the ambient-capture field (Rewind, Screenpipe, and peers) follows as a separate package.

## 4. One architecture, nine guardrails

The pivot, the bridge plan, and the memory layer are one architecture: Waldo is the entry point, the memory home, and the owner-facing surface; Kennel is the Mac execution and machine-eyes layer behind the bridge contracts from WALDO_KENNEL_BRIDGE_2026-09-24.md. The nine owner-reviewed build items from the 2026-09-26 post-pivot build program stand as the guardrails every slice is built and reviewed against:

1. WhatsApp adapter - multi-channel reach (owner Meta steps pending).
2. Proactivity running end-to-end (C1-C4, on the scheduler heartbeat that is now merged).
3. Memory admission gate - landed as #234.
4. Skills two-tier (Meta Muse incorporation map) - bounded slices alongside subagents.
5. Subagents v1 - landed as #224.
6. Out-of-the-box use case set - the painkiller-grade day-one set from the 2026-09-26 packet, section 5.
7. Iteration refunds, per-type caps, per-model compression thresholds - bounded PRs.
8. Unattended-cron hard-stop - sequences with proactivity.
9. Per-tool failure classification.

Every slice is built and reviewed against these nine, and against the standing bridge invariants from 2026-09-24: pairing authenticates transport only, owner proof gates material transitions, capture is opt-in per capability class, Kennel never writes user memory, capture scopes are enforced at ingest, one model-visible machine tool (delegate_to_machine), and no raw-shell job class.

## 5. Sequencing

K0 (pairing + first round trip, per the 2026-09-24 bridge doc's K1/B1) remains first. Ambient capture is the second or third bridge capability - after pairing and the first command round trip are live, alongside or just after mission projection - not before. The waldo-backend memory layer (#234/#235 merged; #237, #238 in the merge wave) proceeds in parallel and does not wait on the bridge.

*Update prepared by the build lane, 2026-09-26. Companion to WALDO_KENNEL_BRIDGE_2026-09-24.md; nothing in the 2026-09-24 doc is rescinded except where amended above.*
