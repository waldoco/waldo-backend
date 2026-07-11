# HEY-134 Arch Linux Verification Runbook

Purpose: reproduce the HEY-134 isolated Linux verification wall manually on Ashish's Arch Linux installation because GitHub Actions is unavailable.

This runbook tests only disposable local Supabase containers. It must not link to, inspect, or mutate Project Woof, staging, production, a preview branch, or any other hosted Supabase project.

## Safety boundary

Allowed commands in this runbook use only:

- `supabase db start`
- commands carrying `--local`
- the repository's local migration and pgTAP files
- a Docker Engine owned by the Arch Linux installation

Never run any of the following during HEY-134:

```bash
supabase login
supabase link
supabase db push
supabase migration up --linked
supabase migration list --linked
supabase db query --linked
supabase db advisors --linked
```

Do not supply `SUPABASE_ACCESS_TOKEN`, a hosted database URL, a project password, a service-role key, or production/staging secrets. The `project_id` in `supabase/config.toml` is used as a local container namespace; it does not link the checkout to a hosted project.

## 1. Prepare Arch Linux

Run from a terminal after booting Arch Linux.

### 1.1 Install the local prerequisites

Review the package transaction before accepting it:

```bash
sudo pacman -Syu --needed git docker nodejs npm
```

The repository requires Node 22 or newer:

```bash
node --version
npm --version
git --version
docker --version
```

`node --version` must report `v22` or newer.

### 1.2 Start Docker Engine

```bash
sudo systemctl enable --now docker.service
sudo usermod -aG docker "$USER"
```

Log out of the Arch desktop session and log back in, or reboot, so the new group membership applies. Then verify unprivileged access:

```bash
docker info
docker run --rm hello-world
```

Do not continue until both commands succeed without `sudo`. Supabase's CLI needs a Docker-compatible container API.

## 2. Check out the exact HEY-134 branch

Prefer cloning into the Linux filesystem, such as `~/src`, instead of building from the Windows NTFS partition. This avoids permission, case-sensitivity, file-watcher, and container bind-mount inconsistencies.

```bash
mkdir -p ~/src
cd ~/src
git clone https://github.com/Pin4sf/waldo-backend.git
cd waldo-backend
git fetch origin --prune
git switch --track origin/hey-134-canonical-migrations
git pull --ff-only
```

Confirm the branch and clean checkout:

```bash
git branch --show-current
git status --short
git log -1 --oneline
```

Expected branch:

```text
hey-134-canonical-migrations
```

`git status --short` must print nothing. Record the commit printed by `git log`; it will be newer than `3aceae9` because this runbook and the handoff are committed afterward.

## 3. Establish an unlinked, secret-free shell

From the repository root:

```bash
unset SUPABASE_ACCESS_TOKEN
unset SUPABASE_DB_PASSWORD
unset SUPABASE_PROJECT_ID
unset SUPABASE_SERVICE_ROLE_KEY
unset DATABASE_URL

test ! -f supabase/.temp/project-ref
test ! -f supabase/.temp/pooler-url
```

Both `test` commands must exit successfully and print nothing. If either file exists, stop. Do not delete it and continue blindly; use a fresh clone instead.

Define pinned command helpers for this terminal. These arrays preserve argument boundaries safely:

```bash
PNPM=(npx -y pnpm@10.34.4)
SUPABASE=(npx -y supabase@2.109.1)
```

Verify the pins:

```bash
"${PNPM[@]}" --version
"${SUPABASE[@]}" --version
```

Expected versions:

```text
10.34.4
2.109.1
```

## 4. Create an evidence directory

Keep evidence outside the repository so it cannot be accidentally committed:

```bash
EVIDENCE="$HOME/hey-134-evidence-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE"
printf '%s\n' "$EVIDENCE"
git rev-parse HEAD | tee "$EVIDENCE/commit.txt"
git status --short | tee "$EVIDENCE/initial-git-status.txt"
```

For every verification command below, `set -o pipefail` ensures a failure is not hidden by `tee`:

```bash
set -o pipefail
```

## 5. Install repository dependencies

```bash
"${PNPM[@]}" install --frozen-lockfile 2>&1 | tee "$EVIDENCE/pnpm-install.log"
```

Expected result: exit code `0`, with no lockfile modification.

```bash
git status --short
```

The checkout must remain clean.

## 6. Verify the canonical files before starting containers

```bash
node scripts/verify-supabase-migrations.mjs \
  2>&1 | tee "$EVIDENCE/static-migration-list.log"
git diff --check 2>&1 | tee "$EVIDENCE/git-diff-check-before.log"
```

Expected static result:

```text
canonical Supabase migration list verified (7 migrations)
```

The expected ordered migration files are:

```text
20260709171312_0001_identity.sql
20260709171336_0002_health.sql
20260709171359_0003_intelligence.sql
20260709171417_0004_comms.sql
20260709171953_0005_integrations.sql
20260709172043_0006_harden_rls_auto_enable_execute.sql
20260710182949_reconcile_contract_spine.sql
```

## 7. Start from zero and apply the full migration chain

The first start downloads Supabase container images and can take several minutes:

```bash
"${SUPABASE[@]}" db start 2>&1 | tee "$EVIDENCE/db-start-from-zero.log"
```

This starts a disposable local stack and applies all migrations. It does not contact a hosted Supabase project.

Confirm local status:

```bash
"${SUPABASE[@]}" status 2>&1 | tee "$EVIDENCE/local-status.log"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' \
  | tee "$EVIDENCE/docker-containers.log"
```

## 8. Prove repeatable migrate-from-zero and pgTAP contracts

Reset the disposable database to an empty baseline and replay every migration:

```bash
"${SUPABASE[@]}" db reset --local --no-seed \
  2>&1 | tee "$EVIDENCE/db-reset-from-zero.log"
```

Run the 44 schema, RLS, tenant, grant, consent, and failure assertions:

```bash
"${SUPABASE[@]}" test db \
  2>&1 | tee "$EVIDENCE/pgtap-schema-contract.log"
```

Required result:

```text
All tests successful.
Result: PASS
```

The output must report 44 tests with no failed files or assertions.

## 9. Prove migration order, recorded history, and no pending migration

```bash
"${SUPABASE[@]}" migration list --local \
  2>&1 | tee "$EVIDENCE/migration-list-canonical.log"

"${SUPABASE[@]}" db query --local \
  --file supabase/fixtures/assert-canonical-migration-history.sql \
  2>&1 | tee "$EVIDENCE/migration-history-assertion.log"

"${SUPABASE[@]}" migration up --local \
  2>&1 | tee "$EVIDENCE/migration-up-idempotent.log"
```

The list must show all seven local versions applied. The SQL assertion and `migration up` must exit `0`; `migration up` must not apply an eighth migration.

## 10. Test transitional `0006` with the helper absent

The canonical reset already proves the absent state. Confirm it explicitly through the full pgTAP suite:

```bash
"${SUPABASE[@]}" test db supabase/tests/schema_contract.sql \
  2>&1 | tee "$EVIDENCE/0006-helper-absent.log"
```

Required assertion: `fresh canonical databases do not create the Project Woof RLS helper` passes.

## 11. Test transitional `0006` with the helper present

Reset only through historical migration `0005`:

```bash
"${SUPABASE[@]}" db reset --local --no-seed \
  --version 20260709171953 \
  2>&1 | tee "$EVIDENCE/0006-present-reset-through-0005.log"
```

Create the CI-only legacy fixture in this disposable database:

```bash
"${SUPABASE[@]}" db query --local \
  --file supabase/fixtures/create-legacy-rls-auto-enable.sql \
  2>&1 | tee "$EVIDENCE/0006-present-create-fixture.log"
```

Apply `0006` and the reconciliation migration:

```bash
"${SUPABASE[@]}" migration up --local \
  2>&1 | tee "$EVIDENCE/0006-present-migration-up.log"
```

Assert that app roles lost execution while `service_role` retained the intended grant:

```bash
"${SUPABASE[@]}" db query --local \
  --file supabase/fixtures/assert-legacy-rls-auto-enable-hardened.sql \
  2>&1 | tee "$EVIDENCE/0006-present-hardening-assertion.log"

"${SUPABASE[@]}" db query --local \
  --file supabase/fixtures/assert-canonical-migration-history.sql \
  2>&1 | tee "$EVIDENCE/0006-present-history-assertion.log"

"${SUPABASE[@]}" migration list --local \
  2>&1 | tee "$EVIDENCE/0006-present-migration-list.log"
```

Every command must exit `0`. This fixture is deliberately `SECURITY DEFINER`, exists only inside the disposable local database, creates no event trigger, and must never be run with `--linked` or a hosted database URL.

## 12. Restore the canonical helper-absent state

The previous scenario intentionally introduced Project Woof drift. Destroy it by replaying the canonical chain from zero:

```bash
"${SUPABASE[@]}" db reset --local --no-seed \
  2>&1 | tee "$EVIDENCE/final-canonical-reset.log"

"${SUPABASE[@]}" test db \
  2>&1 | tee "$EVIDENCE/final-pgtap.log"

"${SUPABASE[@]}" db query --local \
  --file supabase/fixtures/assert-canonical-migration-history.sql \
  2>&1 | tee "$EVIDENCE/final-migration-history.log"
```

All 44 tests must pass again.

## 13. Run local Supabase advisors

Run both security and performance advisors against only the local database:

```bash
"${SUPABASE[@]}" db advisors --local --type security --level info --fail-on warn \
  2>&1 | tee "$EVIDENCE/advisors-security.log"

"${SUPABASE[@]}" db advisors --local --type performance --level info --fail-on warn \
  2>&1 | tee "$EVIDENCE/advisors-performance.log"
```

Expected security posture: no warning/error. Informational `rls_enabled_no_policy` findings are intentional only for the four documented service-only tables: `agent_logs`, `notification_log`, `oauth_tokens`, and `one_time_tokens`. Record any other finding and stop before claiming HEY-134 complete.

Performance INFO findings must be recorded; WARN or ERROR requires review before completion.

## 14. Run the repository verification wall

The Supabase stack must remain running for `pnpm verify`:

```bash
"${PNPM[@]}" verify 2>&1 | tee "$EVIDENCE/pnpm-verify.log"
VERIFY_EXIT=${PIPESTATUS[0]}
printf 'pnpm verify exit code: %s\n' "$VERIFY_EXIT" \
  | tee "$EVIDENCE/pnpm-verify-exit.txt"
```

The expected schema portion passes. A known pre-existing Shivansh-owned runtime failure may still occur in `packages/runtime/test/tracer.test.ts`, where `observedDeliveries()` is `1` instead of `0`. Do not edit runtime code. If that is the only failure, capture the exact file, assertion, expected/received values, test totals, and exit code as pre-existing evidence.

Run the unaffected checks separately so their status is explicit:

```bash
"${PNPM[@]}" -r typecheck 2>&1 | tee "$EVIDENCE/typecheck.log"
"${PNPM[@]}" verify:node 2>&1 | tee "$EVIDENCE/contracts.log"
"${PNPM[@]}" verify:supabase 2>&1 | tee "$EVIDENCE/verify-supabase-wrapper.log"
"${PNPM[@]}" verify:guards 2>&1 | tee "$EVIDENCE/guards.log"
git diff --check 2>&1 | tee "$EVIDENCE/git-diff-check-final.log"
git status --short | tee "$EVIDENCE/final-git-status.txt"
```

Required results:

- typecheck exits `0`;
- contract suite reports 1,168 passing tests unless `main` has deliberately changed the count;
- `verify:supabase` exits `0` and repeats migrate-from-zero/pgTAP/history/idempotency proof;
- guards exit `0`;
- both Git checks print no changes.

## 15. Stop and remove local containers

After evidence is captured:

```bash
"${SUPABASE[@]}" stop --no-backup \
  2>&1 | tee "$EVIDENCE/supabase-stop.log"
docker ps --format 'table {{.Names}}\t{{.Status}}' \
  | tee "$EVIDENCE/docker-after-stop.log"
```

No Supabase containers for this checkout should remain running.

## 16. Produce the result summary

Create `$EVIDENCE/RESULT.md` outside the repository with:

```markdown
# HEY-134 Arch Linux Verification Result

- UTC timestamp:
- Git commit:
- Arch kernel:
- Node version:
- Docker version:
- Supabase CLI: 2.109.1
- pnpm: 10.34.4
- Fresh migration chain: PASS/FAIL
- pgTAP 44/44: PASS/FAIL
- Helper absent: PASS/FAIL
- Helper present hardening: PASS/FAIL
- Exact migration history: PASS/FAIL
- Idempotent migration up: PASS/FAIL
- Security advisors: PASS/FAIL, findings
- Performance advisors: PASS/FAIL, findings
- Typecheck: PASS/FAIL
- Contracts: PASS/FAIL, count
- Guards: PASS/FAIL
- Runtime: PASS/KNOWN PRE-EXISTING/NEW FAILURE
- git diff --check: PASS/FAIL
- Clean git status: PASS/FAIL
- Shared Supabase access performed: NO
```

Send the result summary and relevant failing log, if any, back to the HEY-134 session. Do not commit generated logs, local keys, `supabase/.temp`, or the evidence directory.

## Troubleshooting

### Docker permission denied

Confirm group membership after logging back in:

```bash
id
getent group docker
docker info
```

Do not work around it by running the entire repository verification with `sudo`; root-owned repository files and containers make evidence harder to reproduce.

### Port already in use

Check the configured local ports and current listeners:

```bash
grep -nE '^(port|shadow_port)' supabase/config.toml
sudo ss -ltnp | grep -E '54320|54322|54323|54324' || true
```

Stop the conflicting local process or use a clean boot. Do not point the CLI at a remote database.

### Container image pull or disk failure

```bash
docker system df
df -h
```

Record the error. Do not substitute a hosted Supabase project to bypass local infrastructure.

### A migration or pgTAP assertion fails

Preserve the complete log and stop. Do not use `migration repair`, edit the migration-history table, loosen an RLS assertion, or apply SQL to Project Woof. Return the evidence for a branch fix and repeat from a fresh reset.
