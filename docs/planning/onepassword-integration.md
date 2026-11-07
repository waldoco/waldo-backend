# 1Password integration for site sign-in (design, 26 Oct 2026)

Design only: no code, cloud change or API call. Owner direction: passwords via 1Password; Waldo never sees or stores one; payments out of scope.

## Findings (read 26 Oct)

1. **Becoming supported.** The consumer page offers users only a waitlist ([1]). Agent makers integrate through the Agentic Autofill **partner preview**:
   - Flow: OAuth with PKCE, then an access request, then the person approves in 1Password, then the 1Password extension fills the login ([2], [3]).
   - Requirements: a 1Password Business account, with the "OAuth Application" option turned on by "your 1Password contact" ([4], [2]).
   - No public agent-partner sign-up; only the generic partner form ([5]).
   - Browserbase was first, October 2025 ([6]).
2. **Browser.** Agentic Autofill needs a Chromium browser with the 1Password Nightly extension (8.12.46.6 or later) loaded. The agent calls the extension's service worker over CDP ([7], [8]). Any remote Chromium that can install the extension works ([9]).
   - Cloudflare Browser Run documents no way to load an extension or pass launch flags ([10], [11]). Undocumented, not proven impossible.
   - Browserbase documents extension upload ([12]).
   - Browser Use Cloud: unverified.
3. **Approval surface.** Approval happens inside 1Password, never in the partner's own UI:
   - Desktop: works today in the Nightly app.
   - Phone: the partner's own app hands the request to 1Password through a share sheet (iOS) or bottom sheet (Android). This needs 1Password 8.12.42 or later ([3], [13]).
   - Still in development: approval from a link in the 1Password mobile apps, and approval in the browser ([9], [14]).
4. **Grants are coarse.** A grant lasts 30 days. The person cannot revoke it inside 1Password, and Disconnect revokes the whole connection rather than one login ([9]). At launch: US Individual and Family accounts only, using logins from the Personal or Private vault ([2], [3]).
5. **"Never sees" holds only because Waldo enforces it.**
   - Waldo stores an integration key plus OAuth tokens. Together they give "a standing ability to use every login the person granted" ([15]).
   - The required `read` scope also enables an SDK path that returns passwords and one-time codes ([16]).

## Recommendation

**Now: owner handoff. This is already in source.** At a sign-in wall, Waldo pauses and the owner signs in through Live View.
- Cloudflare path: `packages/runtime/src/channels/native-browser-handoff.ts` (`Cloudflare.handoff`, [17]).
- Browser Use path: `browser-login-handoff.ts`.
- Reads and screenshots pause during the handoff. Sessions launch with `recording: false` and domain guardrails (`cloudflare-browser-adapter.ts`).
- The owner copies from 1Password. Their local extension probably cannot fill into Live View [inference].

**Rejected options:**
- **(a) Service Accounts.** This is custody, against owner direction. Service accounts also cannot reach Personal or Private vaults ([18]).
- **(b) Connect.** It caches vault data on our infrastructure and returns secret values ([19]).

**Switch to Agentic Autofill when all four hold:**
- partner access is granted;
- the cohort's region is eligible;
- Waldo has a browser that can load the extension;
- the Waldo app hosts approval through the iOS share sheet.

## Security requirements

- **Custody.** The integration key and refresh token live in Supabase Vault, per owner and per connection.
  - Never in DO SQLite, R2, prompts, logs, traces, events, tool arguments or extension storage.
  - The key reaches the extension only as a CDP argument.
  - CDP traffic is never logged ([8]).
- **No read path.** A `scripts/guards` rule bans the SDK read call. Waldo uses only `createAccessRequest`, `getAccessRequestStatus` and `fillCredential`.
- **Allowlist.** The owner keeps an allowlist of exact HTTPS origins in the console Vault.
  - The harness writes the request `website`, `goal` and `reason` from the allowlist entry, never the model.
  - These fields carry no names, health data or message content ([20]).
- **Origin check.** Before every fill, Waldo reads the tab's real origin through `chrome.tabs`. If it does not match the allowlist, the fill is refused.
- **Taint.** If the sign-in page was reached from outside text (an email link, a search result), Waldo needs a `tainted_action` approval with step-up (`approval-step-up.ts`). An origin that is not on the allowlist is refused outright.
- **Both approvals, different jobs.**
  - Waldo's card approves this site for this task.
  - 1Password's prompt releases the credential.
  - After the first grant, 1Password does not prompt again for 30 days. Waldo's card plus step-up is therefore the per-use check, rechecked before each fill.
- **Blind window.** From the access request until `fillCredential` returns, Waldo takes no DOM reads, screenshots or CDP commands on that tab ([8]). Agentic Mode stays on, and each browser serves one owner.
- **`appLink` handling.** It is opaque and travels in a structured card field, never through a model.
- **Access log.** The Vault access log records every request, decision, fill and post-fill check: origin, state, time and run ID only.
- **Revocation.** Vault's "Disconnect 1Password" revokes the connection and deletes the key. Removing a site from the allowlist applies before the next fill.

## Needs an ADR or contract review

- ADR: the new external integration and the per-owner bearer secret (custody, no-read guard, retention, disconnect).
- ADR or owner ruling: which browser engine runs sign-in sessions.
- Contract review:
  - an additive `site_sign_in` approval kind in app.v1 (tell the app lane first);
  - the Vault allowlist and access-log shapes;
  - adding `api.1password.com`, `crl.1passwordservices.com` and `my.1password.com` to the guardrails ([8]).
- Privacy notice: name 1Password as a processor.

## Decisions for the owner

1. Request partner-preview access ([5]). Buy a Business account and ask 1Password to enable OAuth Application ([4]).
2. Region: are testers in India on 1password.com eligible? The docs' "US" may mean the data region rather than residence [inference].
3. Engine: ask Cloudflare for extension support, or reopen the Browserbase ruling, which is currently out, for sign-in only.
4. The OAuth client's name and icon cannot change after creation ([4]). Use separate staging and production clients.
5. Within the 30-day grant: approve every fill with a card, or allow a standing per-site approval?

## Phases and acceptance tests

**0: Console Vault placeholder (in progress).** Shows "1Password: not connected", an empty allowlist and an empty access log.
- Owner-only and step-up gated.
- Zero 1Password network calls.
- A non-owner gets a 404.

**1: Harden the handoff.**
- A sign-in wall becomes a card with a Live View link.
- A read or screenshot during the handoff is refused.
- A wrong account fails closed.
- Live View URLs, which carry tokens ([10]), never reach logs or transcripts.
- Expiry releases the browser.
- A tainted login requires step-up.

**2: Connect and disconnect (staging).**
- The key and tokens are absent from the DO, logs, traces and events, checked with a canary scan.
- `invalid_grant` prompts a reconnect.
- The no-read guard fails on a planted read call.

**3: Agentic Autofill.**
- Golden fill on the-internet.herokuapp.com/login reaches the success URL.
- Denied, expired and pending requests each end honestly, without retry storms.
- An origin mismatch refuses the fill.
- No read or screenshot happens inside the blind window.
- Every step writes a log row.

**4: Approval in the app** (waldo-app). The approval card plus step-up opens the 1Password share sheet.
- A decline is reported back.
- Passes on a physical device.

## Sources

[1] https://1password.com/personal-ai-agent-integrations
[2] https://www.1password.dev/agentic-autofill/partners
[3] https://www.1password.dev/agentic-autofill/partners/approval
[4] https://www.1password.dev/agentic-autofill/partners/production.md
[5] https://1password.com/partnerships
[6] https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents
[7] https://www.1password.dev/agentic-autofill/partners/extension-api
[8] https://www.1password.dev/agentic-autofill/partners/fill.md
[9] https://www.1password.dev/agentic-autofill/partners/faq.md
[10] https://developers.cloudflare.com/browser-run/reference/browser-binding-api/
[11] https://developers.cloudflare.com/browser-rendering/changelog
[12] https://docs.browserbase.com/integrations/1password/agentic-autofill.md
[13] https://www.1password.dev/agentic-autofill/partners/ios-approval.md
[14] https://www.1password.dev/agentic-autofill/partners/browser-approval.md
[15] https://www.1password.dev/agentic-autofill/partners/keys-and-tokens.md
[16] https://www.1password.dev/agentic-autofill/partners/sdk.md
[17] https://developers.cloudflare.com/browser-run/features/human-in-the-loop/
[18] https://www.1password.dev/service-accounts/get-started.md
[19] https://www.1password.dev/connect/overview.md
[20] https://www.1password.dev/agentic-autofill/partners/access-requests.md
