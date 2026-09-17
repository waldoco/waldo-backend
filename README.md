# Waldo Backend

The canonical owner-side runtime for Waldo: one user-governed personal agent with strong memory, a distinctive personality, health-aware planning, authorized actions, and continuity across the Waldo app and WhatsApp. Desktop integration follows through the same authority boundary.

## Read first

1. [Reconciled personal-agent launch contract — pinned Brain revision](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md): one cross-repository scope, capability/grant matrix, health/memory/personality contract, M0-M8 map and release gates.
2. [Next session](docs/foundation/NEXT-SESSION-PLAN.md): this repository's execution entrypoint and current source baseline.
3. [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), and [.claude/rules/INDEX.md](.claude/rules/INDEX.md): engineering and protected-boundary rules.
4. The relevant accepted ADRs, released schemas, exact issue/PR and current source/tests.

Health-aware capability is required for the target release; each person's health consent remains optional. WhatsApp is first-class scope, with engineering and live eligibility tracked separately. Telegram/Discord or desktop are not substitute prerequisites for this personal-agent release. The separate Kennel roadmap is preserved.

## Current versus target

A documentation merge does not activate a hosted agent. The September 17 source baseline is `e91bee017b0c36759cbfda1353fc11c73e3afe0a`; production assembly and multi-presence work remain incomplete, and [PR #137](https://github.com/Pin4sf/waldo-backend/pull/137) is separate draft closure work. Re-pin before every implementation claim. [GitHub ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116) and owning issues/PRs hold live state, not copied progress tables.

Keep `WaldoCoordinator`, the existing trusted RunLoop, ContextComposer, owning reducers, authority/consent boundaries and intent-before-I/O. Complete production adapters instead of adding another canonical runtime or bypassing fail-closed dependencies. Memory and personality never grant permission; provider completion is not Outcome Acceptance.

## Documentation policy

[docs/README.md](docs/README.md) separates current entrypoints from retained architecture/audit evidence. The old B0-B6 and July documents are not current launch sequencing. Preserve accepted invariants, migrations, unique reviews and historical evidence. Runtime cleanup requires caller/deployment inventory, a tested replacement and rollback; this reconciliation deletes no runtime source.

## Verification

```bash
# Documentation/instruction changes
git diff --check
npx -y pnpm@10.34.4 verify:guards

# Runtime/contract/integration changes
npx -y pnpm@10.34.4 verify
git diff --check
```

Record what actually ran at an exact SHA. Source review, fakes and previous green tests are not device, live-adapter, staging or production proof. Do not deploy or mutate hosted state without separate authorization. Register and hand off work through [the existing ledger protocol](docs/foundation/EXECUTION-LEDGER.md).
