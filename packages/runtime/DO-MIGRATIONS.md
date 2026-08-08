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

`guard-do-migration-lineage.mjs` blocks duplicate, skipped, reordered, unreserved, or mismatched
version/name entries. The reservation record does not authorize a migration or prove that its SQL is
safe; migration tests and review remain required.
