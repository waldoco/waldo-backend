# Private owner browser: local preparation

This isolated candidate consumes the existing AES-GCM state custody, site filter,
private-session runner and Cloudflare launcher. It is a concrete trusted-host
composition with a synthetic owner journey. It is not yet wired into the ordinary
owner host and must not be merged as an unwired serving feature.

The host requires an authenticated physical owner check, separate explicit
persistence approval, an approved nonextractable AES-GCM key, a finite prefunded
allocation lifetime, bounded cleanup with exact-session absence proof, and trusted
account verification. It cannot mint any of these. The runtime interface accepts
no passwords, MFA codes, OAuth grants or model-authored browser code.

Flow: verify admission; retain allocation intent before provider I/O; record the
exact provider identity; restore filtered decrypted storageState into a fresh
isolated context; verify the account. If needed, prepare the approved login page,
request native tab Live View/handoff, deliver its bearer URL only through the owner
transport and await the matching completion event. Verify the account again before
private work and before state export. Save filtered state under owner/environment/
site/account/generation AAD, close context/browser and independently verify exact
provider absence. Native provider ACK and human Done are not completion evidence.

Recovery changes a durable operation ID before cleanup. Late work and late blob
writes cannot commit or return success. A recreated host cleans retained exact
identity and reports interruption; it does not resume a crashed MFA listener.
Allocation intent without a provider ID remains uncertain and blocks replacement.
Sign-out first writes a durable generation tombstone, then deletes ciphertext and
terminates the exact browser. Failed cleanup stays typed and unresolved. Local
sign-out does not claim remote website logout/token revocation. Renewing an expired
or revoked consent generation requires a coordinated renewal/GC implementation;
this candidate rejects changed generations rather than silently resetting custody.

Current official provider capabilities and limits:

- Cloudflare Playwright documents cookies, local storage and IndexedDB via
  storageState({indexedDB:true}) and restore into a new context. This does not
  preserve arbitrary profile files, sessionStorage, cache, open tabs or a provider
  session. Website authentication may expire independently of saved state.
- Live View and structured human handoff are beta. Installed pinned SDK1.3.6 exposes
  getLiveView, handoff and handoffComplete types; actual provider acceptance has not
  run. Only tab mode supports handoff. The candidate requires matching target and
  handoff IDs; events omitting the optional handoff ID are not accepted as success.
- Live View URL expiry limits new connections, not an established viewer. Exact
  provider termination is required for revocation; no URL or websocket token is
  stored in durable state or returned as task output.
- Keepalive is inactivity retention, not an approved spend/lifetime extension. The
  host requires explicit finite lifetime and keeps inactivity retention within it.
  Task, grant and funded lifetime deadlines bound account checks and private work.
  Provider launch/context/export/close calls still require bounded metered transport
  hooks from the existing owner host, and independent cleanup allowance.
- Browser Run identifies bot traffic. Real site denial or a login timeout fails
  acceptance. No CAPTCHA solving, private real-account login or provider fallback
  was attempted. Browserbase remains an explicit separate provider choice.

Sources: [storage state](https://developers.cloudflare.com/browser-run/playwright/#storage-state),
[human handoff](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/),
[Live View](https://developers.cloudflare.com/browser-run/features/live-view/),
[reuse sessions](https://developers.cloudflare.com/browser-run/features/reuse-sessions/).

Adversarial local checklist:

- [x] Synthetic MFA produces useful account content, encrypted state and no model URL.
- [x] Recreated host restores into a fresh context without another synthetic login.
- [x] Restore requires current account proof before private reads.
- [x] Wrong owner cannot restore, hand off, sign out or recover another owner's state.
- [x] Ciphertext replay into another owner fails even using the same synthetic key.
- [x] Done without account proof saves nothing and returns typed failure.
- [x] Sign-out during MFA fences late completion, deletes ciphertext and survives restart.
- [x] Restart cleanup fences a late private read and refuses a success claim.
- [x] Consent withdrawal denies restore but does not deny authenticated local sign-out.
- [x] Nonfinite/expired deadlines permit no provider allocation.
- [x] Pending owner delivery and pending private reads respect deadlines.
- [x] Cleanup uncertainty retains a tombstone and does not expose provider error bodies.

Integration dependencies, to coordinate before shared edits: owner-browser-runtime
private operation consumer, approved key custody/renewal, owner-only delivery and
explicit approval flows, alarm/forget/unlink recovery, metered allocation/transport/
cleanup. Existing owner-loop and console-signin files are unchanged by preparation.
Real-provider acceptance needs a separately coordinated existing staging allowance;
no new keys/grants, permission, cap, plan, payment or production change is authorized.
A skipped live test must be labelled skipped, never passed. Staging acceptance must
prove useful authenticated page content, correct owner/account state after restart,
owner-only handoff delivery and independent exact-session absence after sign-out.
