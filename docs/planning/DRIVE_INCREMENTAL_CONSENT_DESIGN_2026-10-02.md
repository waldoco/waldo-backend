# Drive-only incremental consent (design note, no code)

Status: draft for review. Layer: SOURCE design only. Nothing here is deployed or enabled.

## Problem

Staging proof on 8ef75e8 (2026-10-02 08:19 IST): `read_mcp_tool` on server `drive` reached the proxy and returned `auth_failed`. The stored Google grant has no `drive.readonly`. The Connect Google link the bot then offered requests the whole combined set from `GOOGLE_CONSENT_SCOPES` (`connectors/google.ts`): calendar.events, calendar.events.freebusy, gmail.readonly, gmail.send, gmail.compose, tasks, drive.readonly, documents.readonly, spreadsheets.readonly, presentations.readonly. To add read-only Drive the owner has to look at a screen that also lists Gmail send, compose and Tasks write.

## What exists

- `googleConsentUrl(app, state, challenge)` always uses the full `GOOGLE_CONSENT_SCOPES`, with `include_granted_scopes=true` and `prompt=consent select_account`.
- The tool failure is already typed: `connect: { status: 'auth_required', service: 'google', reason, feature }`. For this case `feature` is `drive`. The channel offer seam receives it.
- `googleHas(scopes, feature)` for workspace features requires every scope in `GOOGLE_FEATURE_SCOPES[feature]` in the stored grant. It never grants Drive implicitly.

## Proposal

1. `googleConsentUrl` takes an optional `feature`. With a feature, `scope` is `openid email` plus `GOOGLE_FEATURE_SCOPES[feature]` only. Without one, behaviour is unchanged (first connect keeps the combined set, per the owner's 2026-09-24 ruling).
2. Keep `include_granted_scopes=true`. Google then returns a token covering earlier grants plus the new one, and the consent screen lists only the new permission (Drive read). Callback storage already records the returned `scope` string; `googleHas` is unchanged.
3. The offer seam passes `connect.feature` through when it starts the flow. The signed state does not change shape; the requested feature rides in the DO's nonce record next to the PKCE verifier, so a replayed link cannot widen scope.
4. The completion page names what was added ("Google Drive, read only") from the closed feature enum.
5. Feature set is closed: only the four read-only features (`drive`, `docs`, `sheets`, `slides`) are allowed on the incremental path. A write feature always uses the full flow and the owner desk.

## Tests (red first)

- URL for `drive` contains `drive.readonly`, not `gmail.send`, `gmail.compose`, `tasks` or any calendar scope. Combined set unchanged when no feature.
- Unknown or write feature falls back to the full set and is refused for the incremental path.
- Callback with a Drive-only scope response keeps earlier scopes in the stored union and `googleHas(drive)` flips true.
- Nonce record carries the feature; a state with a tampered feature is rejected.

## Seams (Codex, not core)

`telegram-owner-do.ts` (offerConnect call site, nonce record) and `console-signin.ts` (dashboard connect). Core ships the connector change and tests; Codex wires the two call sites.

## Risks and unknowns

- Google may still show previously granted scopes on the screen when `prompt=consent` is set. That is Google's behaviour; verify on the real consent screen and record exactly what is displayed.
- The app is unverified, so the "unverified app" interstitial still appears for test users.
- Whether the Drive MCP endpoint accepts a token that carries only these scopes has been proven only through the proxy path so far. Re-run the Drive proof after the owner connects.

## Interim

Until this ships, adding Drive means approving the full combined consent screen. That is the owner's call and needs his own words.
