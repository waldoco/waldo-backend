# Where MVP workers read and build

Updated 21 September 2026. Start with the [worker guide](WORKER_GUIDE.md), [canonical plan](../WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md), and the selected repository's AGENTS.md. This map assigns implementation ownership; it does not create a separate build order.

**The main Waldo agent is built in `waldo-backend`, primarily `packages/runtime`, with shared contracts in `packages/contracts` and protected persistence/migrations in `supabase`.** The app presents and controls the same agent. Kennel executes delegated work using the user's existing harnesses. Brain preserves canonical product decisions and accepted ADRs; its name does not mean it hosts the running agent.

## Repository ownership and navigation

Paths below are relative to the selected repository checkout, not to this Markdown file. Remote links navigate to the repository; fetch and record an approved current ref before implementation.

| Repository | Owns / MVP slices | Read before changing |
|---|---|---|
| [waldo-backend](https://github.com/Pin4sf/waldo-backend) | Cloud owner runtime, conversation admission/publication, memory, planning, schedules, permissions, connector/browser/channel interfaces and evidence. S0–S4 backend, H projection, B/C and cloud side of K0 | `docs/foundation/NEXT-SESSION-PLAN.md`; `packages/runtime/src/index.ts`; `packages/runtime/src/run-loop/{do,adapters}.ts`; `context-composer/`, `coordinator/`, `scheduler/`, `llm/` under `packages/runtime/src/`; `packages/contracts/src/`; `supabase/migrations/` |
| [waldo-app](https://github.com/Pin4sf/waldo-app) | iPhone UX, conversation transport/reconnect, account/cache lifecycle, HealthKit consent/sync, secure local data, Today/Activity/Memory/approval cards and push registration. S0–S4 UI/H; small K0 Work card | `src/agent/agentClient.ts`; `src/chat/useChat.ts`; `src/health/sync/`; `src/supabase/`; `modules/health/ios/HealthKitManager.swift` and `HealthModule.swift`; current app instructions/status |
| [Waldo-Kennel](https://github.com/Pin4sf/Waldo-Kennel) | Local project/workspace custody, harness credentials/lifecycle, approved execution, artifacts and proof. K0 desktop side; broader work orchestration later | `docs/STATUS.md`; `docs/architecture/harness-connection-and-authority.md`; `backend/internal/httpd/controllers/outcomes.go`; `backend/internal/service/session/attempt_spawn.go`; `backend/internal/adapters/chatdriver/codexappserver/driver.go`; `backend/internal/artifactstore/handoff.go`; [K0 source map](KENNEL_K0_SOURCE_MAP.md) |
| [waldo-brain](https://github.com/Pin4sf/waldo-brain) | Canonical product/ADR reconciliation, protected rules and product language. Bounded S0 synchronization | `AGENTS.md`, `CONTRIBUTING.md`, `01-Waldo/product/`, `01-Waldo/Architecture Decision Records (ADR)/`, `agent-rules/`; exact amendments in [ADR reconciliation](ADR_RECONCILIATION.md) |

App `supabase/functions/agent/` and `_shared/google.ts` are prototype/migration references. Do not add another execution owner there or copy legacy success paths into the canonical cloud runtime. Inventory callers/deployment before retirement.

Later web W consumes the same backend contracts. Select its repository/location in the bounded W assignment; this MVP packet does not establish an existing web repository or require one now. Channel C belongs behind backend adapters and app linking/approval UX. A channel never creates another memory or task authority. K0 keeps raw workspaces, provider sessions and credentials in Kennel; the backend receives selected progress and evidence.

## Fresh checkout first

The 21 September path audit found older primary local checkouts and unrelated dirty work. In particular, the primary app checkout was an older scaffold lacking the mapped chat/health source; those paths exist in the audited app ref `7218c18fed8b874492e3831bbb5bd1e1c58abe58`. Do not recreate missing features by upgrading that scaffold. Fetch the selected remote ref into an isolated worktree, inspect its manifest/source, and record its SHA. Preserve primary checkouts and native profiles.

Backend baseline for the engineering audit is main `65a334ccf1cb2b7d8298d416680b546cce0e868f`; the earlier final-plan commit is `3ead251c85131d8c8ae1038fe60f829ebba18dd1`. Kennel source navigation was checked at `173fb0a875fcee0705d003e1f134ac0118517782`; this is not proof of a working cloud bridge. These are dated evidence pins, not instructions to reset to old commits.

Before redoing S0 app containment, inspect [app PR #12](https://github.com/Pin4sf/waldo-app/pull/12) and its [pinned handoff](https://github.com/Pin4sf/waldo-app/blob/91f954abd4bb55618d31c594dcd46e4659b8aa92/Docs/ledger/2026-09-21-s0-chat-containment.md). At the prior handoff it was a draft with hook/handler test evidence; deployed containment, whole-app account isolation and full S0 were not proved. Refresh PR status rather than assuming it has merged.

Brain's physical ADR folder contains spaces, not literal `%20` text. Follow its canonical-main convention and protected-file instructions; do not overwrite dirty Brain work or edit mirrored rules in backend. The [bounded reconciliation](ADR_RECONCILIATION.md) gives exact source owners.

## Verification by repository

Inspect current manifests/instructions before running these observed commands. Preserve each repo's package-manager version and lockfile; commands listed here are not test results.

| Repository / working directory | Existing checks | Separate proof still required |
|---|---|---|
| Backend root | `pnpm typecheck`; `pnpm verify:node`; `pnpm verify:workers`; `pnpm verify:supabase:session-revocation`; `pnpm verify:guards`; aggregate `pnpm verify` includes frozen install and Supabase checks | Appropriate isolated Supabase/Workers environment; model/provider/staging outcomes. See [engineering quality](ENGINEERING_QUALITY.md) for CI and proposed eval runner. |
| App root | `pnpm check`; `pnpm test` | Native build, physical-iPhone HealthKit/push, account switching, network loss, accessibility and complete cloud loop. A Jest fixture does not prove native behavior. |
| Kennel `backend/` | `go test ./... -count=1` | Local daemon/harness readiness and actual K0 bridge/reconnect/artifact acceptance. Running Go tests at repo root is the wrong module scope. |
| Kennel root | `npm run test:foundation`; `npm run test:island`; `npm run frontend:typecheck`, as applicable under current instructions | Renderer tests do not prove packaged Electron/daemon/provider integration. `npm run api` and `npm run sqlc` generate outputs; review their diffs when used. |
| Brain root | `git diff --check`; touched links/frontmatter/Evidence Trails; for `agent-rules` changes, `npm --prefix agent-rules test` and `npm --prefix agent-rules run check:skills` | No general root runtime suite established by this audit. `npm --prefix agent-rules run sync` writes generated files; it is not a read-only check. |

## Assigning and integrating work

One integration owner writes shared contracts, migrations and generated clients. Release a named revision plus fixtures before app, connector, browser or Kennel consumers use it. Each consumer records producer contract revision and its own tested source SHA. A multi-repo release needs a compatible combination of refs, migration/deployment order and rollback, not unrelated green PRs.

Use the existing issue/ledger to assign the next frontier, source files, outcome, A1–A16 IDs, required environment and evidence. Register sibling-repo lanes under their own workflow and link the integration issue. Keep K0 separate from the S0 critical path. Final delivery reports personal-only and Kennel-enabled results separately and does not call a joined showcase complete without K0.

Workers research a concrete uncertainty in this order: current source/test → accepted contract and relevant plan section → installed library source/types → official versioned docs/changelog → smallest falsifying spike. Record a bounded plan correction if evidence contradicts an assumption. Competitor studies in [COMPETITOR_RESEARCH.md](COMPETITOR_RESEARCH.md) and [RUNTIME_BROWSER_RESEARCH.md](RUNTIME_BROWSER_RESEARCH.md) inform task quality; they cannot override permissions, proof or the release cut.
