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
migration's resolved version, name, and ordered `up`/`down` SQL string values, plus its reservation
entry, with a strictly older Git ancestor. An already-based migration cannot be rewritten while a
contiguous suffix can be appended. TypeScript comments, quote style, property layout, and trailing
commas are not executable lineage; SQL string values and statement order are.

Migration SQL must be statically resolvable from string literals, array literals, and top-level
`const` aliases or array spreads composed from those forms. Imported, computed, mutable, cyclic, or
otherwise nonliteral SQL dependencies fail closed. This keeps external SQL constants inside the
historical fingerprint rather than fingerprinting only the visible migration object.

Pull-request CI resolves the actual GitHub base branch. Local checks compare with the merge-base of
`origin/main` by default. A stacked branch must name its immediate base explicitly:

```bash
WALDO_DO_MIGRATION_BASE_REF=origin/<stack-base> npx -y pnpm@10.34.4 verify:guards
```

An unavailable explicit or GitHub base fails closed. The resolved base must be a strict ancestor of
the current `HEAD`; `HEAD`, an equivalent current ref, or a sibling/non-ancestor commit is rejected
to prevent vacuous self-comparison. Renaming a TypeScript constant without changing its resolved
migration semantics is allowed. The reservation record does not authorize new SQL or prove that a
new migration is safe; migration tests and review remain required.
