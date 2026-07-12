# HEY-114 Arch Local Proof Instructions

Status: mandatory manual release-gate instructions for HEY-114. This file does not authorize a hosted Supabase, CI, billing, secret, preview-branch, Waldo-MVP, or production action.

## Approved interim policy

Until hosted CI is restored and evidenced, every Supabase migration PR requires a pinned Arch-local dynamic proof before merge. The proof must establish:

1. fresh migrate-from-zero;
2. the full canonical seven-file migration chain;
3. pgTAP;
4. exact migration history and idempotent migration-up;
5. local security and performance advisors; and
6. a reviewed sanitized evidence summary.

This is a mandatory manual release gate. It is not CI, branch protection, or an automated required check. HEY-168 owns restoration of hosted CI; it is not waived.

HEY-114 remains In Progress. This policy decision does not complete the pending Arch proof or Project Woof staging evidence.

## Safety boundary

Run this only on an Arch host with Docker Engine available to the current unprivileged user. This proof uses local containers only.

Do not run `supabase login`, `supabase link`, any command containing `--linked`, `supabase db push`, `supabase migration repair`, or any remote command. Do not provide a project ref, database URL, password, access token, JWT, service-role key, or private key.

Do not use `tee`, retain raw command transcripts, or commit an evidence directory. The only shareable artifact is the sanitized summary defined below.

## 1. Obtain the exact HEY-114 worktree

```bash
mkdir -p ~/src
cd ~/src
git clone https://github.com/Pin4sf/waldo-backend.git waldo-backend
cd waldo-backend
git fetch origin --prune
git worktree add --detach ../waldo-backend-hey114 64cfb1571f3b763ab47bbefbaf7e058d93988f91
cd ../waldo-backend-hey114

git rev-parse HEAD
git status --short
```

The commit must be exactly `64cfb1571f3b763ab47bbefbaf7e058d93988f91`, and `git status --short` must print nothing.

## 2. Preflight and start the local stack

```bash
docker info

unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_ID \
  SUPABASE_SERVICE_ROLE_KEY DATABASE_URL
test ! -e supabase/.temp/project-ref
test ! -e supabase/.temp/pooler-url

PNPM=(npx -y pnpm@10.34.4)
SUPABASE=(npx -y supabase@2.109.1)

"${PNPM[@]}" --version
"${SUPABASE[@]}" --version
node scripts/verify-hey-114-discipline.mjs
"${SUPABASE[@]}" start
```

Stop immediately if Docker access, any isolation assertion, version check, or discipline check fails.

## 3. Run the dynamic proof and full verification wall

```bash
"${PNPM[@]}" verify

"${SUPABASE[@]}" db advisors --local --type security --level info --fail-on warn
"${SUPABASE[@]}" db advisors --local --type performance --level info --fail-on warn

git diff --check
git status --short
```

`pnpm verify` includes fresh local reset, full migration application, pgTAP, exact history/idempotency checks, typechecks, contract tests, runtime tests, and repository guards. Any failure is a stop condition. Do not use `migration repair`, alter migrations, relax assertions, or substitute a hosted project.

## 4. Generate only a sanitized evidence summary

Create and manually complete this file. Do not paste raw command output into it.

```bash
umask 077
cat > "$HOME/hey-114-arch-summary.md" <<'EOF'
# HEY-114 Arch Local Proof

- Commit: 64cfb1571f3b763ab47bbefbaf7e058d93988f91
- pnpm version:
- Supabase CLI version:
- Fresh migrate-from-zero: PASS/FAIL
- Canonical seven-file chain: PASS/FAIL
- pgTAP: PASS/FAIL; count:
- Exact migration history/idempotency: PASS/FAIL
- Security advisors: PASS/FAIL; highest severity:
- Performance advisors: PASS/FAIL; highest severity:
- Full verification wall: PASS/FAIL; stage reached:
- git diff --check: PASS/FAIL
- Clean Git status: PASS/FAIL
- Shared Supabase access performed: NO
EOF

nano "$HOME/hey-114-arch-summary.md"
```

The summary may contain only the listed fields. It must contain no logs, URLs, project identifiers, credentials, tokens, user data, or health data.

## 5. Stop and clean up

```bash
"${SUPABASE[@]}" stop --no-backup
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

No Supabase container from this proof may remain running.

## After a successful Arch proof

Provide only the sanitized summary to the HEY-114 reviewer. The next safe step is local authentication followed by a read-only Project Woof inventory. Do not apply the pending migration, change `statement_timeout`, create a project, enable branching, add a secret, restore Actions, or modify any shared environment until the observed staging approval packet is returned and explicitly approved.
