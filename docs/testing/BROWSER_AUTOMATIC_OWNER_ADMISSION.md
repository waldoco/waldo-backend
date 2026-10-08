# Automatic owner browser admission

This slice connects the existing Telegram owner host to a bounded operator policy
for every currently verified directory owner. It installs no production or staging
registration. A missing policy does not enable automatic browsers. Browserbase
remains an explicit alternative; Cloudflare failure never selects it automatically.

The existing `COMMON_BROWSER_REGISTRATION` input can select
`scope: "verified_owners"`. Its `policy` contains `ref`, `createdAt`, `expiresAt`,
`allowedOrigins`, `maxAllocations`, `maxReservedBrowserMs`, `lifetimeMs` and
`maxScreenshotBytes`. Its `spend` contains explicit `limitMicrousd`, `maxCalls` and
`validUntil`, plus `allocationDayCount` when using the existing billing-day
envelope. `billing` uses the existing conservative or verified billing identity.
There are no default budget values. No owner UUID, transport subject or DO name
belongs in this operator template; the signed directory supplies those identities.
Existing registration validation still enforces the $20 owner test ceiling and $5
owner monthly browser envelope. These are per-owner checks, not account-wide caps.

The host resolves `common_owner_authority` using the existing physical DO name and
Telegram subject, checks the current physical binding again after that await, and
pins the immutable template, derived registration and custody digest in that
owner's existing DO. Its existing spend ledger reserves the first model call before
provider I/O. The quote covers Luna; unpriced model overrides are refused before
provider I/O. Concurrent calls share one metered wrapper. Task sessions still live
under `common-browser:<taskId>` and expire or close through the existing cleanup
host. No new state host or approval ledger is introduced.

Two already admitted owners and a newly admitted owner use the same operator
template. The new owner becomes usable when the existing directory admits its
verified identity; no browser-specific roster edit is required. The local journey
proves useful A/B/A page reads, image attachments to the model, separate local
session handles and ledgers, delivered/settled owner replies, reconstruction and
exact fake-provider termination. Its cookie marker is synthetic: it proves fixture
routing isolation, not live Cloudflare cookie persistence.

Policy changes, directory custody revision changes and exhausted budgets require
reconciliation. They never manufacture fresh references/allowance or automatically
adopt a new policy. Owners with prior manual `common-spend:`, browser usage or
session records are refused until existing counters and exact cleanup obligations
are reconciled. Keep the prior manual configuration available for its cleanup;
switching that owner to automatic mode is not a migration. Removal or malformed
updates to an established automatic policy deny new model/browser I/O, while its
retained immutable policy can service only previously funded exact-session cleanup.

Before activating a cohort, an operator must reconcile existing usage with the
approved total staging allowance and provider account capacity. The repository's
per-owner ledgers cannot enforce an aggregate account-wide budget or concurrent
session quota across arbitrary future owners. An existing authoritative account
allocation connection is a remaining dependency; this slice does not claim one.
No live calls, deployment, credentials, plan changes or registration updates are
part of this implementation.

The existing public-read restrictions still apply. Encrypted durable sign-in state,
owner human login/MFA/CAPTCHA handoff, owner screenshot delivery and private file
upload/download receipts remain separate missing product connections.

## Provider evidence checked 2026-10-08

- [Cloudflare Playwright](https://developers.cloudflare.com/browser-run/playwright/):
  acquire/connect reuse is supported; closing a connected client disconnects it.
- [Cloudflare limits](https://developers.cloudflare.com/browser-run/limits/):
  keep-alive extends inactivity timeout to ten minutes; it is not a total lifetime.
  Account limits vary by plan and sessions can close during provider releases.
- [Cloudflare pricing](https://developers.cloudflare.com/browser-run/pricing/):
  browser time and account concurrency are shared account billing inputs. Reuse the
  existing conservative reservation instead of assuming available free headroom.
- [Browserbase contexts](https://docs.browserbase.com/platform/browser/core-features/contexts):
  context persistence is an explicit provider mechanism. This slice does not create
  or share Browserbase contexts.

## Local regression checklist

- [x] First model call is reserved; concurrent calls retain distinct physical ordinals.
- [x] Removed/malformed policy and unpriced model cannot expose unmetered fallback.
- [x] Exhaustion, reconstruction and operator ref changes cannot refill allowance.
- [x] Prior manual reservations require reconciliation; expired policy does not pin.
- [x] Changed/unlinked directory custody refuses work; funded cleanup survives removal.
- [x] Two existing owners and a newly admitted owner complete ordinary-host journeys.
- [ ] Live normal-loop acceptance and real cookie reconnect/cleanup proof.
- [ ] Aggregate account budget/capacity allocation for automatic cohort activation.

Run from `packages/runtime` with dependencies installed:

```sh
npx vitest run test/common-owner-browser-registration.test.ts test/browser-auto-owner-do.test.ts
npx tsc --noEmit
npx tsc --project tsconfig.integration.json --noEmit
```

Tests seal provider/model/channel/directory I/O with fakes. No staging/live claim is
made by local pass results. Keep the separate #935 ingress harness repair out of the
browser feature diff; publish #929 only against Core's coordinated base.
