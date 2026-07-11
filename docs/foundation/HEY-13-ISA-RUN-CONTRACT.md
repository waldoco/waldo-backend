# HEY-13 ISA Run Contract

Status: implementation complete on 2026-07-11; PR review remains the promotion gate
Issue: [HEY-13](https://linear.app/heywaldo/issue/HEY-13/security-scribe-runtime-sanitiser-boundary-placement-and-article-9)
Branch: `codex/hey-13-scribe-sanitiser`
Base: `407a875a96efe1fc5bac9a1e3cc9f6294c5e3aa5`

## Current

- The contract package owns ADR-0024 vocabulary and pattern constants, but `SanitiseResult` only
  returns a string and no runtime sanitizer implementation exists.
- The runtime hook walks string values only. Object keys and numeric leaves bypass classification.
- Local RunLoop wiring injects an identity sanitizer. Gateway wiring injects a blanket denial.
- Model tool arguments are persisted to `scratch_json` before handler-schema validation and before
  Scribe.
- Provider template floors bypass PostLLM hooks.
- `context_json`, `scratch_json`, trace details, evidence metadata, metric labels, and runtime failure
  reasons admit arbitrary content.
- External taint is not retained in run scratch, so it does not survive iteration or restart.
- `execute_action` and `send_message` expose `user_id` to the model even though invocation context
  owns the authenticated subject.
- Current outbox payloads are strict synthetic opaque tokens. R2, memory merge, public projection,
  and channel writers are not implemented and must not be invented by this slice.
- Baseline at the base commit is green: 1,168 contract tests, 182 Workerd tests, both typechecks, and
  every guard passed on 2026-07-10.

## Ideal

One deterministic, destination-aware Scribe sanitiser Module recursively classifies structured JSON
and is the only content-safety implementation used by hooks, provider requests and outputs, tool
arguments and results, RunLoop checkpoints, trace/replay evidence, and delivery admission. Forbidden
content fails closed before a side effect; accepted content carries only the sanitized payload,
source taint, and count-only redaction evidence.

## Thinking Mode

Mode: First principles + Systems thinking + Red team, with a privacy/health-data pass.
Evidence threshold: accepted ADR text, current contract/runtime source, a red test that demonstrates
each bypass, and a green test through the public interface or actual Workerd owner.
Hypothesis: a pure recursive Scribe Module plus strict destination-owned persisted schemas closes the
failure class without per-writer sanitizer forks.
Falsifier: any current content-bearing side-effect owner can persist or emit a forbidden value without
crossing the Module, or mutation/property tests find a surviving recursion, order, or destination
decision bypass.
Disposition: adopt, subject to the falsifier and reviewer wall.

## Criteria

- [x] **ISC-1:** `sanitise()` returns a strict typed allow/deny union. An allow contains structured
  sanitized JSON, source taint, and count-only redactions. A denial contains no candidate content.
  - Falsifier: an allow can carry non-JSON/unknown fields, or a denial carries payload text.
- [x] **ISC-2:** The Module executes checks in the exact order canary/secret, health, PII,
  instruction, destination policy.
  - Falsifier: an input matching multiple checks reports a later check, or a secret/canary is
    redacted and allowed.
- [x] **ISC-3:** Raw and forbidden derived health cannot pass as keys, strings, numbers, nested
  objects/arrays, CSV, aliases, intervening-word forms, quoted values, BP ratios, or the bounded
  encoded corpus.
  - Falsifier: any generated or golden hostile case is allowed at a prohibited destination.
- [x] **ISC-4:** ADR-0081-eligible nonnumeric derived views retain authority, algorithm version,
  zone/trend, freshness, missingness, confidence band, opaque provenance, and explicit destination
  eligibility.
  - Falsifier: a view is accepted without required provenance or for a destination it does not name.
- [x] **ISC-5:** PII is redacted without storing original values; high-confidence prompt injection
  and medical claims fail closed.
  - Falsifier: email, phone, payment-card, address, IP, diagnosis/risk/prescription/dosage content, or
    a multi-pattern instruction survives output or telemetry.
- [x] **ISC-6:** Tool arguments cross Scribe before `handler.handle`; model-provided subject selectors
  are rejected and handlers derive identity only from authenticated invocation context.
  - Falsifier: a handler observes unsafe args or `user_id` is accepted by the two affected schemas.
- [x] **ISC-7:** Provider requests, gateway responses, and template floors cross the same Module and
  the medical gate. A denial causes zero provider calls or downstream success values as applicable.
  - Falsifier: any template or custom hook registry bypasses Scribe/medical processing.
- [x] **ISC-8:** Runtime context, scratch, taint, trace details, replay evidence, evidence metadata,
  metric labels, and failure reasons use bounded strict schemas.
  - Falsifier: harmless keys such as `measurement` or `metadata` can carry sensitive values, or an
    arbitrary failure string parses.
- [x] **ISC-9:** Sanitizer denial occurs before checkpoint, trace payload, replay payload, outbox
  commit, sink call, or delivery. External taint survives iteration, crash, eviction, and resume.
  - Falsifier: forbidden bytes occur in SQLite/proof/replay or a tainted privileged follow-up runs.
- [x] **ISC-10:** Property and mutation lanes exercise the production Scribe implementation, report
  reproducible seeds, and kill every critical-policy mutant.
  - Falsifier: the tests pass against a fake, a critical mutant survives, or a failing property lacks
    a seed/path.
- [x] **ISC-11 Anti:** No Supabase/migration/RLS, issuer/mint/session, public Brief/OpenAPI/generated
  client, async delivery, Spots, Chat, live-provider, credential, staging, or production-cloud work
  enters the HEY-13 PR.
  - Falsifier: the diff touches an owned/excluded surface or creates an absent production writer.
- [x] **ISC-12 Anti:** No second sanitizer, trace store, provider path, schema authority, or fallback
  runtime is introduced.
  - Falsifier: equivalent policy logic appears outside the canonical contract and Scribe Module.

## Test Strategy

| ISC | Evidence | Tool | Threshold |
| --- | --- | --- | --- |
| ISC-1,2 | strict contract and precedence tests | Vitest, contracts | every invalid arm rejected; precedence exact |
| ISC-3,4,5 | golden corpus + generated JSON/encoding corpus | Vitest + fast-check 4.8.0 | zero hostile allows; replayable seed/path |
| ISC-6 | dispatcher integration through real handlers | Workerd Vitest | handler call count remains zero on denial |
| ISC-7 | provider integration with counted gateway | Workerd Vitest | zero fetch on preflight denial; no unsafe template success |
| ISC-8 | strict-schema negative tests | Vitest, contracts | unknown/unsafe fields and values fail |
| ISC-9 | actual RunLoopDO SQLite/outbox/sink and eviction fixtures | Cloudflare Workers pool 0.16.20 | zero forbidden residue/side effect; taint preserved |
| ISC-10 | production-module property and targeted mutation lanes | fast-check 4.8.0; Stryker 9.6.1 | no critical-policy survivor/no-coverage mutant |
| ISC-11,12 | complete diff and source scans | `git diff`, `rg`, reviewers | no excluded files or parallel policy implementation |

## Work Slices

| Slice | Satisfies | Depends on | Parallel? |
| --- | --- | --- | --- |
| 1. Canonical structured contract | ISC-1,2,4 | accepted ADRs | no; owns vocabulary |
| 2. Pure Scribe and medical Module | ISC-2,3,5,10 | slice 1 | no; owns implementation |
| 3. Hooks/provider/tool seam | ISC-6,7 | slices 1-2 | no; shared runtime paths |
| 4. Strict checkpoint/evidence schemas | ISC-8 | slice 1 | only read-only review parallelism |
| 5. Workerd denial and taint vertical | ISC-9 | slices 2-4 | no; RunLoop single writer |
| 6. Property/mutation and guard wall | ISC-10-12 | all code slices | reviewers may run in parallel |

## Locked, Editable, and Human-Controlled Surfaces

- Locked during the run: ADRs, acceptance criteria, existing guard implementations, synthetic hostile
  corpus expectations, and full verification command.
- Editable: HEY-13 contract/runtime/tests/configuration and the documents listed in the ownership map.
- Append-only: this verification ledger, the SDD scratch ledger, implementation reports, and Linear
  evidence comments.
- Human-controlled: merge, deploy, credentials, live provider, staging/production traffic, and
  destructive cloud operations.

## File Ownership Map

HEY-13 owns these files for this branch:

- `packages/contracts/src/memory/sanitise.ts` and `.test.ts`
- `packages/contracts/src/health/crs.ts` and `.test.ts` only for destination-view metadata; no math
- `packages/contracts/src/runtime/run.ts` and `.test.ts`
- `packages/contracts/src/runtime/evidence.ts` and `.test.ts`
- `packages/contracts/src/testing/evidence.ts` and `.test.ts`
- `packages/contracts/src/telemetry/engagement.ts` and `.test.ts`
- `packages/contracts/src/tools/schemas/reads.ts`, `writes.ts`, and their tests
- `packages/contracts/src/core/hooks.ts` and `.test.ts` only for the Scribe priority at 250
- `packages/runtime/src/scribe/**` and focused tests
- `packages/runtime/src/hooks/registry.ts`, `src/llm/provider.ts`, `src/tools/dispatcher.ts`
- `packages/runtime/src/run-loop/adapters.ts`, `do.ts`, `evidence.ts`, and focused tests
- package manifests, lockfile, Stryker/Node-Vitest configuration, and root verification scripts

Serialized/shared files: contract barrel, hooks, provider, dispatcher, RunLoop, evidence, package
manifests, lockfile, shared fixtures, and DO schema. Sidecars must not edit them.

## Verification Ledger

- 2026-07-10 baseline: `npx -y pnpm@10.34.4 verify` — PASS; 1,168 contract tests and 182
  runtime/Workerd tests.
- 2026-07-10 baseline: `git diff --check` — PASS; no output.
- 2026-07-11 focused Scribe/property lane — PASS; 2 files and 154 tests.
- 2026-07-11 focused medical/provider lane — PASS; 2 files and 70 tests.
- 2026-07-11 whole verification wall — PASS; contracts 48 files / 1,188 tests; runtime 19 files /
  414 tests; both package typechecks and every repository guard passed.
- 2026-07-11 targeted production-module mutation lane — PASS at 100%; 267 mutants, 258 killed,
  9 timed out, 0 survived, 0 uncovered, and 0 errors. The target map was realigned after reviewer
  edits before the score was accepted.
- The repository has no `tools/eval/run-suite.ts`; `/run-eval` therefore records the missing suite
  and uses the complete verification wall as the required fallback. This is an explicit tooling gap,
  not an inferred eval pass.
- Final whole-branch verification and independent reviewer verdicts are recorded in the phase
  handoff after fresh output is read.

## Learning

- An exploratory mutation pass found real CSV/Base64 correlation gaps, but broad full-file mutation
  also produced equivalent defensive-branch mutants. The durable gate therefore names the critical
  observable policy decisions, requires zero survivors/no-coverage mutants, and keeps behavior tests
  for every newly selected decision. This contract and the checked-in Stryker configuration own the
  lesson; no duplicate learning artifact was created.
- Taint is a persisted security identity, not transient metadata. External-origin classification,
  authenticated subject context, checkpoint serialization, restart recovery, and privileged-action
  denial must be tested as one vertical because testing any one seam alone can conceal laundering.

## Source Grounding

Retrieved or revalidated 2026-07-11 unless stated otherwise:

- Backend base `407a875a96efe1fc5bac9a1e3cc9f6294c5e3aa5`.
- Brain base `75591543053dbdda6cf7c7f0210f8d16f36c3db8`.
- Canonical source blobs at that accepted main: ADR-0024
  `17f233bfd8d9c50217ff4130eef1a08b59e9adaf`, ADR-0081
  `f5d993a704b56b9679abfdc308026dc2f669297f`, and medical disclaimers
  `4d4c9937d031a2a5faf0a22df661345fffd491e3`.
- [ADR-0024 at the reviewed commit](https://github.com/Pin4sf/waldo-brain/blob/75591543053dbdda6cf7c7f0210f8d16f36c3db8/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29/0024-scribe-sanitiser-canonical-spec.md).
- [ADR-0081 at the reviewed commit](https://github.com/Pin4sf/waldo-brain/blob/75591543053dbdda6cf7c7f0210f8d16f36c3db8/01-Waldo/Architecture%20Decision%20Records%20%28ADR%29/0081-health-derived-fields-form-crs-computation-authority.md).
- [Medical disclaimers at the reviewed commit](https://github.com/Pin4sf/waldo-brain/blob/75591543053dbdda6cf7c7f0210f8d16f36c3db8/01-Waldo/engineering/agent-soul/rules/MEDICAL_DISCLAIMERS.md).
- [Security rules at the reviewed commit](https://github.com/Pin4sf/waldo-brain/blob/75591543053dbdda6cf7c7f0210f8d16f36c3db8/01-Waldo/engineering/agent-soul/rules/SECURITY.md).
- Zod 4.4.3: [official API](https://zod.dev/api), strict objects, discriminated unions, recursive JSON.
- fast-check 4.8.0: [configuration and replay](https://fast-check.dev/docs/configuration/), released
  2026-05-11 and old enough for the repository's 14-day gate.
- StrykerJS 9.6.1: [Vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/),
  released 2026-04-10; `related: false` is required for indirect integration ownership.
- Cloudflare Workers pool 0.16.20: [Durable Object testing cookbook](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/).

Assumption: “encoded” is bounded to JSON Unicode escapes, percent encoding, and printable UTF-8
Base64/Base64URL, with at most two decode passes, destination caps applied before and after decoding,
and a four-times expansion ceiling. Archives, compression formats, and arbitrary charsets are out of
scope and fail closed when presented as recognized encoded content.
