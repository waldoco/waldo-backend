# waldo-backend — repository instructions

## Candidate build roadmap

Read `.claude/rules/INDEX.md`, `AGENTS.md`, the [personal-agent product architecture and build plan](docs/planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md), and `docs/foundation/NEXT-SESSION-PLAN.md`. The [pinned reconciled launch contract](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md) is the current cross-repository scope authority and must be amended for the plan's release cuts. Before merge, the backend plan is a candidate roadmap. After review/merge it governs backend roadmap, dependency order, and documentation cleanup; conflicting product-scope or architecture seams remain non-authoritative until the launch contract/ADRs are published in Brain, the plan/entrypoints are repinned, and `accepted-adrs.json` is regenerated. Current source/tests determine actual capability, not roadmap prose.

Planning text never authorizes runtime execution, cloud mutation, dependency changes, source deletion, merge, or deployment. Start implementation only under a bounded user task and owning issue.

## Stable constraints

- Judgment belongs to the model. Do not add regex or other fixed rules for anything that is a judgment call (tone, intent, topic, health vs clinical, what to remember). The harness gives the model context, reasoning room, tools and autonomy. Deterministic rejection is allowed only for hard security and safety boundaries where a reject must be guaranteed: auth, secrets, canaries, owner checks, egress, schema validation, and medication dosing. When you find a fixed rule making a judgment call, file it under `post-mvp-cleanup` or move it to model reasoning with scenario tests.

- One per-owner authority root and one durable writer per aggregate; no competing agent brain.
- Keep `WaldoCoordinator`, the trusted RunLoop/physical effect path, and existing ContextComposer. A new adapter does not become canonical authority.
- App is the first complete presence; inbound email and officially eligible WhatsApp follow the same authority boundary. Later desktop is an executor/presence. Do not impose the older desktop + Telegram + Discord release sequence on this launch.
- Health-aware planning and supported pattern awareness are core launch capabilities. Health sharing is optional per user; missing/revoked health never becomes invented readiness or implicit action authority.
- Preserve ADR-0081 health computation/destination rules and ADR-0082 device lifecycle. New health-pattern persistence, conversation-body storage, standing grants and email-body processing need explicit bounded contract/ADR review where they extend existing decisions.
- Preserve intent-before-I/O, frozen intent/digests, keyed reconciliation, one retry owner, bounded work, cancellation fencing and honest terminal ambiguity. Never run external I/O inside the owning SQLite transaction.
- Activity, Evidence, Verification, Acceptance and Outcome/OpenLoop closure remain distinct. Existing explicit-owner closure rules are not weakened by a standing tool grant.
- Built-in capabilities are not preauthorized actions. Resolve the smallest per-turn capability manifest. Grants are owner/resource/parameter/time/budget scoped, revocable and rechecked before dispatch/resume.
- A Trusted Relationship does not share memory or authority. Each owner independently admits, approves, executes, and accepts its side of a signed, minimal coordination exchange.
- Compile minimum purpose-bound context. Memory is correctable context, not permission. Credentials never enter prompts, logs, fixtures or event payloads.
- Sensitive chat is classified at ingress. Do not persist raw health or forbidden numeric derived values in DO memory, general transcripts, R2, browser jobs or traces. Provider egress must satisfy applicable consent/DPA/Scribe policy.
- Protected voice assets are reviewed source material, not authority to leak numbers or claim actions. Personality cannot override receipts, uncertainty, privacy or current user preferences.
- Published historical protocols retain their offline semantics. New draft/replay/stream behavior requires an additive released contract; no silent widening of v0.1/v0.2.
- Informational conversation does not need a formal Mission/Outcome ceremony, but consequential work uses canonical admission/effects/closure.
- Never infer shipped capability or competitor parity from plans, schema counts, local fakes or model claims.

## Repository responsibilities

`packages/contracts` owns public DTOs, schemas, manifests and fixtures; `packages/runtime` owns runtime, persistence and adapters; `supabase` holds backend-controlled migrations/health data-plane work; `scripts/guards` enforces architecture boundaries. No mobile or marketing implementation belongs here.

Use `docs/README.md` for retained reference material. The September personal-agent build plan, accepted ADRs, released contracts, and current source/tests own live implementation constraints. Old planning snapshots, handoffs, PR descriptions, and Linear/HEY identifiers are historical unless fresh evidence confirms otherwise.

## Working discipline

Inspect fresh source, Git state, owning issue and ledger #116; preserve unrelated work. Name the concrete problem, files/interfaces, canonical writer, privacy/authority impact, tests, falsifiers and rollback before a bounded change. Use TDD for behavior, break rejection/recovery paths, and run independent review when required. Keep schema/migration/Coordinator writers coordinated. Do not re-open the whole architecture without implementation evidence.

Runtime cleanup is not a blanket delete: inventory imports, dynamic callers, build entries, tests, native modules, deployed routes/jobs/bindings and retained migration history; establish generated-client replacement, staging/device parity and rollback first.

## Commands

```bash
git diff --check
npx -y pnpm@10.34.4 verify:guards
# Required full wall for runtime/contracts/integration changes:
npx -y pnpm@10.34.4 verify
```

Use the locked repository environment and actual script definitions. Record PASS, FAIL, NOT RUN and UNAVAILABLE separately at an exact SHA. Do not use `--no-verify`, weaken guards to fit documentation, or describe source-only inspection as tests. External credentials, staging/production mutations and deployment require separate explicit authority.
