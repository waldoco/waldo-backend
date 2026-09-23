# Adoption direction

What Waldo takes from peer agents, what it leaves, and where each item sits in the queue. Sources are dated research, not hands-on claims.

## From OpenMuse

Teardown of [CopilotKit/openmuse at `fed01e9`](https://github.com/CopilotKit/openmuse/tree/fed01e9d6411ab773d9adf1aa490a07dc8c64d0b). Ranked by value against effort:

1. **AG-UI event projection** from ConversationEntry and the Joined Path. AG-UI stays a projection; the canonical record is ConversationEntry.
2. **Management workspace UI** in the Waldo app over the existing read model (`96b8f05`, `e51e538`): activity, exact approvals, conversation branches, memory corrections, connections, heartbeat.
3. **Lease, heartbeat and status vocabulary**, with visible waiting-for-input and waiting-for-approval states. Internals stay single-writer DO.
4. **Crash-visible receipts and outcome-unknown states**, backed by Waldo's outbox and reconciliation.
5. One persistent browser worker with profile takeover, behind Waldo's operation boundary.
6. An isolated no-network Linux workspace with command and file receipts, after browser and sandbox work.
7. Composer details: in-place stop, kept drafts, visible follow-up queue, stable scroll.
8. Exact review cards bound to hash, account, version and expiry.

Not adopted: CopilotKit Intelligence as canonical storage, shared access-key identity, flat memory, authority written in prompt prose, single-process PGlite in production, scheduling that needs a host always up.

## From Meta Muse

Adopted: a joined surface of goal, current activity, approval, takeover and later inspection; approvals kept outside agent prose; tunable proactivity. Not adopted: building VM infrastructure ourselves, or Meta's data defaults. Source: [security approach](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).

## From Hermes Agent

Adopted: prove one clean conversation before adding channels and automation, which is the order followed here; explicit resume and diagnostics; checkpoints that keep later human edits. Not adopted: memory and skill writes without review, and bypass approval modes. Source: [Hermes docs](https://hermes-agent.nousresearch.com/docs/).

## From Pi

Adopted: small, inspectable cores and version-bound provider transforms. Not adopted: unrestricted local filesystem and shell defaults. Source: [Pi coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).

## Queue

1. AG-UI projection (contract level).
2. Management workspace UI in the Waldo app.
3. Lease and heartbeat UX vocabulary.
4. Crash-visible receipts and outcome-unknown states.
5. Waldo app chat wiring: chat management, threading, AG-UI rendering and generated UI (cards, option chips, forms).
6. Discord connector with full threading, as the threading test channel.
7. Slack threading, later.
