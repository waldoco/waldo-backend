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

## Architecture directions

- **Multimodal input.** Text-only today is a channel gate, not a model limit. The owner can send text, emoji, images and files; Waldo reads each through the model's image and file inputs and says plainly when a type is not supported yet.
- **Direct or Kennel.** Waldo handles small requests directly in chat. Larger work becomes a Kennel packet for structured execution, and the chat keeps the owner informed.

## Kennel and OpenLoops

- **OpenLoops home.** The Kennel home tab is not fully built. Its idea is a day view of the owner's open loops: across communication channels, commitments, personal life, tasks and goals, folded into Waldo.
- **Waldo and Kennel in sync.** Closing the local loop means Kennel connects to the owner's codebases and drives Claude Code for his work, with Waldo tracking the outcome.
- **Capability brief.** A detailed brief from the owner on Waldo's capabilities, apps and feature set is coming. Add it here when it arrives.

## End-of-day bar and next horizon

- **End-of-day bar.** The owner spins up his own Waldo end to end, with his own accounts connected, once the app and dashboard are configured.
- **Next horizon.** Agent-to-agent communication, and a plugin system for external agents and harnesses (Meta Muse, Codex, Claude and others).

## Queue

Day program, in order:

1. Current queue: drop fix, observability, Telegram webhook deploy, dev loop on the owner's Mac.
2. Repo cleanup: close stale issues, remove stale docs, file tickets for hardcodes and hard limits to fix later.
3. Memory layer: hybrid full-text, vector, SQLite and files design, then build.
4. Langfuse observability slice (cloud or self-hosted).
5. Multimodal slice and a rigorous end-to-end test pass.
6. AG-UI projection, onboarding, and surfaces: Waldo mobile app, Discord, then WhatsApp or iMessage where possible.
7. Web dashboard.
8. Extended competitor matrix (features, behavior, capabilities) in this document.
9. Secrets and vault: the agent creates its own vault files and shares them with the owner.
10. Performance work throughout.

Carried from earlier:

1. AG-UI projection (contract level).
2. Management workspace UI in the Waldo app.
3. Lease and heartbeat UX vocabulary.
4. Crash-visible receipts and outcome-unknown states.
5. Waldo app chat wiring: chat management, threading, AG-UI rendering and generated UI (cards, option chips, forms).
6. Discord connector with full threading, as the threading test channel.
7. Slack threading, later.
