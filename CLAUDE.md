# waldo-backend — repository instructions

## Build direction

Read `.claude/rules/INDEX.md`, `AGENTS.md`, [the build direction of 21 October 2026](docs/planning/BUILD_DIRECTION_2026-10-21.md) and `docs/foundation/NEXT-SESSION-PLAN.md`. The build direction records the owner's product and architecture decisions and the wave order, and it wins over the September build plan and the pinned Brain launch contract where they conflict, until that contract is amended. Accepted ADRs and released contracts still bind their exact seams; amend them through review when a wave needs to change them. Current source and tests determine actual capability, not roadmap prose.

Planning text never authorizes runtime execution, cloud mutation, dependency changes, source deletion, merge, or deployment. Start implementation only under a bounded user task and owning issue.

## Stable constraints

- Judgment belongs to the model. Do not add regex or other fixed rules for anything that is a judgment call (tone, intent, topic, health vs clinical, what to remember). The harness gives the model context, reasoning room, tools and autonomy. Deterministic rejection is allowed only for hard security and safety boundaries where a reject must be guaranteed: auth, secrets, canaries, owner checks, egress, schema validation, and medication dosing. When you find a fixed rule making a judgment call, file it under `post-mvp-cleanup` or move it to model reasoning with scenario tests.

- One brain: the per-owner `OwnerDO` is the only authority root and the only writer of memory, chats and approvals. Long, parallel or untrusted work goes to short-lived task workers that return results or proposals for the brain to apply once; they hold no memory, send or approve tools. The second brain (RunLoopDO, `WaldoCoordinator`, the responsibility API and protocol, TracerDO's journal/outbox pipeline) was deleted in B-1 (October 2026); do not reintroduce a competing brain.
- Keep the existing ContextComposer and intent-before-I/O effect path. A new adapter does not become canonical authority.
- Global-first. Capabilities work in every market; market rails (UPI hand-off, Swiggy, local-language voice) are per-market adapters, never assumptions in core code.
- The app is the primary presence (onboarding, health sync, approvals, "What Waldo knows"). Chat on iMessage, WhatsApp and inbound email follows the same authority boundary; Telegram is a test channel being retired. Build no feature for one surface only. Later desktop is an executor/presence.
- Health-aware planning from wearable data (HealthKit, Health Connect, WHOOP, Oura) is the launch wedge, with a one-tap check-in for owners without a wearable. Health sharing is optional per user; missing/revoked health never becomes invented readiness or implicit action authority.
- Preserve ADR-0081 health computation/destination rules as amended by docs/app/HEALTH_PLANE_AMENDMENT.md and ADR-0082 device lifecycle. New health-pattern persistence and standing grants need explicit bounded contract/ADR review where they extend existing decisions. Conversation bodies and full email/thread/attachment content are normal agent context within the owner's authorization; document their storage and egress in the owning contract, not as a blocking ADR.
- Preserve intent-before-I/O, frozen intent/digests, keyed reconciliation, one retry owner, bounded work, cancellation fencing and honest terminal ambiguity. Never run external I/O inside the owning SQLite transaction.
- Activity, Evidence, Verification, Acceptance and Outcome/OpenLoop closure remain distinct. Existing explicit-owner closure rules are not weakened by a standing tool grant.
- Built-in capabilities are not preauthorized actions. Resolve the smallest per-turn capability manifest. Grants are owner/resource/parameter/time/budget scoped, revocable and rechecked before dispatch/resume.
- A Trusted Relationship does not share memory or authority. Each owner independently admits, approves, executes, and accepts its side of a signed, minimal coordination exchange.
- Give the model the context the task needs: full mail bodies, long threads, attachments, and real names and addresses within the owner's authorized boundary. Do not blanket-redact or refuse content for size; paginate, chunk or retrieve instead. Memory is correctable context, not permission. Credentials never enter prompts, logs, fixtures or event payloads.
- Sensitive chat is classified at ingress. By owner ruling (beta), the owner's own wearable readings and health context may reach model context and owner-channel replies end to end. They still never go to logs, audit records, R2 summaries, browser jobs, third-party sends or drafts (unless the owner asks to share a specific item), externally tainted content paths, or bulk long-term memory: synced wearable readings are read live from the Supabase health plane and never copied into memory. By owner ruling (22 October 2026), what the owner tells Waldo about their own health may be kept in their memory, numbers included: a stated reading as a dated statement, a goal as a standing entry the owner can replace. A health number that arrives in externally tainted content is not written to memory from that path. Traces: during alpha and beta, by owner ruling (10 October 2026), the staging Langfuse project captures model text for opted-in testers, health included; production never captures text (enforced in code), and this exception is revisited with the other guardrails before production. WhatsApp logs: while testing, by owner ruling (18 October 2026), staging may log whole signed webhook payloads, Graph's error answers and a failed send's error text, including message text (health a tester types included), numbers and BSUIDs (`WHATSAPP_DEBUG_LOG`); no other environment does (enforced in code), credentials never do, and this exception goes before production. Provider egress must satisfy applicable consent/DPA/Scribe policy and the request must not ask the provider to retain it. Retention and deletion follow docs/app/HEALTH_PLANE_AMENDMENT.md.
- Protected voice assets are reviewed source material, not authority to leak numbers or claim actions. Personality cannot override receipts, uncertainty, privacy or current user preferences.
- Released contracts keep their semantics. New draft/replay/stream behavior requires an additive released contract; no silent widening. (The responsibility protocol v0.1-v0.6 and its public OpenAPI were retired with the second brain.)
- Informational conversation does not need a formal Mission/Outcome ceremony, but consequential work uses canonical admission/effects/closure.
- Never infer shipped capability or competitor parity from plans, schema counts, local fakes or model claims.

## Repository responsibilities

`packages/contracts` owns public DTOs, schemas, manifests and fixtures; `packages/runtime` owns runtime, persistence and adapters; `supabase` holds backend-controlled migrations/health data-plane work; `scripts/guards` enforces architecture boundaries. No mobile or marketing implementation belongs here.

Use `docs/README.md` for retained reference material. The October build direction, accepted ADRs, released contracts, and current source/tests own live implementation constraints. The September personal-agent build plan is historical where the build direction differs. Old planning snapshots, handoffs, PR descriptions, and Linear/HEY identifiers are historical unless fresh evidence confirms otherwise.

## Working discipline

Inspect fresh source, Git state, owning issue and ledger #116; preserve unrelated work. Name the concrete problem, files/interfaces, canonical writer, privacy/authority impact, tests, falsifiers and rollback before a bounded change. Use TDD for behavior, break rejection/recovery paths, and run independent review when required. Keep schema, migration and `OwnerDO` writers coordinated. Do not re-open the whole architecture without implementation evidence.

Runtime cleanup is not a blanket delete: inventory imports, dynamic callers, build entries, tests, native modules, deployed routes/jobs/bindings and retained migration history; establish generated-client replacement, staging/device parity and rollback first.

## Commands

```bash
git diff --check
npx -y pnpm@10.34.4 verify:guards
# Required full wall for runtime/contracts/integration changes:
npx -y pnpm@10.34.4 verify
```

Use the locked repository environment and actual script definitions. Record PASS, FAIL, NOT RUN and UNAVAILABLE separately at an exact SHA. Do not use `--no-verify`, weaken guards to fit documentation, or describe source-only inspection as tests. External credentials, staging/production mutations and deployment require separate explicit authority.
