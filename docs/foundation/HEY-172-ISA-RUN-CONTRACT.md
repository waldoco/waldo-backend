# HEY-172 — Surface-Neutral Trusted Invocation ISA Run Contract

**Tracker source of truth:** [HEY-172](https://linear.app/heywaldo/issue/HEY-172/harness-surface-neutral-trusted-invocation-contract). This is the implementation-run evidence for that issue, not a second acceptance specification.

## Current

- [observed] `packages/contracts/src/runtime/run.ts` binds `RuntimeRunContext.source` to
  `fake-derived`, binds durable tool-call/result summaries to `get_crs`, and makes run identity
  directly from `user_id` and `trigger`.
- [observed] `packages/runtime/src/run-loop/do.ts` still constructs that fake context and a brief
  trigger. It is intentionally outside this issue's allowed surface.
- [observed] the existing dispatcher owns per-tool argument/result validation, ACL, approval,
  taint, sanitisation, size, and audit enforcement. A new contract must not duplicate or weaken
  that enforcement.
- [observed] ADR-0068 makes DeliveryGate a proactive-output concern; it must not classify a
  solicited reply as a proactive push.
- [observed] persisted Durable Object rows can contain the existing fake-derived/get_crs shapes.
  Replacing those shapes in place would make this contract-only lane unsafe.

## Ideal

Every external surface can parse its own transport but normalizes it through one strict,
surface-neutral vocabulary before the runtime. Authenticated ingress or a trusted scheduler alone
binds opaque principal/tenant, content references, trusted intent/occurrence, and an idempotency
basis. The runtime receives a durable-safe envelope, not surface-controlled authority.

The vocabulary distinguishes a solicited response, a proactive delivery candidate, and internal
work without committing a channel payload, a synchronous sink, a provider, a spend decision, a
tool permission, or a DeliveryGate policy. Context and tool summaries carry opaque references and
proof metadata, never raw health values, request content, secrets, or executable arguments.

## Selected Decision

Create one deep contracts module at `packages/contracts/src/runtime/invocation.ts` with three
operations:

1. `parseSurfaceInvocationRequest(request)` accepts only bounded, transient surface content and a
   retry hint. It is deliberately not durable; the trusted envelope is content-free.
2. `acceptTrustedInvocation(admission)` derives the canonical envelope, output disposition, and
   runtime binding from a strict trusted admission. Authentication, scheduler verification, input
   staging, and opaque-ref minting remain adapter responsibilities.
3. `canonicalInvocationIdempotencySerialization(envelope)` creates deterministic material which
   the runtime can hash into a run identity.

The derived binding projects only trusted intent into existing trigger/variant vocabulary. The
downstream runtime owns loop/Governor resolution and fresh ACL derivation. The surface request
schema has no authority fields. No `RunPort` or ingress port is added because this slice contains
no two concrete execution adapters.

`acceptTrustedInvocation` validates a trusted-admission *shape*; it does not authenticate an
HTTP body or mint its opaque references. A real ingress/scheduler adapter must authenticate,
stage content, mint the evidence, and only then call this contract. The surface parser cannot
produce an admission, and a later adapter must never pass a request body to trusted admission.

Disposition is classification, not tool authority. The later execution/delivery lane must derive
the trigger ACL afresh and must refuse a final user-visible sink for `internal_no_output`; this
contract intentionally carries neither a sink nor a payload and therefore does not inspect one.

### Design It Twice record

- **Rejected minimal packet with a separate output planner:** it is compact, but a separate planner
  creates a tempting future authority path for callers to choose disposition.
- **Rejected closed command/event vocabulary:** it gives strong replay facts, but would add a
  heavier parallel event vocabulary beside the current journal before a writer exists.
- **Selected caller-first admission:** it localizes authentication-derived authority at the
  ingress seam, derives disposition at admission, and keeps a small data-only interface.

Red-team adjustments to the selected design:

- idempotency is an explicit trusted basis in the envelope, never an arbitrary transport key;
- output disposition is derived from authenticated-request, trusted-schedule, or trusted-internal
  admission, never independently caller planned;
- the V2 vocabulary coexists with an explicit V1 reader rather than claiming fake provenance is
  real provenance.

## Stable ISC Criteria

| ID | Criterion | Named falsifier |
| --- | --- | --- |
| ISC-1 | Strict untrusted requests exclude unknown, authority, and surface-specific fields. | A body containing `user_id`, `trigger`, `provider`, `channel`, `cli`, or `mcp` parses. |
| ISC-2 | Only trusted admission supplies opaque principal/tenant, content refs, intent, occurrence, and idempotency basis. | Equivalent app/CLI/MCP fixtures normalize to different envelope or identity material. |
| ISC-3 | Exactly one derived disposition exists: `solicited_reply`, `proactive_delivery`, or `internal_no_output`. | A solicited reply reaches proactive budget/DeliveryGate semantics. |
| ISC-4 | V2 context provenance records opaque refs, closed scope/taint, and production time without raw health data. | V2 accepts `fake-derived`, arbitrary payload, or unstamped external provenance. |
| ISC-5 | Generic checkpoints are post-dispatch hashes/refs plus guard proof, not executable tool requests. | A completed checkpoint lacks validation/ACL/approval/taint/sanitisation/size/audit proof. |
| ISC-6 | Current fake-derived/get_crs rows remain readable only through explicit legacy support. | A valid V1 row becomes unreadable or a mixed V1/V2 row parses. |
| ISC-7 | Trusted mapping reaches existing trigger/Governor vocabulary without exposing trigger ACL. | A surface chooses tool permissions, loop, owner, DO, provider, routing, or spend. |
| ISC-8 | The diff remains contracts-only and dependency direction stays inward. | A contracts file imports runtime or this lane adds delivery/provider/CLI/MCP/Supabase implementation. |

## Anti-Criteria

- Do not change `packages/runtime/src/run-loop/do.ts` or `run-loop/adapters.ts`.
- Do not alter DeliveryGate, outbox, provider, spend, ContextComposer, tool-handler, CLI/MCP, or
  Supabase implementations.
- Do not add a channel payload, push class, provider/model/routing selector, subscription tier,
  Durable Object identifier, tool permission, safety outcome, or delivery-policy field.
- Do not write raw health values, user content, secrets, or raw tool arguments/results into durable
  fixtures, provenance, or checkpoints.
- Do not silently migrate persisted rows, add another journal/store, or introduce a speculative
  `RunPort`.

## Test Strategy

1. Start with focused contract tests before the source module exists, then add the smallest schema
   and function behavior needed to turn each slice green.
2. Table-drive every forbidden authority and transport field, including nested unknown keys and
   content-free error assertions.
3. Use test-only CLI, MCP, and app ingress adapters with the same trusted occurrence/input fixture
   to prove byte-identical envelopes and canonical identity material.
4. Test the three-output truth table and assert only proactive output has DeliveryGate/budget
   applicability; all visible output remains safety/egress subject downstream.
5. Test V2 provenance aggregate taint, opaque reference grammar, sanitiser probe, and rejection of
   raw-payload-shaped fields without placing health data in fixtures.
6. Test V1 fake-derived/get_crs decode, malformed V1 rejection, V2 rejection of legacy values, and
   mixed-format rejection.
7. Add generic checkpoint examples plus property tests across the closed tool vocabulary. The named
   mutation candidate removes the completed-checkpoint sanitisation or audit refinement; the
   property suite must kill it.
8. Verify exports and no contracts-to-runtime dependency; then run focused tests, typecheck,
   relevant repeated runtime tests, `/check-contract`, `/break-feature`, two-axis review, diff
   checks, and the repository verify wall.

## Vertical Slices

1. **Admission and identity:** failing strict-request/cross-surface tests; implement opaque refs,
   trusted admission, deterministic identity, and runtime binding.
2. **Output classification:** failing truth-table tests; derive the exclusive dispositions and
   expose only policy applicability, not delivery behavior.
3. **Context and compatibility:** failing V2 provenance/legacy decoder tests; implement explicit
   V1 coexistence without changing the run loop.
4. **Generic tool checkpoint:** failing guard/property tests; implement reference/hash-only
   checkpoint refinements and export the module.
5. **Verification and review:** test adversarial falsifiers, contract alignment, dependency
   direction, delivery-PR non-overlap, and full repository gates.

## Verification and Reversibility

- Architecture sources: accepted ADR-0002, ADR-0024, ADR-0029, ADR-0033, ADR-0049, ADR-0051,
  ADR-0054, ADR-0068, ADR-0069, ADR-0074, and ADR-0077 at
  `waldo-brain@75591543053dbdda6cf7c7f0210f8d16f36c3db8`.
- Read current contracts and runtime consumers; compare PR #61 before publication. If #61 has
  merged, rebase onto the new `main`; otherwise prove the file sets do not overlap.
- Publication preflight (2026-07-15): PR #61 remains open and clean at
  `14a020e60ded7a1a8b0882b00ae2a13d4bf7274c` against
  `origin/main` `fd663b65305973f19c318bb8acad067cc6798493`. Its only contracts files are
  `runtime/delivery-policy.*`; this lane changes `runtime/invocation.*`, the contracts barrel,
  and this run contract, so it has no delivery-policy/outbox overlap and may review independently.
- Run the contracts test target, workspace typecheck, affected runtime tests, guards, the local-only
  Supabase verification path invoked by the repository verify wall, and `git diff --check`.
- The change is additive and contracts-only. Rollback is a revert of the module/export/doc;
  existing V1 rows remain readable because no DO migration or writer change occurs here.

## Learning Capture Decision

**No new artifact.** The overlap check found the reusable rule already owned by ADR-0029 and
`/check-contract`: persisted/public schemas must be strict and independently enforce their
derivations at the parse boundary. The direct-envelope regressions in this issue are the local
evidence; a second rule or ADR would duplicate that owner. Applicability is limited to a future
writer or ingress adapter that consumes this vocabulary, where its own boundary tests must retain
these invariants.
