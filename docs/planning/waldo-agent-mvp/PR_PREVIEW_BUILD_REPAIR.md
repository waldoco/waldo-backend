# PR Preview build repair

Scope: fail-closed infrastructure and asset previews. No R2, Vectorize, Workers AI,
backend/auth/provider secrets, owner fallback routing or outbound egress. Four DO
bindings use new Preview-isolated namespaces. Console sign-in and provider flows
are intentionally unavailable, not acceptance-tested.

The proposed narrow package-age exception still needs owner approval before publish.
Wrangler 4.135.0 is the first compatible release, published September 18, 2026.
At September 30 it and exact miniflare/workerd transitives are under the 14-day gate.
Version unions keep both existing pool-worker versions and new CLI versions allowed;
separate duplicate-name exceptions did not work with this project's pnpm resolver.
No global age reduction. Existing per-platform workerd exception is retained.

## Cloudflare settings, separate approval required

For waldo-runtime-staging Previews Base only:

- Build command: `scripts/build-runtime-preview.sh`
- Preview deploy command: `scripts/deploy-runtime-preview.sh`
- Root directory: `/`

The preview wrapper uses the project-local exact version, explicitly targets
waldo-runtime-staging, ignores dashboard Base configuration (including secrets),
and permits no extra arguments. It invokes `wrangler preview`, never `deploy` or
`versions deploy`. Do not replace the normal beta-mvp upload-only command.
No production Worker or live staging promotion is part of this change.

Current root `npx wrangler preview` fetches unpinned latest CLI and missing block
fails. Adding only `previews: {}` is insufficient for this Worker: env DO bindings
and vars are not inherited. Assets and migrations remain top-level.

## Checks

Frozen installation, recursive typechecks, dashboard build and bounded assets,
preview configuration guard, staging dry-run bundle and focused tests are local
checks only. Preview CLI has no dry-run option. Hosted Preview success and an
exact-head Workers Builds check must be checked after reviewed publishing and
approved dashboard settings change. Do not claim a hosted Preview from a build.

Sources:
- https://developers.cloudflare.com/workers/previews/get-started/
- https://developers.cloudflare.com/workers/previews/configuration/
- https://developers.cloudflare.com/workers/previews/resources/
