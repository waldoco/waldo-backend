# Provider Readiness Hardening

## Goal

Keep the HEY-143 gateway adapter testable while ensuring a RunLoopDO cannot make a real
provider call without a Secrets Store credential, a pre-call spend reading, and a passed
sanitisation check.

## Scope

- Replace the plain gateway token environment string with an asynchronous secret binding.
- Constrain Cloudflare gateway HTTP to its fixed HTTPS origin, a bounded request duration, and
  metadata-only logging.
- Make missing spend data and failed prompt sanitisation stop before gateway fetch.
- Enforce local ingress only in local or test environments.
- Close adapter validation gaps for returned model identity and cache controls.

## Non-goals

- Provision a Cloudflare Secrets Store or change deployed bindings.
- Create the missing HEY-99 daily-spend ledger.
- Enable live provider, context, memory, or channel dogfood.
- Store prompts, provider bodies, credentials, or channel payloads.

## Design

### Gateway adapter

The adapter accepts a small asynchronous credential seam rather than a token string. It resolves
the secret immediately before an approved request and returns a sanitised auth failure when the
binding is absent, empty, or unavailable. Its transport accepts only the fixed
Cloudflare REST endpoint, applies a timeout, pins
`cf-aig-collect-log-payload: false`, and maps `cache: 'none'` to the documented cache-bypass
header. A response must identify the requested model or its documented Cloudflare form.

### Run-loop preflight

The run loop resolves a provider-control seam. Before each LLM call it sanitises the complete
request and reads the daily spend state. A missing or failed control fails the run before
`RuntimeLLMProvider` can call the gateway. The current gateway resolver intentionally supplies
no live spend reader, so its normal behaviour remains fail closed until the HEY-99 ledger exists.

### Boundary controls

The local-run HTTP endpoint is available only when `WALDO_ENV` is `local` or `test`. Gateway
credentials are represented only as a secret-binding capability; the Wrangler binding itself is
an external infrastructure prerequisite and is not provisioned in this change.

## Verification

Tests begin red and prove:

1. no gateway fetch occurs at the spend cap or when a control is unavailable;
2. pre-LLM sanitisation rejection prevents gateway fetch;
3. a forged request cannot enable payload logging;
4. non-local environments reject the local ingress path;
5. the adapter validates model identity, cache-bypass, secret retrieval, and timeout behaviour.

The merge wall remains `npx -y pnpm@10.34.4 verify` and `git diff --check`. The dedicated eval
suite is absent and remains an explicitly recorded gap.
