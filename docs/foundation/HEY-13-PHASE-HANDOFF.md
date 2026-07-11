# HEY-13 Scribe Runtime Handoff

Status: implementation and local proof complete on `codex/hey-13-scribe-sanitiser`; Linear remains
In Progress until PR review. No merge, deployment, live-provider call, credential use, staging
traffic, or production cloud effect was performed.
Date: 2026-07-11 IST.
Audit closure started from reviewed PR head `3f754957` on `origin/main` `7dfc128`.
Review: [waldo-backend PR #47](https://github.com/Pin4sf/waldo-backend/pull/47).

## [observed] Implemented

- One contract-owned, destination-aware Scribe API returns a strict content-free denial or a
  sanitized structured payload with source taint and count-only redaction evidence.
- The runtime Module applies canary/secret, Article-9 health, PII, instruction, and destination
  checks in the required order. It covers nested keys/values, numeric and scientific forms,
  categorical health, raw-series envelopes, bounded JSON/percent/Base64/Unicode decoding, and
  compact IPv6.
- ADR-0081 nonnumeric health views require the complete authority/version/freshness/missingness/
  confidence/provenance/destination envelope; partial health-view markers deny.
- The immutable medical gate covers diagnosis/risk/symptom language, direct treatment, dosage,
  units/IU, injection, and dose changes at pure, provider-response, and template terminals.
- Terminal Scribe hooks protect tool arguments/results and provider request/response/template
  paths. Authenticated subject context is mandatory, model subject selectors reject, and external
  success/failure provenance survives the dispatcher.
- Strict persisted schemas and the actual RunLoop owner protect context, scratch, evidence, trace,
  replay, metrics, scheduled ingress, outbox admission, and delivery. External taint survives
  checkpoint, eviction, restart, and blocks privileged follow-up execution.
- Sandbox stdout truncation preserves the structured PostToolUse result envelope and the canonical
  ADR-0024 marker while respecting the 10 KB serialized cap.
- Direct Tracer start and held-candidate release now cross the same strict schema → Scribe → strict
  schema preparation before any journal, governor, candidate, or reopened-run write. Unsafe held
  rows are scrubbed rather than reactivated.
- Existing recognized pre-Scribe RunLoop rows are upgraded with `source_taint: null` and re-sanitised
  on owner startup. Malformed or forbidden legacy rows are content-scrubbed and moved to the closed
  `FAILED` state before resume.
- Health discriminators correlate with arbitrary numeric sibling keys across nested objects and
  arrays, including bounded percent/Base64/Unicode encodings. Sensitive structured keys and bare
  `sb_secret_…` tokens fail closed, and fractional tablet/capsule/dose instructions reach the
  immutable medical gate.
- Operational schedule and user references are validated as opaque IDs before content sanitation;
  PII-shaped identifiers reject rather than being rewritten into a different persistence owner.

## [observed] Verification

- `npx -y pnpm@10.34.4 verify`: PASS — contract typecheck and 48 files / 1,188 tests; runtime
  typecheck and 19 files / 485 tests; all guards and guard self-tests passed.
- `pnpm --filter @waldo/runtime test:property`: PASS — 3 files / 235 production-module tests.
- `pnpm --filter @waldo/runtime test:mutation`: PASS — 351 selected critical-policy mutants;
  342 killed, 9 timed out, 0 survived, 0 uncovered, 0 errors; 100% score. The target includes
  27 medical-gate mutants, closing the prior mutation-runner coverage gap.
- Workerd integration proves health, canary, and secret denial leaves no candidate bytes in
  checkpoints, trace details, replay, outbox, or sink delivery.
- `git diff --check origin/main`: PASS.
- The branch rebased cleanly onto `origin/main` `7dfc128`; property, mutation, full verification,
  and `git diff --check origin/main` all passed again after the rebase.
- The eight counterexamples reported against `3f754957` are reproduced by regression tests and now
  deny or fail safely. Strict caller schemas remain the exact field allowlists per the accepted
  design; Scribe remains the single content-policy implementation rather than duplicating field
  vocabularies in a second global table.
- Final read-only contract/standards, workflow/security/QA, and health-data/medical reviewers all
  returned PASS on the combined audit-closure diff. Their last pass explicitly covered terminal
  candidate scrubbing and state-only recovery from a failed delivery journal without a candidate.
- The standalone eval runner `tools/eval/run-suite.ts` is absent. Per `/run-eval`, this is recorded
  as a tooling gap and the complete verification wall is the fallback; it is not reported as an
  eval-suite pass.

## ADR And Linear Alignment

- ADR-0024 blob `17f233bfd8d9c50217ff4130eef1a08b59e9adaf` owns check order, boundary behavior,
  failure semantics, and sandbox truncation.
- ADR-0081 blob `f5d993a704b56b9679abfdc308026dc2f669297f` owns the exact health field/destination
  matrix and strict nonnumeric derived-view metadata.
- Medical disclaimer blob `4d4c9937d031a2a5faf0a22df661345fffd491e3` owns immutable never-claim language.
- HEY-13's seven acceptance items are implemented and locally proved. The issue intentionally stays
  In Progress until human PR review; downstream issues remain blocked until that promotion.

## [not built] Boundaries Preserved

- No Supabase schema, migration, RLS, issuer/session, public Brief/OpenAPI/client, app/native,
  async delivery, Spots, Chat, or live provider surface was added.
- `execute_code` remains typed but has zero V1 ACLs. This slice proves its PostToolUse sandbox
  sanitation contract without making the tool dispatchable.
- No raw health source, canonical Form computation, R2 writer, generic memory merger, public
  projection, channel adapter, credential, or production fallback was invented.

## Next Owner

Review the HEY-13 PR and keep Linear In Progress until approval. After promotion, downstream work
may consume the Scribe/taint seam but must not weaken destination schemas, reintroduce a parallel
sanitizer, or treat successful local proof as live-provider/staging evidence. The missing standalone
eval runner remains follow-up infrastructure rather than hidden HEY-13 completion work.

## Learning

- Mutation targets must be realigned after line-moving security repairs; accepting a stale 100%
  score is a false green. Selected decisions remain paired with behavior tests and require zero
  survivors/no-coverage mutants.
- Health leakage is not only numeric. Categorical state, raw sample envelopes, scientific notation,
  partial derived views, and provider-controlled failure text need first-class adversarial fixtures.
- Generated mutation reports can reproduce hostile corpus literals. Keep detailed mutation evidence
  in terminal output because repository privacy guards intentionally scan ignored files too.
