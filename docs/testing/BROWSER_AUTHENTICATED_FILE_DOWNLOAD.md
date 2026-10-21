# Authenticated browser attachment download

SOURCE scope: Cloudflare is explicitly selected through the existing owner browser host. `browse_act` accepts `{operation:'download',element_ref}` for an observed enabled HTTP(S) anchor. The native driver re-observes the same document before reserving a host operation ID. No provider fallback, new allocation, filesystem download API, or console-signin change is introduced.

The guarded navigation fetches GET only with `maxRedirects:0`, authorizing each hop through existing owner/session/egress checks. Same-origin GET redirects are supported; cross-origin redirects, blob/data URLs, POST exports, and non-attachment page responses are rejected. The native document remains open after the attachment is captured.

The host checkpoints prepared intent before transport and attachment metadata before importing. Existing owner-private workspace receipts provide pending/committed recovery, `provider_import` provenance and external taint. Exact-revision bytes are read back and SHA-256 checked before publishing a ready receipt and authenticated owner link. Retrying the same observed operation recovers the committed workspace operation without refetching; an intent with no recoverable bytes remains uncertain and is never automatically repeated. Session/grant/operation identity is checked again inside checkpoint transactions.

The existing 10 MiB per-file and 100 MiB per-owner workspace limits apply. The pinned Cloudflare Playwright 1.3.6 APIResponse body buffers the entire provider response before import validation; the 10 MiB import limit is not a streaming transport memory cap. Content-Length is checked before body retrieval when supplied. No model receives file bytes, response headers, cookies, or provider session IDs through the receipt.

LOCAL evidence: focused fake-provider host tests exercise import, restart recovery after workspace commit, foreign/revoked/expired owner refusal, concurrent reservation and checkpoint custody replacement. The native fixture uses actual Chromium input/password/MFA POST/303/cookies and actual guarded GET attachment transport plus workspace storage/readback. Cloudflare protocol/UI and owner-console authentication are labeled doubles. This does not prove Cloudflare's deployed service or the complete authenticated console routing path.

Run focused tests from `packages/runtime`:

```sh
pnpm exec vitest run test/browser-download-host.test.ts test/browser-download-workspace.test.ts test/browser-http-attachment.test.ts test/general-browser-redirects.test.ts test/general-browser-driver.test.ts test/browser-screenshot-workspace.test.ts test/browser-native-owner-handoff.test.ts test/console-workspace.test.ts
pnpm exec tsc --noEmit
```

The local native probe is `packages/runtime/test/fixtures/browser-file-roundtrip-probe.mjs`; it currently proves the download half only. Run it with cached upstream Playwright, the Chrome executable and an esbuild Node bundle exporting the real driver, workspace helper/store, console download helper and digest. Its JSON receipt explicitly reports doubles, byte verification and zero provider allocations.

STAGING acceptance remains pending operator coordination and the bounded existing provider allowance:

1. Deploy the reviewed exact source head to staging through the parent-owned process, with existing owner mapping/workspace storage and grant. No migration, permission or paid cap change is part of this slice.
2. Ask the existing host to use `cloudflare_playwright` for a controlled fictional account page; complete native owner password/MFA handoff and resume the same funded session. Verify the intended account from fresh evidence.
3. Request an observed authenticated GET CSV attachment. Verify the returned workspace file ID/revision, filename, byte size and SHA against the controlled server receipt.
4. Download the owner link through the actual signed-in console. Compare bytes/SHA; unauthenticated and another-owner requests must fail.
5. Recover the same committed operation after interruption without another provider GET. Revoke/expire custody and verify no new provider dispatch or ready receipt. End the exact session.

No STAGING or LIVE success is claimed. Owner-approved native file upload and independent server upload receipts remain unfinished, pending the coordinated browser approval callbacks in `packages/runtime/src/channels/telegram-owner-do.ts`. Selecting a file exposes bytes to page JavaScript immediately; the future approval must bind exact file revision/hash/name/size, owner/session/generation/document and destination before input selection. It must use the existing approval ledger and refuse uncertain replay.

Provider references: [Cloudflare Playwright](https://developers.cloudflare.com/browser-run/playwright/), [route.fetch](https://playwright.dev/docs/api/class-route#route-fetch), [CDP download limitation](https://github.com/microsoft/playwright/issues/38805), [Cloudflare download issue](https://github.com/cloudflare/playwright/issues/93).
