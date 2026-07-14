# HEY-114 Disposable Proof Slice Handoff

## What Was Built

- A fresh proof branch from `origin/main` at `fd663b65305973f19c318bb8acad067cc6798493`.
- A sanitized migration manifest and remote evidence result for disposable project `dxnyspxjcqejbykfcyxk`.

## What Works

- Exact project identity, empty application baseline, seven ordered migrations, 16-table forced-RLS posture, exact table grants, own-row access, cross-user denial, service-only denial, client-write denial, stable history, advisors, and zero synthetic residue were observed through MCP.

## What Does Not Work Yet

- **MEDIUM, merge-blocking:** The committed 44-assertion database contract passed only 42 assertions. Hosted-project default privileges left `anon` EXECUTE on three public functions. No cross-user bypass was demonstrated.
- **NOT PROVEN — proof-method limitation:** MCP-generated migration versions differ from repository timestamp versions. Exact SQL names, order, and hashes are preserved; a fresh project plus CLI `db push` is required for canonical drift/no-pending evidence.
- **LIMITED:** A second apply/idempotency cycle was not authorized, and the project Data API exposed-schema setting was not observable through this MCP session.

## Decisions

- Preserve the failed evidence without patching migrations, repairing history, resetting the project, or weakening tests.
- Require a separately reviewed forward migration for hosted-project function ACL normalization.
- Preserve this project as failure evidence; use a second fresh project and CLI `db push` only after separate approval.

## Next Steps

1. Review the function-ACL gap and design a forward-only migration test-first.
2. Obtain separate approval before any destructive disposable-project reset or second migration cycle.
3. Complete the independently gated Project Woof inventory, staging approval/evidence, production identity, and HEY-168 hosted-CI follow-up.

## Files Changed

- `docs/foundation/HEY-114-DISPOSABLE-PROOF-RESULT.md`
- `docs/foundation/HEY-114-DISPOSABLE-PROOF-HANDOFF.md`
- `docs/foundation/hey-114-disposable-proof-migrations.sha256`
