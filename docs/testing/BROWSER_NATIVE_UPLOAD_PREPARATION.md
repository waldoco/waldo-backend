# Native browser files: source and local proof

These changes continue PR941 on the rebased473be9aa base. No provider, model, credential, migration or staging activation occurred. Shared serving composition is still being coordinated with Core; upload is preparation until the existing normal browse_act handler and approval desk consume it.

The existing general driver now selects exact approved bytes in an observed native file input. The approval callback receives a digest binding the owner/session observation revision and immutable workspace file identity, revision, filename, MIME, size and SHA. The descriptor is copied synchronously before the first asynchronous admission. Supplied bytes are copied and hashed, current authority and target are checked again, then native setInputFiles dispatches. Post-dispatch mismatch or release failure is uncertain. FileList verification proves selection only, not website acceptance or task completion. File paths, arbitrary JavaScript and browser/provider IDs are not new model inputs.

Red-first fake tests reproduced the absent upload operation, descriptor mutation during approval, and mutation during the first admission. Coverage also refuses foreign owners, non-file inputs, withdrawn authority, stale observation and different supplied bytes before dispatch; mismatched native held bytes return uncertainty afterward. Worker and integration typechecks pass.

The existing private read host now persists native PNG bytes through the existing owner workspace and returns an authenticated owner console screenshot receipt. It verifies grant size, authority and actual SHA/size readback. Snapshot URL/title/text must remain consistent across capture before persistence. The same-host synthetic Vault/recreation/read journey proves returned bytes; screenshot tests refuse authority changes, invalid origins, invalid PNG signatures, size excess, corrupt readback and stalled authority at the actual task deadline. This does not activate private registration or prove Telegram inline photo delivery.

## Local native transport proof

`packages/runtime/test/fixtures/general-browser-session-probe.mjs` reuses the previous successor checkout's local fixture and adds actual upload selection. It runs local Chromium with a fresh temporary profile and external DNS blocked. Each operation reconnects/releases a real local CDP connection through the existing driver. It proves two tabs, retained text input, useful text/native PNG, native selected file SHA/size/name/MIME, subsequent observation/action, stale observation rejection and withdrawal before dispatch. No Cloudflare or Browserbase connection is made. The installed local Playwright-core is1.57.0; this is not Cloudflare1.3.6 provider compatibility acceptance.

Run from `packages/runtime`, passing existing installed paths:

```sh
pnpm exec tsx test/fixtures/general-browser-session-probe.mjs /path/to/playwright-core /path/to/local/chrome
```

Local receipt: `localOnly:true`, `provider:false`, `realCDPDisconnectReconnect:true`, `exactNativeUploadBytes:true`, `uploadSelectionOnly:true`, `retainedTabs:2`, `retainedInput:true`, `usefulTextAndPng:true`, `secondTurnObservationAction:true`, `staleRejected:true`, `authorityCancellationBeforeEffect:true`, `connections:12`, screenshot sizes15154/15346/15937bytes. Initial cleanup readback was unconfirmed; the fixture then independently observed actual local process exit, exact session absence, refused reconnect, and no remaining connected clients. These extra local checks do not grant extra provider cleanup calls.

The browser-owned common host now exposes a typed action handler using the existing command contract. A dispatcher-to-host fake journey reads an observed input, types exact text, returns native observed values and terminates one allocation. With the trusted preparation capability, the guarded connection stays available within the admitted turn, with current authority on every HTTP request, WebSockets refused and service workers blocked. Disconnect closes documents; physical termination remains independent. Prepared/uncertain effects are durable and prevent replay after another read. Declared sends and native form Enter/submits wait for approval rather than dispatching. The existing pixel scroll command retains its exact amount.

This handler is registered in the actual dispatcher test, not yet in TelegramOwnerDO serving composition. Core's shared-file coordination is still pending. Remaining connections are that registration, tab command contracts, owner workspace upload retrieval and exact approval composition, public screenshot callback, and cross-turn funded continuation. Existing run-keyed grants and funded model accounting must preserve their original allocation on continuation. This in-turn connection does not claim cross-turn page retention or grant extension. The normal owner runtime still cancels at turn finish.

Official API reference: https://playwright.dev/docs/api/class-locator#locator-set-input-files. Cloudflare connected close/disconnect and retained sessions: https://developers.cloudflare.com/browser-run/playwright/ and https://developers.cloudflare.com/browser-run/features/reuse-sessions/. Live provider acceptance remains subject to the parent's reconciled bounded allowance; deployment stays held during Instinct's soak.

### Retained guard and checkpoint safety

HTTP interception is installed once per connected context; operation state changes without an `unroute` gap. A main-document denial between operations fences the next operation and closes documents before disconnect. Service-worker and WebSocket preparation is also installed once per connection.

The application caps UTF-8 JSON browser checkpoints at 128 KiB, reserving 1 KiB before publication for bounded intent and cleanup metadata. This is an application budget, not a claim about the deployed backend limit: the owner namespace uses SQLite, whose documented combined key/value limit is 2 MiB ([Cloudflare limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). An oversized observation returns `observation_oversize`, clears old action eligibility, and never silently truncates native state/references. Screenshots are published only after a successful checkpoint.

Retained document state is currently preparation for an admitted in-process owner turn. Abrupt Worker eviction, broken CDP transport, and reconnect guard coverage remain unverified provider lifecycle cases. This component must not be promoted as secure cross-turn document retention or activated for normal serving actions until that lifecycle boundary and shared runtime registration are resolved. Explicit disconnect still closes documents; turn finish terminates the exact existing session.

Default common-host serving reads do **not** enable retained interactions. The source-owned `retainInteractions:true` capability is supplied only by synthetic component tests; it is absent from registered owner runtime configuration. This restores close-before-disconnect for serving public reads while the guarded native interaction implementation is reviewed. It is not a model argument or environment activation switch.
