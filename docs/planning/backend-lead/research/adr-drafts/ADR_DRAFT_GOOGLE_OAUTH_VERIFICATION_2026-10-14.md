> **DRAFT for owner decision.** Written 14 Oct 2026 by the backend lead's decision workflow `wf_d8922d1d-861` at `beta-mvp` `e5c022ef`. Each draft went through research, two adversarial verifiers (source and risk) and a reviser. Status: Proposed. Not accepted until the owner says so.

# ADR draft: Google OAuth verification in two steps, with per-feature consent and a production restricted-scope gate

Status: Proposed (14 Oct 2026). Not authoritative until the owner accepts it, it is published in Brain under the next free number, and `docs/foundation/accepted-adrs.json` is regenerated.

What it changes and keeps:
- It amends the owner ruling of 24 Sep 2026, which put all scopes in one dialog (`connectors/google.ts:3`).
- It sets the order of PR #1148's publish checklist (`docs/connectors/GOOGLE_WORKSPACE_PLAN.md:186-194`).
- It does not move publishing: verification still follows the working agent and the app build (`GOOGLE_WORKSPACE_PLAN.md:3`).
- It does not decide email-body processing. Step 2 waits for a separate bounded ADR on that.

Author: the G38 decision-packet session. Source read at `beta-mvp` `e5c022ef`; PR #1148 read at `0aa7625f`.

## 1. Context

**Only listed testers can connect.**
- The OAuth app is unverified and in Testing (`google.ts:5`).
- Testing-mode refresh tokens expire after 7 days, so testers reconnect weekly (`GOOGLE_WORKSPACE_PLAN.md:176-184`; developers.google.com/identity/protocols/oauth2).
- An unverified app using sensitive or restricted scopes shows a warning and is capped at 100 new users for the project's lifetime; the cap cannot be reset (support.google.com/cloud/answer/7454865, /answer/13463817).

**One dialog asks for 17 scopes** (`google.ts:92`, `:94-102`). Three are restricted: `gmail.readonly`, `gmail.compose`, `drive.readonly`. Restricted scopes need a CASA assessment by an authorized lab, repeated at least every 12 months (developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification; support.google.com/cloud/answer/13463816).

**Several scopes serve no live feature:**
- `user.phonenumbers.read`. The phone is fetched at connect (`google.ts:174`) and stored per account (`owner-do.ts:2331-2342`). Nothing reads it.
- `documents.readonly`, `spreadsheets.readonly`, `presentations.readonly`. They back MCP catalogue entries (`google-mcp.ts:22-24`) that no deploy config names (`wrangler.jsonc:20`, `:87`).

**Mail is restricted in every form.** Reading, reply threading, background follow-ups, Gmail push and the desk's Sent readback that confirms a send (`approvals.ts:600-668`) all need `gmail.readonly`; `gmail.metadata` is restricted too. Only `gmail.send` is sensitive. Calendar, availability, calendar lists, tasks and contacts are sensitive or non-sensitive [inference for `calendar.events.freebusy`, `calendar.calendarlist.readonly`, `tasks` and the contacts scopes; confirm on the Data Access page].

**The mail feature is one check.** `googleHas(scopes, 'mail')` needs `gmail.readonly`, `gmail.send` and `gmail.compose` by exact name (`google.ts:13`, `:35`). Tools, account selection, push and the edge all use it (`owner-do.ts:1677`, `:2374`, `:2386`, `:3162`; `connector-proxy/index.ts:128`).

**Consent cannot be requested per feature.** `connectUrl(_feature, ...)` drops the feature and mints a link for any request (`owner-do.ts:2415`); `beginSession` always asks for the full set (`:2432-2436`). The reauth notice always mints a calendar link (`:2300`).

**Staging captures text for all its users.** Staging sets text capture on (`wrangler.jsonc:87`); only `WALDO_ENVIRONMENT=production` turns it off (`trace-privacy.ts:63-66`). There is no per-owner gate. Google's User Data Policy applies to every client that receives Google user data [inference: policy page not fetched]. Limited Use bars human reading without the user's affirmative agreement and limits transfers (developers.google.com/terms/api-services-user-data-policy), and requires no training of generalized AI/ML models on Workspace data (support.google.com/cloud/answer/13805798).

## 2. Decision

### 2.1 Scopes per bundle

| Bundle | Scopes | Asked when | Google class |
|---|---|---|---|
| base | `openid`, `email`, `profile`, `calendar.events`, `calendar.events.freebusy`, `calendar.calendarlist.readonly`, `tasks`, `contacts.readonly`, `contacts.other.readonly` | first connect | non-sensitive and sensitive |
| mail | `gmail.readonly` (or `gmail.modify` if archive/label/trash ship), `gmail.send`; `gmail.compose` only if the owner keeps Gmail-editable drafts | first mail request, in context, when the gate allows | restricted |
| drive | `drive.readonly` (or `drive.file` with a picker, if search across all files is dropped) | first Drive request, in context, when the gate allows | restricted (`drive.file`: non-sensitive) |

Removed from consent: `user.phonenumbers.read` (and the People call at connect, removed outright because `include_granted_scopes` returns old grants' scopes), `documents.readonly`, `spreadsheets.readonly`, `presentations.readonly`. Stored phones are purged once. Legacy grants holding these scopes keep working; nothing gates on them.

### 2.2 Mail capabilities

- **read**: `gmail.readonly` or `gmail.modify`.
- **send**: `gmail.send`.
- **draft**: `gmail.compose`; gates only `draft_email`.
- The `mail` flag the app sees keeps meaning read and send.

### 2.3 Consent per feature

- The connect ticket stores the requested feature server-side, next to its channel. It is never read from the callback. A ticket with no stored feature, or an unknown one, is refused and mints nothing.
- The consent URL asks for base plus the requested bundle. `include_granted_scopes=true` stays, so the stored grant is the union.
- A reconnect asks for the bundles the failing account held, filtered by the gate, and tells the owner which were left out.
- A declined incremental consent leaves the existing grant and its tools unchanged.
- The model judges when a feature is needed. No rule decides it.
- A granted scope is not an action grant. Sends, drafts, task changes and calendar changes keep per-action desk approval, and dispatch rechecks scopes at the edge (`connector-proxy/index.ts:205`).

### 2.4 Production restricted-scope gate

- An owner-set config value, absent by default, must be on before any restricted bundle is requested.
- While it is off, connect requests for mail or Drive are refused before a link is minted. The typed connect intent says the feature is not available yet.
- Production keeps it off until step 2 passes. Staging turns it on for agreed testers.
- This is a hard boundary: it protects an irreversible lifetime cap and keeps email-body processing for outside users behind its own review.

### 2.5 Two verification steps

- **Step 1:** brand plus sensitive verification for the base bundle on the production client, then publish. Outside users connect calendar, availability, calendar lists, tasks and contacts with no warning and no 7-day expiry.
- **Step 2:** restricted verification plus CASA for mail and Drive. It starts only when (a) a separate email-body processing ADR is accepted, (b) the mail split and scope choices have landed, and (c) every store of mail- or Drive-derived content is inventoried and purged on disconnect. Only then does the production gate turn on.

### 2.6 Clients and projects

- Verification runs on a company-owned production project, with one Web client whose redirect URI is on a verified company domain.
- Staging keeps its own client in Testing, with only testers who signed the staging agreement (2.7).
- Gmail push reads its project from per-environment config, replacing the constant at `google-push.ts:96`.
- If production already holds grants from another client, those grants report as needing reconnect, not as configuration failures.

### 2.7 Limited Use on every Waldo Google client

For data received from Google APIs on any Waldo client (production, staging, or any later one):
- It serves the owner's own features only, including background triage, follow-ups and push handling.
- It goes to LLM providers only for those features, and requests do not ask the provider to retain it.
- It never trains generalized models and is never used for ads.
- No human reads it outside Limited Use exceptions.
- Production never captures model text; this is already enforced in code.
- Staging captures text for all its users. So nobody joins the staging Google test list without explicit written agreement that team members may read their Google content in staging traces, separate from the health line. If legal review finds that insufficient, Google-sourced text is redacted from staging traces.

The production privacy policy states all of this, with the Limited Use sentence.

### 2.8 Conformance

A test pins the production consent set, with the gate at its production default, to the list submitted to Google. Asking for an unsubmitted scope fails CI.

## 3. Considered options

1. **Wait, then submit everything once (with CASA).** Rejected as the default. Calendar-only users wait for the slowest review, and one dialog makes every user accept restricted scopes. Fallback if step 1 is refused (section 8).
2. **Per-feature consent without a gate.** Rejected. The model-driven connect flow would offer mail to outside users before CASA, spending the lifetime cap and starting Gmail-body processing before its review.
3. **Publish to Production unverified now.** Rejected. It spends the lifetime cap, shows every user the warning and contradicts the publishing ruling.
4. **Design out restricted scopes** (forwarding to Waldo's inbound address; `drive.file` with a picker). Rejected for now. It removes triage, search, threads, reply threading, follow-ups, push and the Sent readback. Revisit if CASA cost or tier is out of proportion.
5. **Keep the existing project and client for production.** Rejected. It mixes the client that carries public Limited Use commitments with staging capture and a platform-subdomain redirect [inference: the current app sits in the dev-named project].

## 4. Consequences

**Benefits:**
- Outside users reach the non-mail features after a sensitive review: days to about two weeks, quoted by third parties [inference].
- The first dialog drops from 17 scopes to 9.
- An unused phone number is no longer collected, and stored ones are purged.
- The step-1 submission matches what the production client requests.
- CASA covers one frozen set.

**Costs and risks:**
- Two submissions and two videos.
- Mail is unavailable to outside users on production until step 2.
- Annual CASA once step 2 passes; vendor pages show hundreds to a few thousand US dollars per assessment [inference].
- Production users connect fresh on the new client.
- A restricted scope added after step 2 may need reassessment.
- Staging testers must sign an agreement; legal may require redaction instead.

**Ownership:**
- `connectors/google.ts` belongs to the Google lane (Mac lane G). `owner-do.ts` edits are registered on #116.
- Console, domain, pages, secrets, wrangler vars, edge redeploys, the lab and publishing are the owner's.

**Impact surface:**
- Contracts: consent scopes, feature map and `googleHas` in `connectors/google.ts`; `connectors/google-consent.ts`.
- Behaviour: connect-ticket shape and reauth notice in `channels/owner-do.ts`; mail tool eligibility; `draft_email`, its skill and prompt text if compose goes; the edge's mail check (edge redeploy).
- Config: one new gate var; Gmail push project per environment.
- App: the `mail` flag keeps its meaning; the app already sends a feature with `google.connect` (`owner-do.ts:924`).
- No migration.

## 5. Verification and tests

- A calendar connect's consent URL has exactly the base bundle.
- Gate off: a mail or Drive connect is refused and mints nothing; the intent says not available yet. Gate on: a mail connect asks for base plus mail.
- After an incremental mail grant, stored scopes are the union and calendar tools still work.
- A declined mail consent leaves the account, its scopes and its calendar tools unchanged, and reads as denied.
- A reconnect of a failing account that held mail asks for base plus mail when the gate is on, and base only, with a notice, when it is off.
- On a base-only grant, `get_communication` returns `auth_required` with feature `mail`.
- A grant without `gmail.compose` passes mail read and send; `draft_email` is not offered; the edge refuses `draft`.
- A `gmail.modify` grant passes mail read.
- A legacy grant with `gmail.readonly`, `gmail.send`, `gmail.compose`, the phone scope or the Docs/Sheets/Slides scopes still works.
- A connect whose returned scopes include the phone scope makes no People call. After the purge, no stored profile has a phone.
- A ticket with no stored feature or an unknown feature is refused.
- Conformance: the production consent set is a subset of the pinned submitted list.
- Before step 2: after disconnect, no mail-derived content for that account is reachable.
- If production holds old-client grants: a refresh failing on such a grant shows a reconnect state, not a silent failure.

## 6. Rollback

- **Code:** revert the slices and the combined dialog returns. Grants made under per-feature consent stay valid, because tools check scopes, not the dialog. Reverting the mail split before compose is dropped from consent is safe; after it, new grants without compose would fail the old mail check, so revert the consent change together with the split.
- **Gate:** turn it off to stop new restricted consents at once; existing grants keep working.
- **Google:** publishing status can return to Testing on the Audience page [inference]. Removing a scope from Data Access is reversible. Verification and CASA spend are sunk.
- **Client:** if the production client must be abandoned, users reconnect on the previous one.

## 7. Owner decisions needed

1. Amend the 24 Sep ruling to per-feature consent.
2. Drop the phone and Docs/Sheets/Slides scopes.
3. Keep or drop `gmail.compose`.
4. `gmail.readonly` or `gmail.modify` for step 2.
5. New production project or the existing one.
6. Accept the production restricted-scope gate.
7. Commission the separate email-body processing ADR.

## 8. Falsifier

Switch to option 1 (one submission after the working agent) if Google refuses or stalls a base-only step-1 submission, if most beta users add mail on their first connect, or if restricted review including CASA finishes within a couple of weeks of the sensitive review. Require staging redaction if legal review finds the tester agreement insufficient.
