# HEY-134 Implementation → Isolated Verification Handoff

- Date: 2026-07-11
- Branch: `hey-134-canonical-migrations`
- PR: [#48](https://github.com/Pin4sf/waldo-backend/pull/48) (draft)
- Base: `origin/main` at `7dfc128` (HEY-125 merged)
- Linear: HEY-134 remains **In Progress**
Next dependency: HEY-114 remains blocked until HEY-134 lands or a deliberate stacked-test setup is documented.

## What Was Built

- Restored the five reviewed HEY-9 migrations from historical lineage as timestamped canonical files matching Project Woof's recorded versions.
- Restored the exact HEY-125 staging hardening intent as transitional migration `0006`, conditional on the opt-in `public.rls_auto_enable()` helper existing.
- Added a forward-only reconciliation migration for current contracts:
  - additive ADR-0073 consent fields without fabricating legacy evidence;
  - append-only consent audit history with one allowed `granted → withdrawn` transition;
  - exact source/purpose/18+ consent gating for health writes;
  - opaque text trace identifiers;
  - 64-character lowercase hexadecimal notification idempotency keys;
  - Form/CRS composite, zone, confidence, and four-pillar constraints;
  - final `service_role` grant normalization that revokes Supabase default `ALL` table privileges and re-grants the exact canonical matrix.
- Added 44 pgTAP schema contract assertions covering exact tables, RLS enable/force, tenant isolation, grants, public-function exposure, service-only posture, constraints, cascades, consent failure cases, and cross-tenant FKs.
- Added exact filesystem and database migration-history assertions.
- Added CI-only fixtures that prove transitional `0006` is safe with the helper both absent and present.
- Added a pinned Supabase verification wrapper to `pnpm verify`.
- Added an isolated Linux job to `.github/workflows/verify.yml`, though repository Actions could not be made runnable through the available GitHub permissions/settings.
- Added the current/ideal/gap analysis and human-visible schema reconciliation table in `HEY-134-MIGRATION-RECONCILIATION.md`.
- Added the manual Arch Linux verification procedure in `HEY-134-ARCH-LINUX-VERIFICATION-RUNBOOK.md`.

## What Works, With Evidence

| Surface | Evidence | Result |
|---|---|---|
| HEY-125 dependency | PR #46 squash-merged as `7dfc128`; HEY-134 branch created from that `origin/main` | PASS |
| Historical lineage | Node byte comparison confirmed `0001`–`0005` match `origin/sql-schema@9cb9592` after newline normalization | PASS |
| Static migration inventory | `node scripts/verify-supabase-migrations.mjs` reports exactly seven expected files | PASS |
| TypeScript | `npx -y pnpm@10.34.4 -r typecheck` | PASS |
| Contract suite | 48 files, 1,168 tests | PASS |
| Repository guards | all current guards and guards self-test | PASS |
| Diff hygiene | `git diff --check` | PASS |
| Security review | RLS, grants, identity mapping, service-only tables, functions, secrets, and CI isolation reviewed | PASS; no critical/high/medium finding |
| Health-data review | consent audit immutability and four Form pillar bounds fixed, then re-reviewed | PASS |
| Adversarial QA | exact DB history, exact table/column/function grants, helper paths, and pgTAP plan hardened after review | Static findings resolved; dynamic evidence pending |
| Project Woof read-only audit | Six recorded migrations, helper ACL, security/performance advisors inspected through authenticated Supabase MCP | PASS; no remote mutation |
| Shared-environment safety | No `apply_migration`, linked CLI command, preview branch, staging change, or production change | PASS |
| Arch pgTAP failure investigation | User's Arch runbook reached `supabase test db`; test 13 failed because `service_role` retained default `TRUNCATE`, `REFERENCES`, and `TRIGGER` table privileges on most tables | Root cause found; migration patched |
| Patched local migrate-from-zero and pgTAP | `npx -y supabase@2.109.1 db reset --local --no-seed`; `npx -y supabase@2.109.1 test db`; `node scripts/verify-supabase-migrations.mjs`; `git diff --check` | PASS; 44/44 pgTAP tests |
| Transitional `0006` helper-present fixture | Arch runbook step 11 exposed that `supabase db query --file` rejects multi-command SQL files with `cannot insert multiple commands into a prepared statement`; the fixture was converted to one top-level `DO` block, and reconciliation now repeats the helper ACL normalization idempotently | PASS; helper-present path applies `0006`, hardening assertion returns `DO`, final pgTAP still passes |
| Missing dynamic artifacts | Ashish states that the local security-advisor and post-fix helper-present checks completed successfully without findings | **Operator attestation only**; their logs are not committed and are not independently reproducible from this branch |

## What Does Not Work Yet

### Dynamic migrate-from-zero evidence — BLOCKER

The Windows checkout has no local container runtime, by user choice. GitHub Actions was selected as the isolated runner, but dispatch returned:

```text
HTTP 422: Actions has been disabled for this repository.
```

The authenticated GitHub account `Developerr86` has WRITE but not ADMIN/MAINTAIN permission. Attempts to read or set repository Actions permissions returned `404`. After the user reported enabling Actions, dispatch still returned the same `422` after a propagation wait. No GitHub runner started and no billing prompt occurred.

Ashish will boot the machine's separate Arch Linux installation and execute `HEY-134-ARCH-LINUX-VERIFICATION-RUNBOOK.md`. HEY-134 must not be marked complete until that run proves:

- a fresh local database applies all seven migrations from zero;
- all 44 pgTAP tests pass;
- helper-absent and helper-present `0006` paths pass;
- exact migration history and no-pending-migration behavior pass;
- local Supabase advisors are reviewed;
- the full verification wall is classified.

### Captured-artifact gaps — OPERATOR ATTESTATION ONLY

Ashish attests that the two checks below ran successfully on the isolated Arch Linux
Supabase stack. This is not captured, independently reproducible evidence: their outputs
are absent from `docs/foundation/hey-134-evidence-20260711T131438Z/`.

Missing artifact 1: `advisors-security.log`.

```bash
"${SUPABASE[@]}" db advisors --local --type security --level info --fail-on warn \
  2>&1 | tee "$EVIDENCE/advisors-security.log"
```

Missing artifact 2: the post-fix helper-present replay log set. Regenerate it from a clean
local reset, never with `--linked`:

```bash
"${SUPABASE[@]}" db reset --local --no-seed --version 20260709171953
"${SUPABASE[@]}" db query --local --file supabase/fixtures/create-legacy-rls-auto-enable.sql
"${SUPABASE[@]}" migration up --local
"${SUPABASE[@]}" db query --local --file supabase/fixtures/assert-legacy-rls-auto-enable-hardened.sql
"${SUPABASE[@]}" db query --local --file supabase/fixtures/assert-canonical-migration-history.sql
"${SUPABASE[@]}" migration list --local
"${SUPABASE[@]}" test db
```

These artifact gaps do not authorize a schema change, linked CLI command, Supabase project
mutation, or a claim that the outputs were independently reproduced.

### Known runtime failure — PRE-EXISTING / SHIVANSH-OWNED

The runtime suite reproduces one known failure with 181/182 tests passing:

```text
packages/runtime/test/tracer.test.ts
expected sink.observedDeliveries() to be 0
received 1
```

The observed line number moved as `main` evolved, but the assertion and failure are the known baseline. HEY-134 contains no runtime, Worker, Durable Object, provider, delivery, Spots semantics, or projection edits. Do not modify runtime code to make this schema PR green.

### Eval suite — FOUNDATION GAP

`tools/eval/run-suite.ts` is absent. `/run-eval` therefore triaged to the current verification wall. This ticket changes no prompt, routing, LLM, delivery, memory, or agent-loop behavior.

### Verification status correction — 2026-07-11

The earlier "Dynamic migrate-from-zero evidence — BLOCKER" and runtime-baseline sections
above are historical notes from before Ashish completed the Arch Linux run. They are
superseded by the captured Arch evidence: all seven migrations applied from zero, 44/44
pgTAP passed, helper-absent behavior passed, canonical history and idempotent migration-up
passed, full `pnpm verify` passed with 182/182 runtime tests, performance advisors produced
INFO-only findings, and no shared Supabase environment was accessed.

GitHub Actions remains unavailable, but is no longer a HEY-134 verification blocker because
the isolated Arch Docker run supplied the local evidence. The only remaining evidence gaps
are the security-advisor log and post-fix helper-present replay log, both marked above as
operator attestation only rather than independently captured evidence.

## Architecture Decisions

### Preserve Project Woof migration versions

Supabase migration reconciliation uses timestamp versions. The canonical filenames retain Project Woof's six recorded versions so later drift work can compare environments mechanically.

### Preserve the proven identity seam

Authorization remains:

```text
JWT sub → auth.uid() → public.users.auth_id → public.users.id → app_user_id()
```

Children use the internal `public.users.id`. The incompatible waldo-app direct `auth.users` foreign-key pattern was reconciliation evidence only and was not copied.

### Treat `0006` as transitional hardening

Fresh databases do not contain Supabase's opt-in `rls_auto_enable()` helper. Project Woof does. `0006` therefore:

- never creates a `SECURITY DEFINER` helper;
- succeeds when it is absent;
- revokes PUBLIC, anon, and authenticated execution when it is present;
- preserves the intended service-role execution grant;
- has separate present/absent verification paths.

The forward reconciliation migration repeats this ACL normalization when the helper exists so partial local helper-present replays converge to the same safe privilege state.

This produces documented environment drift: Project Woof alone retains the helper. HEY-114 owns a read-only drift audit and an explicitly approved convergence decision. HEY-134 does not change Project Woof.

### Keep consent history append-only

ADR-0073 makes withdrawal a state transition, not deletion, and requires re-grant as a new record. The forward migration revokes table-level UPDATE/DELETE from `service_role`, grants column-level UPDATE only for `status` and `withdrawn_at`, and enforces exactly one `granted → withdrawn` transition. Parent account deletion still cascades through the audit rows as part of the separate deletion path.

### Normalize service-role default privileges

Supabase grants `service_role` `ALL` table privileges by default when public tables are created. The historical HEY-9 migrations often granted only the intended subset, but those grants were additive and therefore left `TRUNCATE`, `REFERENCES`, and `TRIGGER` in place. The forward reconciliation migration now revokes all `service_role` table privileges after every canonical table exists, then re-grants the exact table and column-level matrix asserted by pgTAP.

### Keep HEY-134 files-only and contract-scoped

The waldo-app schema inventory was used only to identify overlap. HEY-134 does not add app runtime tables, `app_feed_v1`, notification mirror semantics, provider/Worker projections, or any shared database mutation.

## Hard-Won Lessons

- Project migration history and repository filenames must be reconciled by timestamp version, not friendly migration name.
- A hardening migration copied exactly from a configured staging project may fail on a fresh database because staging contains opt-in helpers outside migration history. Both environmental states need explicit tests.
- RLS and grants are separate layers. Exact grant assertions must include every table privilege, column-level withdrawal grants, and execution inherited through PUBLIC.
- PostgreSQL grants are additive. On Supabase, `service_role` may already have `ALL` table privileges, so restricted matrices must explicitly revoke defaults before re-granting the intended subset.
- Supabase CLI `db query --file` can route file contents through prepared execution; CI/runbook fixture files should use one top-level SQL statement or a direct `psql` path.
- Printing `supabase migration list --local` is useful evidence but not a gate. The repository now raises on any mismatch in `supabase_migrations.schema_migrations`.
- Consent-shape checks alone do not preserve audit evidence. Privileges and transition enforcement are both necessary.
- A CI workflow committed to a branch is not evidence until a runner actually executes it.

## Prerequisites for Completion

1. Boot Arch Linux and follow `docs/foundation/HEY-134-ARCH-LINUX-VERIFICATION-RUNBOOK.md` exactly.
2. Return the external `$EVIDENCE/RESULT.md` summary and any failing logs.
3. If a database assertion fails, fix it test-first on this same branch and repeat from zero. Do not repair migration history manually.
4. Run final security/spec review on the resulting diff.
5. Update PR #48 with the migrate-from-zero, pgTAP, advisor, migration-list, and full-wall evidence.
6. Add the evidence summary to Linear HEY-134 and move status only when completion criteria genuinely pass.
7. Generate the final closing/session-bus handoff.
8. Merge HEY-134 before creating a separate HEY-114 branch. If HEY-114 must begin earlier, document a deliberate stacked-test setup; do not combine the PRs.

## Files Changed From `origin/main`

- `.github/workflows/verify.yml`
- `package.json`
- `supabase/config.toml`
- `scripts/verify-supabase-migrations.mjs`
- `scripts/verify-supabase.mjs`
- `supabase/migrations/20260709171312_0001_identity.sql`
- `supabase/migrations/20260709171336_0002_health.sql`
- `supabase/migrations/20260709171359_0003_intelligence.sql`
- `supabase/migrations/20260709171417_0004_comms.sql`
- `supabase/migrations/20260709171953_0005_integrations.sql`
- `supabase/migrations/20260709172043_0006_harden_rls_auto_enable_execute.sql`
- `supabase/migrations/20260710182949_reconcile_contract_spine.sql`
- `supabase/tests/schema_contract.sql`
- `supabase/fixtures/assert-canonical-migration-history.sql`
- `supabase/fixtures/create-legacy-rls-auto-enable.sql`
- `supabase/fixtures/assert-legacy-rls-auto-enable-hardened.sql`
- `docs/foundation/HEY-134-MIGRATION-RECONCILIATION.md`
- `docs/foundation/HEY-134-ARCH-LINUX-VERIFICATION-RUNBOOK.md`
- `docs/foundation/HEY-134-PHASE-HANDOFF.md`

## Continuation Command

After returning to the repository on any machine:

```bash
git fetch origin --prune
git switch hey-134-canonical-migrations
git pull --ff-only
git status --short
```

Do not start HEY-114 from this branch until HEY-134 is merged or the stacked relationship is explicitly documented.
