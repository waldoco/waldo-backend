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

- **Health-forward.** Waldo is a health-aware personal agent. Gym scheduling, health and meal tracking, coaching and mental wellness are core scenarios. Context engineering for them has to be strong: the model reasons over the owner's routines, preferences and signals and turns them into the right memories and actions. Health routines and preferences are first-class memory content. The line is clinical acts (diagnosis, treatment, dosing), not health topics; see [messaging behavior](../behavior/MESSAGING_BEHAVIOR.md#health-conversation).
- **Multimodal input.** Text-only today is a channel gate, not a model limit. The owner can send text, emoji, images and files; Waldo reads each through the model's image and file inputs and says plainly when a type is not supported yet.
- **Direct or Kennel.** Waldo handles small requests directly in chat. Larger work becomes a Kennel packet for structured execution, and the chat keeps the owner informed.

## Kennel and OpenLoops

- **OpenLoops home.** The Kennel home tab is not fully built. Its idea is a day view of the owner's open loops: across communication channels, commitments, personal life, tasks and goals, folded into Waldo.
- **Waldo and Kennel in sync.** Closing the local loop means Kennel connects to the owner's codebases and drives Claude Code for his work, with Waldo tracking the outcome.
- **Capability brief.** A detailed brief from the owner on Waldo's capabilities, apps and feature set is coming. Add it here when it arrives.

## End-of-day bar and next horizon

- **End-of-day bar.** The owner spins up his own Waldo end to end, with his own accounts connected, once the app and dashboard are configured.
- **Next horizon.** Agent-to-agent communication, and a plugin system for external agents and harnesses (Meta Muse, Codex, Claude and others).
- **Later ambition (not scheduled).** Train our own orchestrator model for partner agents, in the spirit of [Sakana AI Fugu](https://sakana.ai/fugu/), one model that routes work across other models and agents.

## Frontier reassessment (23 September 2026)

This is a first pass over research published since March 2026, grouped by pillar. Each item says what Waldo takes from it. Voice, on-device models and prompt-injection defense are still to be covered.

### Memory

- Update-on-write beats embedding retrieval when facts change. In the MERIT benchmark ([arXiv 2609.05441](https://arxiv.org/abs/2609.05441)), memory lifts dependent-task success from 0 to 0.55-1.00. On updated facts, embedding retrieval swings between 0.30 and 0.95 across models, while a structured fact store and LLM summarization stay at 0.70-1.00. A hybrid of the two scored worse than the fact store alone. Agents acted on a correctly retrieved value only 55% of the time. Take: the four core files (LLM-maintained, update-on-write) are the right first layer. The locked plan to fuse an external vector index with RRF should be measured against the files before it becomes the default.
- No memory substrate wins everywhere, and retrieving too much hurts decision-making ([arXiv 2608.15008](https://arxiv.org/abs/2608.15008)). Take: keep the prompt's memory lean, and pick recall depth by the kind of turn.
- Retrieval should reshape memory. REALM reconsolidates memories based on retrieval feedback and beats baselines on LoCoMo and LongMemEval ([arXiv 2609.16053](https://arxiv.org/abs/2609.16053)). Take: stage 7-8 (ACT-R activation, nightly reflection) should use what was actually recalled and used.
- Derived memory can be stale. Hindsight tags its consolidated layers with a staleness grade and falls back to raw facts when a layer is behind ([Hindsight, June 2026](https://hindsight.vectorize.io/blog/2026/06/17/freshness-aware-memory)). It also separates cheap recall ("what did I say about X") from model-driven reflect ("what should I do about X") ([Hindsight, July 2026](https://hindsight.vectorize.io/blog/2026/07/24/recall-vs-reflect)). Take: intelligence-summary is derived, so it carries a last-refreshed marker. Recall and reflect stay separate operations.
- Sleep-style consolidation with value-based forgetting is still at research-preview stage ([arXiv 2604.20943](https://arxiv.org/abs/2604.20943)). Take: this supports the stage 7-8 direction, but the evidence is thin.

### Orchestration

- Skills with clear input and output contracts do better as subagents with a fresh context than as instructions loaded into the main context ([arXiv 2609.09233](https://arxiv.org/abs/2609.09233)). LangChain's Deep Agents now drive many subagents from a short model-written script instead of one tool call at a time ([LangChain, June 2026](https://www.langchain.com/blog/introducing-dynamic-subagents-in-deep-agents)). Take: give long Waldo skills explicit contracts and run them as subagents.

### Proactivity

- PASK splits proactivity into demand detection, memory modeling and an action system, with a cache, main memory and storage hierarchy ([arXiv 2604.08000](https://arxiv.org/abs/2604.08000)). VibeLifeBench runs 200 multi-week everyday-life tasks. The best of seven frontier models reported scores 32.5, and every model loses 10-15 points between the start and end of a timeline ([CCTest summary](https://cctest.ai/en/articles/vibelifebench-tests-whether-life-agents-can-stay-proactive-for-weeks); secondary source). Take: Waldo's evals need multi-week scripted timelines that score when to act, when to ask and when to stay quiet.

### Evals

- Capability (pass@1) and reliability across repeated runs drift apart as tasks get longer ([arXiv 2603.29231](https://arxiv.org/abs/2603.29231)). Take: report pass^k for Waldo's end-to-end scenarios, not single runs.

### Protocols

- The MCP 2026-07-28 revision is stateless: no sessions, no initialize handshake, capabilities sent per request, and tasks moved to an extension ([MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). Take: build new MCP work against this revision. It suits Workers better than the session-based version.

### Health behavior

- SIM-VAIL audits chatbots across multi-turn psychiatric conversations and targets quieter interactional harms, not just overtly unsafe replies ([Nature Medicine, August 2026](https://www.nature.com/articles/s41591-026-04577-2)). Take: `scripts/health-scenarios.ts` only covers single turns. Add multi-turn health and wellness audits.

### Decision for the owner

MERIT's result cuts against the locked memory decision to fuse an external vector index with RRF. The proposal: ship the core files first, add the updated-fact eval (roadmap stage 13), and add vector recall only where that eval shows it helps.

## Queue

Day program, in order:

1. Current queue: drop fix, observability, Telegram webhook deploy, dev loop on the owner's Mac.
2. Repo cleanup: close stale issues, remove stale docs, file tickets for hardcodes and hard limits to fix later.
3. Memory layer: hybrid full-text, vector, SQLite and files design, then build. First persistence hop: hot conversation state in the owner Durable Object's own storage, so eviction loses nothing. Then R2 archives and the Supabase queryable layer.
4. Langfuse observability slice on Langfuse Cloud.
5. Multimodal slice and a rigorous end-to-end test pass.
6. AG-UI projection, onboarding, and surfaces: Waldo mobile app in parallel with Discord, then iMessage. WhatsApp is on hold under Meta's AI Provider terms. See [channel options](CHANNEL_OPTIONS.md).
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
