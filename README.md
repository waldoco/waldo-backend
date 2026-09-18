# Waldo Backend

Repository for Waldo's target owner-side runtime: one user-governed personal agent with correctable memory, a distinctive personality, health-aware planning, authorized actions, and continuity through the Waldo app plus officially eligible channels. WhatsApp and later desktop integration must cross the same authority boundary and are not claimed as shipped here.

## Read first

1. [Personal-agent product architecture and build plan](docs/planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md): verified current state, Instinct parity target, thin architecture, connector decisions, build gates, tests, and cleanup map.
2. [Reconciled personal-agent launch contract — pinned Brain revision](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md): current cross-repository scope authority and durable product/privacy baseline; amend its conflicting WhatsApp/release sequencing in G0, then repin these entrypoints.
3. [Next session](docs/foundation/NEXT-SESSION-PLAN.md): this repository's short execution entrypoint and current source baseline.
4. [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), and [.claude/rules/INDEX.md](.claude/rules/INDEX.md): engineering and protected-boundary rules.
5. The relevant accepted ADRs, released schemas, exact issue/PR and current source/tests.

Health-aware capability is required for the target release; each person's health consent remains optional. WhatsApp remains a desired presence, but India activation for a general-purpose AI provider is currently blocked under the public Business Solution Terms unless Meta admits Waldo to its Third Party Agent/provider path or authoritatively confirms another route. The app-and-email release proceeds without advertising WhatsApp. Telegram/Discord or desktop are not substitute prerequisites for this personal-agent release. The separate Kennel roadmap is preserved.

## Current versus target

A documentation merge does not activate a hosted agent. The fetched September 18 backend baseline is `e91bee017b0c36759cbfda1353fc11c73e3afe0a`. At that pin, contract tests (1,584), runtime tests (1,152), typechecks, and guards pass locally, but production conversation, connectors, delivery, multi-presence, relationship coordination, and deployment remain unproved. Re-pin before every implementation claim. [GitHub ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116) and owning issues/PRs hold live state, not copied progress tables.

Keep `WaldoCoordinator`, the existing trusted RunLoop, ContextComposer, owning reducers, authority/consent boundaries and intent-before-I/O. Complete production adapters instead of adding another canonical runtime or bypassing fail-closed dependencies. Memory and personality never grant permission; provider completion is not Outcome Acceptance.

## Documentation policy

[docs/README.md](docs/README.md) separates current entrypoints from historical redirects and durable evidence. The old B0-B6, whole-product, desktop-first, and Telegram/Discord launch documents are not current sequencing. Their original content remains recoverable at the pinned Git revision. Runtime cleanup still requires caller/deployment inventory, a tested replacement, and rollback; this documentation cleanup deletes no runtime source.

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
