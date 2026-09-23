---
name: check-contract
description: Verify that current code correctly implements the local packages/contracts contract. Use when wiring DTOs, tool outputs, adapter contracts, runtime journal rows, EF/Worker responses, public schemas, or generated clients.
---

# Check Contract

Verify the current code correctly implements the local `packages/contracts` contract.

## Steps

1. Find the relevant contract module in `packages/contracts/src/`.
2. Read the owning ADR or foundation doc for the seam before trusting type names.
3. Compare every field: type, nullability, naming, enum values, defaulting, and side effects.
4. Confirm the Zod schema is strict at persisted/egress boundaries and exported through `packages/contracts/src/index.ts` when public.
5. Verify database snake_case, runtime journal rows, public DTOs, tool outputs, and channel payloads are converted deliberately instead of leaking internal shapes.
6. Run:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

## Common Violations to Check

- A tool returns raw health fields or measured values instead of derived/redacted summaries.
- A runtime enum is widened in prose but not in the Zod schema and invalid tests.
- Public DTOs are derived with `.pick()` / `.omit()` from internal schemas instead of redeclared.
- A persisted journal/outbox/schedule shape accepts unknown keys or unsafe payload blobs.
- A test asserts the schema accepts the happy path but never proves it rejects the dangerous shape.
- A sibling repo or foundation doc still references a retired package or stale field name.

## Output

Report:

- Contract module and owning ADR.
- Matching fields and invariants.
- Mismatches with exact file/line and fix.
- Validation commands and results.
- Residual downstream checks, if any.
