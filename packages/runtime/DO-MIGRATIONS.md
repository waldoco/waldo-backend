# Durable Object migration allocation

`do-migration-reservations.json` is the committed allocation record for the executable chain in
`src/do-schema.ts`. Migration versions are assigned when implementation is rebased for integration,
not in issue plans.

For every migration-bearing change:

1. Rebase onto current `origin/main`.
2. Append one reservation using the current maximum version plus one.
3. Add the matching migration to `DO_SCHEMA_MIGRATIONS` in the same change.
4. If another migration lands first, rebase and renumber before review.
5. Let one merge captain serialize migration-bearing changes.

`guard-do-migration-lineage.mjs` parses the executable TypeScript chain and blocks duplicate,
skipped, reordered, unreserved, or mismatched version/name entries. It also compares every existing
migration initializer's executable tokens and reservation entry with the Git merge-base, so an
already-based migration cannot be rewritten while a contiguous suffix can be appended. Comments and
formatting are not executable lineage.

Pull-request CI resolves the actual GitHub base branch. Local checks compare with the merge-base of
`origin/main` by default. A stacked branch must name its immediate base explicitly:

```bash
WALDO_DO_MIGRATION_BASE_REF=origin/<stack-base> npx -y pnpm@10.34.4 verify:guards
```

An unavailable explicit or GitHub base fails closed. Renaming a TypeScript constant without changing
its migration initializer is allowed. The reservation record does not authorize new SQL or prove
that a new migration is safe; migration tests and review remain required.
