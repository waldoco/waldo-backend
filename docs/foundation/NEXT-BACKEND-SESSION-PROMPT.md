# Next Backend Session Prompt — Responsibility Handshake

Copy the prompt below into a new Codex session rooted at `waldo-backend`.

---

We are beginning implementation of Waldo's durable responsibility backbone.

The product promise is:

> A person can tell Waldo, “Make sure this gets handled,” and Waldo carries the responsibility until the real-world result is verified, accepted, reopened, or consciously released—without taking control away from the person.

This session is authorized to implement the first bounded backend dependency: the responsibility-handshake subset of cross-repository protocol v0.1 and its golden fixtures in `@waldo/contracts`. Do not implement runtime ingress, Durable Object persistence, domain reducers, connectors, provider execution, or Kennel code in this session.

## Start safely

1. Read `AGENTS.md` and every universal rule it requires.
2. Run `git status -sb`, inspect worktrees, fetch `origin/main`, and record the exact fetched SHA.
3. Preserve every dirty checkout. If this handoff has merged, create a dedicated clean worktree and a branch named with the `codex/` prefix from current `origin/main`. If it is still on a documentation branch, base the implementation branch on that branch so this prompt and its architecture refresh remain in history; record the divergence from `origin/main`.
4. Treat plans as target intent, not shipped truth. Inspect current `packages/contracts` source, exports, tests, fixtures, package scripts, and existing public error schemas before designing files.

## Required reading

Read these completely, in this order:

1. `docs/planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md`
2. `docs/planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md`, especially §§1.1, 3, 4, 5, 6, 9.2, and 14
3. `docs/planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md`, especially §§1, 3, 5, 11, 12, 14, 15, and 16.1
4. `docs/foundation/CONTRIBUTOR-ONBOARDING.md`
5. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
6. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`

Use `/waldo-isa-run-contract` or `/current-ideal-gap` to define done, then `/codebase-design` and `/domain-modeling` for the seam, `/tdd` for implementation, `/check-contract` before completion, and `/break-feature` for the adversarial pass. If the repo-specific planner/workflow-mapper agents are callable, use them as required by `AGENTS.md`; otherwise include the same dependency and failure-path analysis in the run contract and record that substitution.

## Observable outcome

At the end of this session, backend and Kennel engineers can consume one canonical, strict, versioned protocol definition plus committed golden JSON fixtures for the first responsibility handshake:

1. a presence submits an untrusted responsibility-capture command;
2. the gateway-enriched trusted envelope shows which fields only the server may create;
3. a presence declares protocol `"0.1"` and `offlineCommands: "none"`;
4. a canonical projection page carries snapshot and cursor metadata;
5. executor/session activity, judgment-needed, and candidate-evidence examples remain untrusted observations and cannot imply verification, Acceptance, or closure.

This is contract/conformance proof only. Do not claim a canonical Outcome can yet be persisted or that Kennel is integrated.

## In scope

- Add the smallest coherent protocol v0.1 module under `packages/contracts/src`, following current repository naming and Zod conventions after inspection.
- Export strict schemas and inferred types for:
  - `SurfaceCommandRequest`;
  - `TrustedCommandEnvelope`;
  - `PresenceCapabilityV01`;
  - `DomainEvent`;
  - `ProjectionPage`;
  - the minimum aggregate/actor references needed by those envelopes.
- Use the exact locked fields and trust boundary from architecture §§4/5. Do not introduce a parallel identity, task, run, permission, memory, or completion ontology.
- Reuse the existing content-free public problem contract if it satisfies the boundary; extend it only if a precise protocol error code is required and remains non-enumerating.
- Add committed golden fixtures for:
  - a valid responsibility-capture request with a minimal non-authoritative payload;
  - its server-enriched trusted envelope;
  - strict rejection of top-level client attempts to provide `ownerId`, actor role, target Durable Object/routing, `AuthorityGrant`, credential, provider/model selection, Acceptance, or closure;
  - `offlineCommands: "none"` and rejection of any offline queue/create capability;
  - a valid projection snapshot/page and fixture pairs for duplicate cursor delivery, a cursor gap, snapshot replacement, and owner/account switch;
  - duplicate `requestId` inputs that produce the same trusted request digest and a changed digest. These are conformance inputs only; do not implement gateway replay or effect behavior here;
  - provider/session activity, judgment-needed, and candidate-evidence observations that contain no raw transcript, credential, unrelated personal context, or raw health data.
- Add exact semantic tests for strictness, required server-owned fields, version literal, non-negative/ordered cursor structure, digest format, fixture parseability, sensitive-field rejection, and deterministic fixture freshness.
- Export the new protocol surface from `packages/contracts/src/index.ts`.
- If a small generated JSON Schema artifact and freshness check fit the existing package conventions, include them. Do not add a new code-generation framework, Swift/Kotlin bindings, package publication pipeline, or protocol registry in this issue; record those as the next cross-repo distribution dependency.

## Explicitly out of scope

- `WaldoCoordinator`, `OutcomeModule`, state-machine reducers, tables, migrations, routing, or public gateway handlers;
- changing `RunLoopDO`, retry/effect behavior, authority consumption, or existing trusted-runtime semantics;
- full Outcome/Mission/WorkUnit/Judgment/Evidence/Acceptance/OpenLoop schemas;
- a Kennel client or changes in the Kennel repository;
- provider, connector, Cloudflare Computer, workspace, DeepWiki, MCP, UI, or local-LLM work;
- resolving ADR-0077/ADR-0082 by silently retaining or removing offline drafts;
- broad refactors, dependency upgrades, or renaming current runtime false friends into target product types.

## Non-negotiable invariants

- A surface request is untrusted and cannot choose owner identity, authority, credentials, provider/model, Acceptance, or closure.
- Authorization fails closed.
- Protocol v0.1 is online-only: `offlineCommands: "none"`.
- User statements and corrections outrank inference.
- Raw health data, credentials, full transcripts, and unrelated personal context do not enter fixtures.
- Agent activity, provider `done`, Evidence, Verification, Acceptance, and Open Loop closure remain separate.
- The backend is the future canonical writer; these contracts must not grant Kennel or another presence product-truth authority.
- Do not claim current/previous compatibility by inventing protocol 0.0. Record previous-version compatibility as `not_run` until a previous supported release exists.

## Required tests and evidence

Use red-green-refactor and run at minimum:

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/contracts typecheck
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 verify
git diff --check
```

Also run the repository guard command documented by the current package scripts. If a gate is unavailable, distinguish `failed`, `skipped`, `unavailable`, and `not_run`; do not report it green.

Before completion:

1. run `/check-contract`;
2. run `/break-feature` against privileged-field smuggling, unknown keys, wrong versions, malformed timestamps/digests, cursor gaps/duplicates, owner switches, oversized examples, and sensitive fixture content;
3. inspect the final diff for unrelated edits and generated residue;
4. update only the canonical handoff/build documents if implementation evidence changes their delivery status;
5. commit the scoped work and open a ready PR only after every required local gate passes.

## Final report

Return:

- pinned starting SHA and clean worktree/branch;
- observed pre-change contract surface;
- exact files and contract semantics added;
- fixture catalogue and trust-boundary negatives;
- commands with pass/fail/not-run results;
- privacy/security review;
- rollback boundary;
- honest delivery level achieved;
- the next backend reducer issue and the parallel Kennel consumer issue that these fixtures unblock.

Do not expand the scope to “build Waldo.” Complete this contract seam cleanly so the Outcome reducer and Kennel protocol client can start in parallel without inventing divergent shapes.

---
