# PR Preview build repair

Scope: fail-closed infrastructure and asset previews. No R2, Vectorize, Workers AI,
backend/auth/provider secrets, owner fallback routing or configured browser egress. Four DO
bindings use new Preview-isolated namespaces. Console sign-in and provider flows
are intentionally unavailable, not acceptance-tested.

Owner instruction September 30, 2026 at 23:23 IST removes the dependency age
policy, following the explicit choice between removal and exact-version exceptions.
`minimumReleaseAge` and its obsolete exclusions are removed, not reduced or expanded.
Frozen lockfile installation, exact Wrangler pin and reviewed update PRs remain.
This admits newly published versions on future resolution; it is not approval to
update dependencies automatically, deploy production or weaken runtime boundaries.
Wrangler 4.135.0 and its resolved dependencies are pinned in this repair.

## Cloudflare settings, separate approval required

For waldo-runtime-staging Previews Base only:

- Build command: `scripts/build-runtime-preview.sh`
- Preview deploy command: `scripts/deploy-runtime-preview.sh`
- Root directory: `/`

The preview wrapper uses the project-local exact version, explicitly targets
waldo-runtime-staging, requests ignoring dashboard Base configuration on preview creation,
uses a versioned stable feature-branch identity rather than legacy branch state,
and permits no extra arguments. It invokes `wrangler preview`, never `deploy` or
`versions deploy`. Do not replace the normal beta-mvp upload-only command.
No production Worker or live staging promotion is part of this change.

Current root `npx wrangler preview` fetches unpinned latest CLI and missing block
fails. Adding only `previews: {}` is insufficient for this Worker: env DO bindings
and vars are not inherited. Assets and migrations remain top-level.

## Checks

Frozen installation, recursive typechecks, dashboard build and bounded assets,
preview configuration guards, adversarial mutations, staging dry-run bundle and focused tests are local
checks only. Preview CLI has no dry-run option. Hosted Preview success and an
exact-head Workers Builds check must be checked after reviewed publishing and
approved dashboard settings change. Do not claim a hosted Preview from a build.

Sources:
- https://developers.cloudflare.com/workers/previews/get-started/
- https://developers.cloudflare.com/workers/previews/configuration/
- https://developers.cloudflare.com/workers/previews/resources/

The existing observability regression guard is updated to mutate production and
staging semantically instead of requiring exactly two text occurrences. The new
preview privacy settings are tested separately; no URL-log/trace assertion is removed.
Local pgTAP runs require a UTC database session for the existing compiled-time
string assertion; the initial local +05:30 run failed the same-instant text check.
No SQL or SQL test is changed by this repair.

Wrangler 4.135.0 sends `ignore_base_config=true` when creating a Preview.
It does not send that flag when updating an existing Preview. A commit-specific
`isolated-<full-sha>` name avoids reusing a legacy branch Preview. Reusing this
exact name is still an update: inspect its hosted bindings and secret names before
acceptance. Do not claim absent hosted secrets from local config alone.

Exact-head CI first exposed a run-journal test's 500ms auto-alarm race after eviction.
An 800ms injected setup delay reproduced it. The test now parks the real platform
alarm one hour ahead, makes the persisted schedule due explicitly, then invokes the
real alarm helper after eviction; numeric-heavy run ID, one delivery and durable
DONE/acked assertions remain. No scheduler implementation or assertion is weakened.

## Capacity repair (October 1)

New previews use `pr-v3-<verified open PR number>`, one isolated state namespace set
per PR rather than per commit. A bounded unauthenticated GitHub API lookup must find
exactly one open same-repository PR with matching branch/full head and beta-mvp base.
Failure, fork, mismatch, no PR or ambiguous results stop before deployment. Branch
reuse across PRs creates a new identity; renaming the same PR retains its identity.
Exact full commit stays in WALDO_RELEASE; review must use the immutable Unique
Deployment URL, never the moving Preview URL. Workers Builds branch identity must
match a local symbolic branch, or fill a detached checkout. Release branches and
invalid plain Git branch syntax fail closed. v3 never adopts legacy branch state.
Development state persists between commits of the same PR; tests remain hermetic.

The retirement planner admits only a closed same-repository PR whose live head/ref
match the event. It selects the v3 identity and exact current-head legacy isolated
preview, never other old SHA records, unresolved previews or release state. Planner
is not wired to write CI yet: deletion execution, secret scope and reopen/close
race handling need their own review. The October1 approved one-time cleanup is
separate and does not grant automatic future deletion.

Refs: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
and https://developers.cloudflare.com/workers/previews/get-started/ (checked Oct1).
