---
name: check-contract
description: Verify that current code correctly implements the @waldo/types contract. Use when wiring a new EF response, tool output, or adapter implementation to ensure shapes match the shared types.
---

# Check Contract

Verify the current code correctly implements the `@waldo/types` contract.

## Steps

1. Find the relevant interface in `../waldo-types/src/` for what's being implemented
2. Compare every field: type, nullability, naming (camelCase in types, snake_case in DB)
3. Check the Zod schema in `../waldo-types/src/zod/` exists and is used at the boundary
4. Verify the EF response envelope matches `EFResponse<T>` wrapper
5. Run `npm run check` — zero TypeScript errors required

## Common Violations to Check

- EF returns `form_score` but interface expects `score` — name mismatch
- Tool returns raw `hrv_overnight_ms` — should be derived summary string only
- Missing `null` handling — HealthDaily fields are nullable, never assume present
- `TodayResponse.load.score` is a number 0-21, not a percentage

## Output

Report: which fields match ✓, which fields mismatch ✗, exact fix for each mismatch.
