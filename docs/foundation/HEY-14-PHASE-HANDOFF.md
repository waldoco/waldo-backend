# Phase HEY-14 → HEY-15 Handoff

Status: HEY-14 implementation is ready for a reviewed pull request on
`codex/hey-14-skill-loader-current`; it remains **In Progress** until that PR is reviewed and
merged. Date: 2026-07-12 IST. Merge base: `9055312`.

## [observed] What Was Built

- Canonical opaque REASONS skill fragment/block artifacts and a fixed serializer revision, while
  preserving `wrapSkills()` bytes.
- A private model-attempt budget capability. `RuntimeLLMProvider` mints a new capability for every
  real route attempt and awaits the render callback before request validation/egress.
- A fake-first bounded mutable-skill reader: limited descriptor/head/conditional stream acquisition,
  fatal UTF-8, finite strict frontmatter, trusted `SkillRow` reconstruction, canonical Scribe
  read-admission, complete-cache replacement, current-canary cache-hit re-admission, and generation
  invalidation.
- A deep `RuntimeSkillLoader` that source-merges independently loaded static sources with the reader,
  applies the ADR-0028 filters/ranking/top-K, counts only canonical artifacts, and distinguishes a
  mutable 601-token source-local rejection from global no-fence proof failures.
- Static input provenance is atomic: a malformed or mutable-provenance static dependency drops only
  its declared source. Every candidate is normalized to a frozen exact `Skill` snapshot before
  asynchronous mutable I/O or counter proof; a mutable/static name collision drops the whole
  mutable source.

## [observed] Verification And Review Evidence

- Commits: `f93aeed`, `04a13b8`, `aa3449a`, `cac6c80`, `a6d9480`, `b138338`, `87d49ed`, and
  `d9cc178`.
- Focused contracts serializer suite: 49 files / 1,197 tests passed.
- Focused runtime mutable-reader, loader, and provider suites: each reported 24 files / 625 tests
  passed; all workspace typechecks passed; `git diff --check` passed.
- Independent follow-up security and contract reviews approved the loader hardening. The required
  workflow-map then QA-break pass also passed the reader, loader, and provider failure matrix.
- The standalone eval suite is absent: `tools/eval/run-suite.ts` and a project `eval` command do not
  exist. This is a recorded missing gate, not an eval pass.
- `npx -y pnpm@10.34.4 verify` passed install, all typechecks, and the full contracts suite, then
  stopped at `verify:supabase` because the local Supabase stack is not running (the expected local
  database container was absent). Docker itself is reachable. No service was started and no
  Supabase, Cloudflare, provider, sink, or deployment state was changed.

## [observed] Deliberate Boundaries

- No real R2 mount/binding, Wrangler/configuration change, provider/tokenizer call, prompt-builder
  wiring, writer/commit/discard path, Cloudflare/Supabase operation, deployment, or lockfile change
  was made.
- The reader uses the existing Scribe implementation only; it adds neither a second sanitizer nor
  a sanitizer-vocabulary change. It never writes a read-admitted body back to storage, preserving
  ADR-0076's separate staged writer/commit discipline.
- No raw storage identity, mutable body, prompt, health datum, credential, or secret is introduced
  into the code, fake fixtures, handoff, or telemetry path.

## [inference] What This Establishes

The branch is strong fake-first evidence that the ADR-0083 read-admission and prompt-envelope
contract can be composed without widening the storage or runtime surface. It is not proof of a real
R2 object path, live model counter, provider request, staging environment, delivery sink, or
deployment.

## [observed] Non-Blocking Follow-Up

Duplicate names across separately trusted `systemSkills` and `connectorSkills` are not rejected.
ADR-0022 expects globally unique registry names, but this branch deliberately has no arbitrary
cross-bundle precedence or source-drop policy. This is a P2 registry-hardening follow-up, not a
mutable-content admission bypass and not a blocker for the ADR-0083 fake-R2 matrix.

## [blocked] Next-Phase Gate And Build Order

1. HEY-14 must receive a reviewed PR and merge before HEY-15 starts. Until then HEY-15 is blocked.
2. HEY-16 remains blocked on the merged HEY-14 and HEY-15 interfaces.
3. HEY-143 remains independent and In Progress. It still has no real provider, R2, staging, sink,
   or deployment proof; this branch does not change that fact.

## [proposed] HEY-15 Starting Contract After Merge

Start from fresh `main`, consume the merged private loader/budget seams rather than copying their
logic, preserve the single canonical serializer and current-canary Scribe boundary, and keep any
new state/schema migration work serialized behind HEY-15's own acceptance plan. Re-run the full
fake-first and repository wall before allowing HEY-16 composition.

## [observed] Files Changed In HEY-14

- `packages/contracts/src/prompt/reasons.ts`
- `packages/contracts/src/prompt/reasons.test.ts`
- `packages/runtime/src/skills/budget.ts`
- `packages/runtime/src/skills/mutable-reader.ts`
- `packages/runtime/src/skills/loader.ts`
- `packages/runtime/src/llm/provider.ts`
- `packages/runtime/test/mutable-skill-reader.test.ts`
- `packages/runtime/test/skill-loader.test.ts`
- `packages/runtime/test/llm-provider.test.ts`
- `docs/superpowers/plans/2026-07-12-hey-14-skill-loader.md`
- `docs/foundation/HEY-14-PHASE-HANDOFF.md`
