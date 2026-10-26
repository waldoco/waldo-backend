# Waldo's own password store: website sign-ins the browser can use (26 October 2026)

Design note for the owner's ruling of 26 October 2026: "yes build our own password store". The ruling replaces the earlier
"Waldo never stores a password value", and the owner accepted the custody trade-off: Waldo holds testers' site passwords,
and a leak means account takeover. The custody decision is drafted in
[`ADR_DRAFT_SITE_SIGN_INS_2026-10-26.md`](ADR_DRAFT_SITE_SIGN_INS_2026-10-26.md). Nothing here is built yet. Read at
`waldoco/beta-mvp` `51b0c2fd` and `waldoco/feat/vault-rescope` `bbd7e607`.

**In one paragraph.** The owner saves a sign-in (site, username, password, label) in the console Vault.
- **Storage.** The password is encrypted by the Worker under a key only it holds, and the ciphertext is stored as one
  Supabase Vault secret.
- **What the model sees.** It only learns that a sign-in exists for the page it is on (label, origin, username), and it
  asks to sign in by id.
- **The fill.** The harness does the whole sign-in as one fenced host operation over CDP: fill the username, fill the
  password, submit, wait for navigation. That runs only when the page's top-level origin, the form's frame origin and
  the stored origin are exactly equal, and only while the frame, the loader and the focused node are the ones checked.
- **Authority.** The first use on a site needs an approval card, recorded as a single-use row that the database
  consumes at release. In owner turns that read nothing from outside that site, the owner may grant "allow on this
  site", which the database rechecks on every release.
- **Logging and caps.** Every release is logged beside the sign-in and counted against daily caps.
- **After the fill.** The value lives in memory for at most 10 minutes. While a filled field is on the page, no
  screenshot leaves the host, and every outbound sink is scanned for the value and fails closed.
- **Open choice.** Whether the key and the fill move into a dedicated custodian Worker is owner decision D7.

## 1. What exists today (observed at source)

### Browser path

- **Model tools.** The model drives the browser through `browse_page` and `browse_act`
  (`packages/runtime/src/tools/records.ts:121,142`). Commands are `browserTaskCommandSchema`
  (`packages/contracts/src/tools/schemas/reads.ts:310-332`).
  - Actions target host-issued element refs. The model never supplies selectors or scripts
    (`channels/general-browser-observation.ts:31-38`).
  - `type` and `fill` carry free text up to 1000 characters (`reads.ts:313,320`).
  - The driver refuses `fill` into password, OTP, hidden, file, checkbox and radio inputs
    (`channels/cloudflare-general-browser.ts:483`).
  - Enter or a submit click inside a form is refused (`channels/common-browser-host.ts:265`).
- **Engine.** The live engine is `cloudflareGeneralBrowser` (`channels/cloudflare-general-browser.ts:27`), Cloudflare
  Browser Rendering through `@cloudflare/playwright`. Launch guard options set `recording:false`
  (`channels/cloudflare-browser-adapter.ts:45-56`). `browserUseErrandEngine` is a separate vendor agent over REST, and
  its prompt says never to type a password (`channels/browser-use-errand-engine.ts:184`). The Browserbase/Stagehand
  fallback is natural-language only (`tools/live/browser.ts:188-275`).
- **What reaches the model from a page** (`cloudflare-general-browser.ts:335-369`, `common-browser-host.ts:110-135`):
  - `document.body.innerText`, cut to 8000 characters. It holds no input values, but it does hold anything the page
    echoes into the DOM.
  - The element list. Secret inputs (`type=password` or `autocomplete~=one-time-code`) get `secret:true` and an empty
    value (`general-browser-observation.ts:28,52`).
  - `field_values`: the live value of every input, textarea and select except types password, file and hidden
    (`common-browser-host.ts:132`). **A password sitting in a field whose type is no longer `password`, for example after
    a show-password toggle, goes to the model here.**
  - The accessibility snapshot, built from CDP `Accessibility.getFullAXTree`. Secret nodes are found by
    `backendNodeId`, named `[owner credential field]`, and lose their value, description and children (`:292-332`).
    Every other textbox's `value` is emitted (`:329`). Playwright's `ariaSnapshot` serialises password values and is
    never published (`:292-293`).
  - A screenshot, masked by the CSS locator `input[type="password"]` plus OTP fields (`:341-345`). It goes to the model
    as an image (`common-browser-host.ts:126-130`, `owner-browser-runtime.ts:296`, `owner-turn.ts:651-659`). **The mask
    follows the element's current type, so a type flip unmasks it.**
- **Where tool inputs and outputs go next:**
  - Langfuse/OTLP gets `text: {input: arguments, output}` for every tool call (`owner-turn.ts:507,672`). This is gated
    by `LANGFUSE_CAPTURE_TEXT` outside production (`observability/trace-privacy.ts:92`), and staging records all
    testers. The only scrub is the health scrub (`trace-privacy.ts:47-50`).
  - Reply receipts keep the parsed args (`owner-turn.ts:670`).
  - The tool-output ledger keeps outputs cut to 500 characters in DO KV `toolout:`
    (`conversation/tool-output-ledger.ts:52,62,184-197`).
  - The browser checkpoint in DO KV, `common-browser:<taskId>`, keeps the observation minus the image, including
    non-secret field values and the page text (`common-browser-host.ts:117-125`).
  - The R2 workspace keeps masked screenshots (`channels/browser-screenshot-workspace.ts:38`).
- **Canaries.** Every model request passes the scribe with the session's three canary tokens. A canary or
  `SECRET_PATTERNS` hit fails closed (`llm/provider.ts:1505-1580`, `scribe/sanitiser.ts:301-313,653-687`).
  `SECRET_PATTERNS` matches key and token shapes, not a bare password.
- **Redirects and frames.**
  - `guardGeneralBrowserRoute` authorises every redirect hop with `maxRedirects:0` and rejects subframe redirects
    (`channels/general-browser-redirects.ts:14-64`).
  - Egress is allowed by exact `URL.origin` against the grant (`common-browser-host.ts:92`).
  - Observation walks only the top document and open shadow roots, never iframes, so an iframe has no refs
    (`general-browser-observation.ts:19-23`).
- **Requests cross the Worker.**
  - The route guard re-issues every request in the context through `route.fetch` (`general-browser-redirects.ts:23`), so a
    login POST's body passes through the Worker's route handler.
  - A 307/308 that would replay a POST body is refused (`:44-45`).
  - Page console messages are not captured by any browser module.
- **Turn taint is a category.** `SourceTaint` has no source origins (`hooks/registry.ts:151`).
  `taintedCallNeedsOwnerApproval` (`:452-468`) cards any claimed call in an external-tainted turn unless the tool's
  record is exempt.
- **Owner login handoff.** The owner takes control in a Cloudflare live view (`channels/native-browser-handoff.ts`,
  `channels/browser-login-handoff.ts`, the `owner_login` command). Automation and reads pause while the owner types.
- **Stored per-site browser state.** `browserStateCustody`, `siteScopedCustody` and `scopeBrowserState` exist and key by
  exact origin, but they are unwired (`channels/browser-state-custody.ts:40-80`, `browser-site-custody.ts:2`). Sessions
  keep sign-ins only for the provider session's life (`cloudflare-general-browser.ts:192`).

### Secret custody

- **The runtime holds no service-role key** (`identity/owner-directory.ts:61`, ADR-0052). The Worker calls
  router-signed SQL functions with the publishable key (`signedRpc`, `:62-82`). `waldo.router_signed` checks an HMAC
  under the Vault secret `waldo_router_hmac` with a 300-second window
  (`supabase/migrations/20261003000000_waldo_router_signed_fail_closed.sql`).
- **No function the Worker can call returns a plaintext secret.** `20260924180000_waldo_connector_proxy.sql:1-5`
  dropped the Worker-callable `connection_secret` because "tokens never reach the runtime". Google tokens are read only
  by the `connector-proxy` and `oauth-proxy` Edge Functions, which hold the service role
  (`supabase/functions/connector-proxy/index.ts:15,33-39,76-77`).
- **`waldo.delete_owner`** (newest: `20261011230000_delete_owner_identity.sql:10-44`) finds Vault rows only through named
  `secret_id` columns (`waldo.connections` UNION `waldo.app_push_devices`). It deletes them from `vault.secrets`
  directly, because hosted staging has no `vault.delete_secret`
  (`20260928130000_waldo_delete_owner_vault_portable.sql`). The push table also has a
  `before delete on waldo.owners` trigger, `app_push_owner_delete` (`20261010040000_app_push_custody.sql:157-164`).
- **Migrate-from-zero** is the CI job "Supabase migrate-from-zero and pgTAP" (`.github/workflows/verify.yml:123-160`).
  The tests are in `supabase/tests/*.sql`. `waldo_delete_owner_identity.sql` shows the router-signature fixture and
  Vault row counting.

### Approvals

- **Kinds.** `approvalKindV1Schema` (`packages/contracts/src/app/parts.ts:18`) is `calendar_change`, `email_send`,
  `message_send`, `browser_submit`, `mcp_call`, `google_task_change` and `tainted_action`. The desk card table is
  `channels/approvals.ts:203-209`, plus a second list at `:1495`.
- **Recorded ledger kinds** (`approvals.ts:161-163`) must never be approval kinds. A type test enforces it
  (`console-vault.test.ts:213` on `beta-mvp`, `console-access-log.test.ts:134` on the rescope branch).
- **`BrowserSubmitProposal`** (`approvals.ts:53-63`) stores raw binding values in the ledger `payload_json` and masks
  them only for display. A password must never enter it.
- **The one precedent for a standing grant** is MCP "runs without asking" (`connectors/mcp-connections.ts:216,229-230,564-581,641-645`):
  - A grant counts only while the definition digest it was given for still matches.
  - Turning it off deletes the row.
  - Dispatch rechecks the grant.
  - The console action `mcp.runs` is step-up gated (`channels/console-step-up.ts:61`).
- **App contract.** Installed app builds parse `app.v1` strictly. A response grows only when the request names a later
  revision in `x-waldo-app-contract` (`packages/contracts/src/app/core.ts:8-26`). The backend drops approvals that fail
  `appApprovalV1Schema` (`channels/app-approvals.ts:23-27`).

### Console Vault

- On `beta-mvp`, `channels/dashboard-vault.ts` and `dashboard-app/src/Vault.tsx` show memories, connections and an
  access log behind step-up. Vault.tsx:144 says passwords are "Coming with 1Password. Waldo will never see or store
  your passwords."
- `feat/vault-rescope` (`bbd7e607`, not merged) reshapes it:
  - It deletes `dashboard-vault.ts` and moves the access log to Patrol (`/console/dashboard/api/v1/access-log`).
  - It removes the Vault step-up.
  - It leaves a static Passwords panel ("each sign-in you save is encrypted, used only on its own website, and never
    shown to Waldo's model") and a Payments panel.
  - The Passwords UI builds on that branch once it merges.

## 2. Storage

One aggregate, the **sign-in**, lives in Supabase with one writer: the router-signed functions below. The Worker calls
them only from authenticated console routes, the desk's approval path and the host's fill path.

```sql
create table waldo.site_sign_ins (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  origin text not null,            -- exact URL.origin, https only, set at creation, never edited
  username text not null,
  label text not null,
  secret_id uuid not null references vault.secrets (id) deferrable initially deferred,
  key_id text not null,            -- which Worker key wrapped the value
  generation int not null default 1,   -- bumps on every password replace
  allowed_until timestamptz,       -- the standing grant; null = ask each time
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  use_count int not null default 0
);
create unique index site_sign_ins_one_per_account on waldo.site_sign_ins (owner_id, origin, lower(username));

-- A one-time approval, written when the owner approves a sign_in_use card and consumed by exactly one release.
create table waldo.site_sign_in_approvals (
  approval_ref text primary key,   -- the desk proposal id
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  sign_in_id uuid not null references waldo.site_sign_ins (id) on delete cascade,
  session_ref text not null,       -- the browser session the approval is bound to
  approved_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at <= approved_at + interval '10 minutes'),
  consumed_at timestamptz
);

create table waldo.site_sign_in_uses (
  id bigint generated always as identity primary key,
  request_id uuid not null unique, -- one per release attempt; a repeated id is refused
  sign_in_id uuid references waldo.site_sign_ins (id) on delete set null,  -- the row outlives its sign-in, content-free
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  session_ref text,                -- browser session, for fill and scan_restore
  used_at timestamptz not null default now(),
  authority text not null check (authority in ('approval', 'site_allowed', 'console', 'fill_session')),
  approval_ref text,
  purpose text not null check (purpose in ('fill', 'scan_restore', 'rewrap'))
);
```

- **RLS.** All three tables run `enable` and `force row level security` with no policies, as `waldo.connections` does.
  Nothing reads them except the security-definer functions. The console reads through the Worker.
- **The value.** The ADR's envelope rule sets how the value is held:
  - The Worker encrypts it with AES-256-GCM under `WALDO_SIGN_IN_KEY`, a Worker secret, as
    `v1.<key_id>.<iv>.<ciphertext>`.
  - The authenticated data is `owner_id | sign_in_id | origin | lower(username) | generation`.
  - The envelope is stored with `vault.create_secret`.
  - A row whose origin, owner, username or generation was changed on the database side then fails to decrypt.
  - The database never holds plaintext.
- **Functions.** Each is `security definer`, `search_path = ''`, revoked from public, granted to `anon`, and requires
  `waldo.router_signed`. The signed message covers every argument; for the store and replace functions that means the
  sha256 of the envelope.
- **Owner presence for writes.** Every write a console or approval action makes also takes the hash of the owner's
  live console or app session, and the function checks it against that owner's live session rows. [proposed; PR 2
  confirms the column names] This covers store, edit, replace, allow, ask, delete, approve and rewrap.

| Function | Does | Returns |
|---|---|---|
| `sign_in_list(do_name)` | Lists the owner's sign-ins | id, origin, username, label, created, updated, last used, uses, allowed_until; never `secret_id` or the envelope |
| `sign_in_store(do_name, session, origin, username, label, envelope, key_id)` | Inserts the row and its secret | id |
| `sign_in_edit(do_name, session, id, username?, label?, envelope?, request_id?)` | Changes username or label. A username change carries the re-wrapped envelope and the `request_id` of its `rewrap` release | boolean |
| `sign_in_replace(do_name, session, id, envelope, key_id)` | `vault.update_secret`, bumps `generation` | boolean |
| `sign_in_allow(do_name, session, id, until)` / `sign_in_ask(do_name, session, id)` | Sets or clears the standing grant. `until` is at most 90 days ahead | boolean |
| `sign_in_delete(do_name, session, id)` | Deletes the row. A `before delete` trigger deletes its `vault.secrets` row in the same transaction; its approvals cascade | boolean |
| `sign_in_approve(do_name, session, approval_ref, sign_in_id, session_ref)` | Writes the one-time approval (see section 4) | boolean |
| `sign_in_release(do_name, id, origin, purpose, request_id, session_ref, approval_ref?, console_session?)` | See below | envelope, key_id, generation, username, or null |
| `sign_in_uses(do_name, id, before)` | Pages the use log | rows |

- **`sign_in_release` is the narrow path.** In one transaction it:
  1. checks that the row belongs to the owner and that `origin` matches it exactly;
  2. refuses a `request_id` already in `site_sign_in_uses` (replay);
  3. resolves authority by purpose:
     - **`fill` with an `approval_ref`.** It consumes the matching approval row atomically:
       `update ... set consumed_at = now() where approval_ref = $ and owner_id = $ and sign_in_id = $ and session_ref = $ and consumed_at is null and expires_at > now()`.
       A second use of the same approval finds no row.
     - **`fill` without one.** It needs `allowed_until > now()`.
     - **`scan_restore`.** It needs a `fill` use for this sign-in and `session_ref` within the last 10 minutes.
     - **`rewrap`.** It needs a live console session of the owner.
  4. counts the release against that purpose's per-owner budget, the per-owner total and the server total for the UTC
     day (below);
  5. inserts the use row;
  6. for `fill`, bumps `use_count` and `last_used_at`;
  7. returns the envelope.

  A deleted row, a revoked or expired grant, a consumed or expired approval, a repeated `request_id`, a mismatched
  origin or a spent budget returns null, and the host refuses with a fixed code.
- **Caps (every purpose counts).** The values are SQL constants, which are hard ceilings. The Worker may pass lower
  values from env, with committed defaults, as `PHONE_SMS_DAILY_LIMIT` does.

  | Budget per UTC day | Ceiling |
  |---|---|
  | `fill` per owner | 100 |
  | `scan_restore` per owner | 20 |
  | `rewrap` per owner | 20 |
  | All purposes per owner | 140 |
  | All purposes across the server | 1000 |

  One owner can use at most 140 of the server's 1000, or 14%, so a noisy or compromised owner path cannot starve other
  owners alone. Reaching a cap returns `cap_reached`, and the model hands off to the owner's own sign-in.
- **Key rotation is out of band.** Rotation never goes through `sign_in_release` and is never reachable from an owner
  turn, a console route or the model. It is a one-off job:
  - The owner authorises it per run.
  - It runs outside the runtime Worker, in one of two places:
    - Under D7 option B, in the custodian.
    - Under option A, in a dedicated rotation Worker deployed only for the run and deleted after it, with no routes
      beyond its signed trigger.

    `WALDO_SIGN_IN_KEY_NEXT` and the rotation HMAC are never in the runtime Worker's env, and the key-isolation guard
    fails if the runtime's Wrangler config or code names them. An operator script on a workstation is rejected,
    because it would put both keys on a laptop.
  - It runs with `WALDO_SIGN_IN_KEY_NEXT` set and a rotation HMAC that the database holds only for the run, under a
    Vault name separate from `waldo_router_hmac`.
  - `sign_in_rotate_batch` re-wraps a bounded batch per call. It logs each row as a rotation in its own run record, not
    in the owner use log, and its budget is the count of sign-ins at the start of the run.
  - The run ends by deleting the rotation HMAC and retiring the old key id. Envelopes still on the old key id refuse to
    decrypt.
- **Editing the username.** The username is in the authenticated data. The edit route releases with
  `purpose = 'rewrap'` and a fresh `request_id`, decrypts and re-encrypts in memory, and stores the new envelope in the
  same call as the new username. A rewrap counts against its budget but is never shown as a use.
- **Deletion.**
  - `sign_in_delete` and the row trigger remove the secret with the row. Its approvals cascade. Its use rows stay,
    with `sign_in_id` nulled.
  - Account deletion is covered by a `before delete on waldo.owners` trigger, `site_sign_in_owner_delete`, in the style
    of `app_push_owner_delete`. It deletes every owner sign-in's `vault.secrets` row; the rows then cascade.
  - `delete_owner` is not redefined a sixth time. Its pgTAP test gains a sign-in fixture and asserts that the Vault row
    count returns to baseline.

## 3. Fill

### What the model sees

- When an observation's top-level origin exactly equals the origin of one or more of the owner's sign-ins, the live
  tool result carries `saved_sign_ins: [{ id, label, username }]`.
- The model sees nothing for any other origin, so a lookalike page gets no hint.
- `saved_sign_ins` is never persisted. It is stripped before the `common-browser:*` checkpoint, the tool-output ledger,
  the offload store, receipts and the OTLP export, so a deleted sign-in's label and username do not outlive it in
  Waldo's records. The next observation re-adds it while the sign-in exists.
- **Where tool results persist** (observed):
  - Only the tool-output ledger keeps them, in DO KV `toolout:`, at most 6 rows per kind, cut to 500 characters
    (`conversation/tool-output-ledger.ts:52,62`). They are not rows of the conversation chain.
  - Compaction summarises the chain, the owner's and Waldo's messages, and its instruction drops tool mechanics
    (`conversation/compaction.ts:26-34`).
  - Episodes index saved chat messages (`channels/episodes.ts:7-8`) [inference: no tool rows; PR 2 asserts].
  - So the strip at the ledger covers persisted history and compaction. A label or username reaches the transcript, a
    summary or episodes only through Waldo's own reply text. That is the existing chat residual, which forget
    reaches.
- There is no tool that lists sign-ins for other sites in v1. [proposed]

### The command and its record

A new `browse_act` command:

```ts
z.strictObject({ operation: z.literal('sign_in'), sign_in_id: z.uuid(), username_ref: z.string().min(1).max(80).optional() })
```

- The command has no value field, and strict mode refuses an extra `password` key.
- The model never names the password target. The harness picks it.
- `username_ref` is optional. The harness uses it only when it is not a secret field and sits in the same form as the
  password field.
- **Record.** `browse_act` keeps `ownerTurnOnly: false` and its `commits_on_card` taint exemption for its other steps.
  The `sign_in` command carries its own claim, `sign_in_filled`, and the turn rules in section 4: a standing grant
  counts only in an owner turn whose outside reads all came from the sign-in's exact origin. Every other turn gets a
  card.

### One atomic host operation

1. **Admission.** The command must name a sign-in listed in the current observation's `saved_sign_ins`, and the
   observation revision must be current. Only the Cloudflare CDP engine admits it.
2. **Authority.** The turn rule (section 4) decides between a standing grant and a card. If a card is needed, the
   harness proposes it and returns `approval_required`, and nothing is released. The approved effect re-enters at step
   3 with its `approval_ref`.
3. **Target.**
   - The password field must be the only visible, enabled, writable `input[type=password]` in its form, and must be in
     the top frame.
   - Two password fields (a sign-up or change-password form) are refused.
   - A form whose `method` is `get` is refused, because the password would land in the URL.
   - So is a form whose `action` resolves to a different origin.
   - A page with a username field and no password field (a two-step login) gets the username only, then submission. The
     password step is a second `sign_in` call on the next page, which repeats every step.
   - The harness captures the main frame's `frameId` and `loaderId` and the target node's `backendNodeId`.
4. **Fence on.** From here until the submission request is dispatched (step 8), every document request is checked
   against the stored origin:
   - The check runs in the context's existing route guard (`guardGeneralBrowserRoute`, which is Playwright's CDP
     `Fetch` interception).
   - It covers top-level navigations, frame navigations and popups; any to another origin is aborted.
   - While fenced, `goto`, `back`, `open_tab`, `switch_tab` and `download` are refused.
   - After submit, exactly one document request is let through: the submission itself, to the stored origin, matching
     the form's checked method and action.
   - From then on the fence admits only that request's own redirect chain. That chain is the route guard's
     host-followed GET hops, each still authorised by the egress grant, so a normal post-login redirect to another
     origin (`login.example.com` to `app.example.com`, or an SSO hop) completes. Every other document request to
     another origin stays aborted while a filled node still holds a value.
   - Those hops carry no body. The route guard turns a 301/302/303 after a POST into a GET and refuses a 307/308 that
     would replay a POST body (`general-browser-redirects.ts:43-45`). The URL scan still catches the value echoed into a
     `Location`.
   - This meets "through submit": the value leaves for the stored origin's submission and nowhere else by navigation.
     Same-origin script that sends the value by other means is the stated residual of trusting the exact-origin site.
5. **Intent, then release.**
   - The host writes the intent to the checkpoint before any I/O: sign-in id, `request_id` and session ref.
   - It then calls `sign_in_release` with the origin read over CDP.
   - The Worker decrypts in memory and puts the value and the target `backendNodeId` in the session's **filled
     registry**.
   - A lost answer is never retried with the same `request_id`. A retry is a new attempt and counts against the cap.
6. **Pre-insert checks**, all over CDP and immediately before each insert:
   - From step 3 on, the harness listens for main-frame `Page.frameStartedNavigating` and `Page.frameNavigated`,
     including a back-forward cache restore. Any such event before an insert aborts it; any after an insert ends the
     session.
   - The main frame's `frameId` and `loaderId` are unchanged.
   - The top-level origin and the field's frame origin equal the stored origin.
   - The form's `method` and `action` still pass step 3.
   - `DOM.focus` is called on the resolved `backendNodeId`.
   - `Runtime.evaluate('document.activeElement')` is resolved through `DOM.describeNode` to the same `backendNodeId`. A
     page that moves focus on the focus event fails here.
7. **Insert, bound to the node.** The username, then the password, are each written into the resolved node itself,
   never into whatever document has focus.
   - The node is resolved once at step 3 (`DOM.resolveNode` on its `backendNodeId`, in the main world of that
     document's execution context). Then one `Runtime.callFunctionOn` runs on that `objectId`, with a fixed,
     host-authored function and the value as its only argument.
   - The function sets the value through the native `HTMLInputElement.prototype` value setter and dispatches `input`
     and `change` events, so frameworks see it as typed. It returns only a boolean, with `returnByValue` and `silent`
     set.
   - If the document is gone, whether it navigated, was swapped by a back-forward cache restore, or was destroyed, the
     object's context no longer exists and the call fails. A navigation that makes no network request therefore cannot
     redirect the value into another origin's document. This replaces `Input.insertText`, which writes into the focused
     element of whichever document is current.
   - The value never passes through `page.evaluate` source text, Playwright locators or a Playwright call log. CDP
     exception details never carry the argument [inference: PR 2 asserts it with the canary].
   - The step 6 checks repeat after each insert. Any mismatch ends the browser session and returns `origin_changed`.
   - **Back-forward cache.** It is turned off for sign-in sessions where Browser Rendering allows it, by a launch flag or
     a page-level opt-out [inference: probe on real Browser Rendering]. The node-bound write is the guarantee either
     way.
8. **Submit.**
   - The checks of step 6 run once more, including form `method` and `action`.
   - The harness submits through `Runtime.callFunctionOn` on the form's own object: `this.requestSubmit()`, with no
     argument. That is bound to the node like the insert, and it runs the form's validation and submit handlers as a
     user's submit does.
   - Only if the page neither navigates nor settles, and the password node still holds the value, does the harness fall
     back to `Input.dispatchKeyEvent` Enter. It first re-runs the step 6 checks and confirms, through a no-argument
     call on the node's object, that the node is its document's `activeElement`. The keypress carries no value, so
     the worst a race can do is press Enter in another document.
   - The submission request crosses the route guard in the Worker carrying the value in its body. The route guard
     never reads, logs or keeps `postData`, and its errors map to fixed codes.
9. **Wait** for the main frame's `loaderId` to change or the page to settle. No observation is built or published
   between steps 5 and 9.
10. **Clear, fence off, publish.**
    - If the page settled without navigating (an XHR login), the harness clears every filled node that is still
      attached. It runs `Runtime.callFunctionOn` on the node's object with a function that empties its value and
      returns only whether it is now empty. No argument is passed, so the value never crosses.
    - The fence lifts once no filled node holds a value: every one is detached, or empty.
    - The next observation is built through the filled-registry rules below.

Every failure maps to a fixed code. No message interpolates a value, an envelope, a URL, a database error or a CDP or
Playwright error string. The codes are `not_saved_here`, `approval_required`, `origin_mismatch`, `no_password_field`,
`ambiguous_form`, `get_form`, `cross_origin_form`, `frame_refused`, `focus_moved`, `origin_changed`, `cap_reached`,
`fenced` and `unavailable`.

### Filled registry: after the fill

- **Moving the value is refused.** While a filled node holds a value, any `type`, `fill`, `press`, `select` or
  `set_checked` aimed at a filled node is refused with `fenced`. The command schema has no select-all, copy, cut, paste,
  drag or clipboard operation, and adding one reopens this ADR.
- **Chrome's own credential features are off.** The harness calls CDP `Autofill.disable` and launches without the
  password manager's save service (`credentials_enable_service` off) where Browser Rendering accepts it. [inference: PR 2
  probes both on real Browser Rendering and records UNAVAILABLE for any it cannot confirm]. Profiles are ephemeral,
  since no `storageState` is kept (`cloudflare-general-browser.ts:192`), and the session ends at the plaintext bound
  below.
- **Masking by node id.** The filled nodes' `backendNodeId`s join the secret set in the accessibility snapshot and in
  `field_values`, whatever their type becomes.
- **Screenshots are withheld** while any filled node still holds a value: attached and not empty, checked by the same
  value-free `Runtime.callFunctionOn`. That applies to the observation image,
  the `screenshot` command and R2 writes. A canvas or CSS echo cannot be masked or text-scanned, so withholding is the
  only safe rule. The observation says `image_withheld: 'sign_in_on_page'` and still carries scanned text.
- **Exact-value scan at every outbound sink.** The value is checked raw and percent-encoded. A hit fails closed: the
  whole observation is withheld, image included, and replaced with `credential_exposed_on_page`. The sinks are:
  - the observation: text, accessibility snapshot, `field_values`, element names, title, URL and tabs;
  - the `common-browser:*` checkpoint;
  - the tool-output ledger and offload store;
  - the tool result returned to the loop;
  - error strings;
  - the OTLP export;
  - R2 writes.
- **Model-request sanitiser.** The value is registered as an ephemeral canary, so the existing fail-closed canary check
  covers anything the other scans miss.
- **Sinks that must not exist.**
  - Page console messages are not captured today. No `page.on('console')`, `Runtime.consoleAPICalled` or
    `Log.entryAdded` is wired in the browser modules, and a guard keeps it that way.
  - Request logs carry no URL or body. The route guard never touches `postData`.
  - Playwright and CDP protocol debug logging (`DEBUG=pw:*`) stays off. A guard fails if a Wrangler config, env
    default or code path enables it.
- **The plaintext lifetime is bounded.** The value lives only in the owner object's memory. It is dropped at the
  earlier of two points: no filled node holds the value any more (the document changed, or the nodes were cleared) or
  10 minutes after release.
  - If a filled node still holds a value at 10 minutes, the browser session ends. After the step 10 clear that is rare,
    so an XHR login keeps its signed-in session past the bound; only the plaintext is dropped.
  - Once the value is dropped, scanning for it ends. A later page on the same exact origin that echoes it from the
    server is a stated residual.
  - The checkpoint records only filled sign-in ids, generations and release times.
  - A host that resumes within the 10 minutes without the in-memory value restores it with
    `sign_in_release(purpose = 'scan_restore')`, which the database allows only within 10 minutes of that session's
    fill. If the restore fails, the host ends the browser session before reading the page again.
- **Engine scope.** Only `cloudflareGeneralBrowser` can sign in. Browser Use, Browserbase/Stagehand and the errand
  engine never receive a sign-in. The launch guard asserts `recording:false` before the first release.
- **Key isolation.** A conformance guard fails if any module other than the envelope module reads `WALDO_SIGN_IN_KEY`.
  It also fails if `env` (or `this.env`) is passed to `JSON.stringify`, structured logging, an error constructor or a
  trace. The envelope module imports the key once as a non-extractable `CryptoKey`. Owner decision D7 weighs moving the
  key and the fill into a dedicated custodian Worker.

## 4. Approval and standing permission

- **New approval kind `sign_in_use`** on the desk.
  - The card offers "Allow once", "Allow on this site" and "Don't allow".
  - **Ledger contents.** The card's payload holds only the sign-in id, browser session ref, task ref and `request_id`.
    The ledger `summary` is fixed text ("Sign in with a saved sign-in?").
  - The label, origin and username are looked up from `sign_in_list` when the card is rendered. A deleted sign-in
    renders as "a sign-in you deleted". With nothing else in the ledger, there is nothing to scrub on delete.
  - It never holds a value or an envelope.
- **Allow once.**
  - The desk's approve path runs only from an authenticated owner approval route, in the console or the app.
  - It calls `sign_in_approve` with the owner's live session hash. That writes a single-use row bound to the sign-in,
    `session_ref` and approval ref, valid for 10 minutes.
  - The approved effect resumes the task's retained browser session and runs the atomic sign-in with that
    `approval_ref`. `sign_in_release` consumes the row in the same transaction that returns the envelope.
  - An expired or ended session ends the effect `not_applied`, and the model asks again.
- **What the database check does and does not stop.** It stops a model-path bug, a replayed request, and a stolen
  router HMAC used without a live owner session from releasing a value without an approval. It does not stop a
  compromised runtime Worker that holds a live owner session token: the Worker signs both calls.
- **Allow on this site.**
  - It does what Allow once does and also calls `sign_in_allow` with `until` at most 90 days ahead.
  - It is step-up gated like `mcp.runs`.
  - The console shows the end date and renews it.
- **Turn rules.** Whether a standing grant counts is decided by the turn:
  - **Owner turns only.** Inbound mail, proactive, scheduled, subagent and every other machine turn always get a card,
    whatever the grant.
  - **Taint by source.** In an owner turn, the grant counts only when every outside read in the turn's context came
    from pages of the sign-in's own exact origin. Any other outside content gets a card: mail, other sites, search
    results, files, MCP results, or tainted history from earlier turns.
  - **Observed gap.** Today's taint is a category with no source origins: `SourceTaint` (`hooks/registry.ts:151`).
    `taintedCallNeedsOwnerApproval` (`:452-468`) cards any claimed call in an external-tainted turn unless the record
    is exempt, and `commits_on_card` exempts only typed browser steps.
    - PR 2 adds a `sign_in_filled` case. It reads the turn's outside-read origins from the turn's tool events and
      browser observations, and passes only when all of them equal the sign-in's origin.
    - Without that, any taint means a card, and a standing grant would rarely apply, because reading the login page
      taints the turn.
- **Contract.**
  - `sign_in_use` is added to `approvalKindV1Schema` only at a new `x-waldo-app-contract` revision.
  - An app that names an older revision is not sent these cards. The console shows them.
  - The app lane is told before the enum grows, by the additive-only rule.
- **Per-use records.** The use log is the Supabase table, not a desk ledger row. The desk records the proposal as the
  `RecordedLedgerKind` `sign_in_use_proposed`, so the type test that keeps recorded kinds out of approval kinds still
  holds.
- **Rechecks.** `sign_in_release` rechecks the grant, or consumes the approval, on every fill, in the same statement
  that returns the envelope. Revoking or deleting takes effect on the next fill. A fill already holding the value
  finishes within its bounded CDP calls.

## 5. Threat model

| Threat | What stops it | Residual |
|---|---|---|
| Prompt injection steers the model to a lookalike (`examp1e.com`, `example.com.evil.io`, `login-example.com`) | No `saved_sign_ins` there; the command needs a listed id; host and SQL both compare exact `URL.origin` | None for the value |
| Subdomain or `www` variant of a real site | Exact origin only; the owner saves another sign-in for that origin | Owner may need two entries for one account |
| Redirect chain ends on another origin | The origin is read at release and before every insert; each redirect hop is already authorised by the route guard | None |
| Navigation races the fill, including one with no network request (a back-forward cache restore from `history.back()` by the page or a cross-origin iframe) | The value is written through `Runtime.callFunctionOn` on the resolved node, so a gone document fails the call. Main-frame navigation events abort before an insert and end the session after one. The fence covers network navigations. `frameId` and `loaderId` are checked before each insert. The back-forward cache is off where Browser Rendering allows [inference] | The fallback Enter keypress could land in another document; it carries no value |
| Post-login redirect to another origin of the same service | Only the submission's own body-less GET redirect chain is admitted, each hop authorised by the egress grant | None; it is how those sign-ins complete |
| XHR login leaves the filled field on the page | After settle, the harness empties it with a value-free `Runtime.callFunctionOn`; screenshots resume once no field holds the value | None |
| Page moves focus to another field during the fill | The write targets the node, not the focus; `activeElement` must still resolve to the target before each insert and before a fallback Enter | None |
| Page swaps the form's `method` or `action` after the checks | Re-checked before each insert and before submit | Same-origin script can still send the value anywhere the egress grant allows; the exact-origin site is trusted with its own password |
| Page script reads the field and echoes it into the DOM | Exact-value scan withholds the observation; screenshots are withheld while the field is on the page; the model-request canary backs it up | A transformed echo (reversed, base64) is not caught, and neither is a server echo after the value is dropped. The exact-origin site is trusted with its own password, as a browser password manager trusts it |
| Show-password toggle, canvas or CSS rendering of the value | Masking by node id in the accessibility snapshot and `field_values`; no screenshot while a filled node holds a value | None for the model |
| Model asks to "type the password", or a page tells it to | The model never holds the value; `type` and `fill` into password fields are refused; `sign_in` has no value argument and picks its own target | None |
| Model or page moves the value (select-all, copy, paste, drag, or typing into the filled field) | Commands aimed at filled nodes are refused; no clipboard or drag command exists | None |
| Chrome saves or autofills the password | `Autofill.disable`; no password-manager save service; ephemeral profile; session bound | [inference] until PR 2 probes it on real Browser Rendering |
| Password lands in a URL (GET form) | GET and cross-origin `action` forms are refused; the scan covers URL and percent-encoded forms | None |
| Submission body in the Worker's route guard | `postData` is never read, logged or kept; route errors are fixed codes; a POST-replaying 307/308 is refused | The value transits the Worker, which holds it anyway |
| Cross-origin login iframe (embedded identity provider) | Top frame only; frame origin must equal top origin; iframes have no refs | Those logins hand off to the owner (`owner_login`) |
| One-time codes, passkeys, CAPTCHAs | Not stored; the observation's `password_field` and `verification_challenge` signals lead to `owner_login` | Owner presence needed for second factors |
| A standing grant used in a turn steered by outside content | Grants count only in owner turns whose outside reads all come from the sign-in's own origin; otherwise a card | See the PR 2 evidence note in section 4 |
| Replay of a signed release, or a reused approval | `request_id` is unique and signed; the approval row is consumed atomically | None |
| Value in Langfuse, logs, console messages, protocol debug logs, ledger, checkpoint, errors or event payloads | Command args hold only ids; every sink is scanned; fixed error codes; no console capture; debug logging off by guard; the add and replace bodies are left out of control-action receipts (`unfingerprinted`) | None, by the canary test |
| A deleted sign-in's label, origin or username outlives it | The ledger holds only the id; `saved_sign_ins` is never persisted; use rows lose the reference | What the model said in chat stays in the transcript like any reply; forget reaches it |
| Database dump, including the Vault key | Envelope under the Worker key; authenticated data binds the row | Metadata exposed: origins, usernames, labels, use times |
| Database row re-pointed to an attacker's origin | Origin is in the authenticated data, so decrypt fails | None |
| Router HMAC leaks without the Worker key | `sign_in_release` returns only envelopes; one-time approvals and console writes need a live owner session | None for values |
| **Any code-execution or supply-chain compromise of the runtime Worker** (it holds the router HMAC, the Worker key, live session tokens in transit and every filled value) | Daily caps, every purpose counted; the use log the owner sees; the key guard. A custodian Worker (D7) would take the key and the plaintext out of the runtime | **Every stored value of every owner,** at up to 1000 releases a day. Accepted by the owner 26 Oct as the custody trade-off |
| Console session hijacked | Values are write-only: never displayed, returned or exported; "Allow on this site" is step-up gated | Attacker can delete or replace sign-ins (a denial of service, not a leak) |
| Account deletion or sign-in deletion | Owner-delete trigger; per-row delete trigger; approvals cascade; use rows lose their sign-in reference (sign-in delete) or cascade (account delete) | Cloudflare Browser Rendering saw the typed value in transit |
| Database backup or point-in-time restore holds a deleted envelope | The envelope needs the Worker key; rotating the key and retiring the old key id makes backed-up copies undecryptable | Until rotation, someone holding both a backup and the current key can recover a deleted value |
| Cloudflare Browser Rendering (sub-processor) | `recording:false`; the session ends at the plaintext bound or with the task | Cloudflare processes the value when it is typed |

## 6. Privacy

### Notice passage

This is a draft for the privacy and terms document, which is still unpublished. It needs a new notice copy version
before any owner can save a sign-in.

> **Passwords you save in Waldo**
> If you save a website sign-in in Waldo's Vault, Waldo keeps the site, your username, a name you choose and the
> password, so its browser can sign in to that exact website for you. The password is encrypted before it is stored,
> and Waldo is built so its AI models never receive it: Waldo types it into the page itself, only on the exact website
> you saved it for, and only after you allow it, once or for that site. No Waldo screen, export or reply shows it, to
> you or anyone else; you can replace or delete it at any time. When Waldo types it, the website receives it as it
> would from you, and Cloudflare, which runs Waldo's browser, processes it while it is typed. Waldo records each time it
> used a sign-in, which you can see in the Vault. Deleting a sign-in deletes the password from Waldo's database at once;
> encrypted copies in database backups expire with the backups. After you delete a sign-in, Waldo keeps a record of when
> it was used, without the website, username or name, for one year from each use. Deleting your account deletes all of
> it, records included.

### Retention

| Data | Kept until |
|---|---|
| Value and metadata | The owner deletes the sign-in, or the account is deleted. Encrypted copies stay in Supabase backups and point-in-time restore for that plan's window; rotating `WALDO_SIGN_IN_KEY` and retiring the old key id ends their decryptability early |
| Use log | 365 days from each use, then a sweep deletes it. Deleting a sign-in nulls `sign_in_id`, so the remaining rows hold only owner, time, authority and purpose (no origin, username or label). Account deletion cascades them at once |
| In-memory value | The earlier of the filled document being gone and 10 minutes after release; the browser session ends if a filled field is still on the page at 10 minutes |

[inference, verify with counsel] Account deletion erasing the use log follows the erasure duty. If counsel reads the
DPDP log-retention rule as overriding erasure for security logs, the owner-delete trigger keeps content-free rows
detached from the owner instead; that is a one-line change in PR 2.

### India DPDP

[inference, verify with counsel] Waldo is the Data Fiduciary. Under the DPDP Act, 2023:

- **Section 5 (notice).** The passage above is the itemised notice.
- **Section 6 (consent).** Saving a sign-in is the clear affirmative action for this purpose, and nothing else uses the
  data.
- **Section 8(5) (reasonable security safeguards).** Covered by the envelope, write-only reads and the use log.
- **Section 8(6) (breach intimation).** A breach of this store goes to the Data Protection Board and to every affected
  owner.
- **Section 8(7) (erasure).** Erasure when the sign-in is deleted.

The DPDP Rules, 2025 were notified in November 2025, with obligations phased in through May 2027:

- They name encryption, masking, access control, logging and monitoring as minimum safeguards.
- Secondary sources disagree on which rule carries the one-year retention of logs; the 365-day use log is set to meet
  it.
- They require breach intimation without delay, and a detailed report to the Board within 72 hours.

Sources: [Mondaq on the notified Rules](https://www.mondaq.com/india/data-protection/1708164/digital-personal-data-protection-rules-2025-notified), [Lawrbit](https://lawrbit.com/article/digital-personal-data-protection-rules-2025), [Scrut](https://www.scrut.io/post/dpdp-rules). The rule numbers must be checked against the notified text before the notice ships.

### GDPR

A stored password is ordinary personal data, not Art-9 data. Art. 32 security applies, and Art. 33 and Art. 34 breach
duties apply.

### Health

A sign-in holds no health value. The use log's origins can reveal a health provider (a pharmacy or a patient portal),
so origins never go into metric labels or logs. Logs carry only fixed codes and counts.

## 7. Product: console Vault, Passwords section

This builds on `feat/vault-rescope`'s Passwords panel once it merges. Page reads stay unlocked, per the owner's
26 October ruling.

| Feature | Behaviour |
|---|---|
| List | Label, site, username, added, last used, times used, and "Asks each time" or "Allowed on this site until …" |
| Add | Site URL (stored as its origin), username, password, label. Shows the stored origin back before saving. The password input is write-only, with `autocomplete="new-password"` |
| Edit | Label and username only. The origin is immutable; a new site is a new sign-in |
| Replace password | Write-only field. Never pre-filled or shown |
| Delete | Confirm, then delete at once |
| Allow on this site / ask each time | The grant toggle, step-up gated |
| Uses | Per sign-in, newest first: time, how it was allowed (once or on this site), and the task |

**There is no reveal, copy or export path.** The list API's schema has no field that could carry a value.

**App parity** is a later additive `app.v1` revision: a read-only list and the `sign_in_use` card.

## 8. PR 2: implementation plan (TDD)

PR 2 starts only after the gate approves this design and the owner rules on D7.

1. **Migration.** The three tables, their functions and the two triggers.
   - pgTAP:
     - RLS forced, with no policies;
     - anon or authenticated selects return nothing;
     - unsigned calls refused;
     - owner isolation: owner B's signature or session cannot list, approve, release or delete owner A's rows;
     - exact-origin release;
     - grant expiry and the 90-day ceiling;
     - one-time approval consumed once, and refused after expiry or for another session ref;
     - a repeated `request_id` refused;
     - `scan_restore` refused outside the 10 minutes after a fill;
     - every purpose's budget, the per-owner total and the server total;
     - writes refused without a live owner session;
     - delete trigger and owner-delete trigger leave `vault.secrets` at baseline;
     - `sign_in_list` never returns `secret_id` or the envelope.
   - Locally: PGlite with bundled pgTAP. CI's migrate-from-zero job is the arbiter.
2. **Contracts.**
   - The `sign_in` command, with valid and invalid Zod pairs: extra `password` key, missing id, non-uuid id.
   - The `saved_sign_ins` field and `image_withheld`.
   - The `sign_in_use` approval kind, behind a revision bump.
   - The console Vault DTOs, whose schema cannot hold a value.
3. **Runtime.**
   - Envelope module: encrypt and decrypt, authenticated data, key id. Tests for tampered origin, owner, username and
     generation, a wrong key and a retired key id.
   - The release and approve clients.
   - The atomic `sign_in` host operation: fence, navigation-event abort, frame and loader checks, focus check, node-bound
     write, `requestSubmit`, re-checked Enter fallback.
   - The filled registry: node masks, screenshot withholding, refusals of commands aimed at filled nodes, sink scans,
     the 10-minute bound and `scan_restore`.
   - The ephemeral sanitiser canary.
   - The desk card (id-only payload) and effect.
   - The `sign_in_filled` taint case.
4. **Guards.**
   - Key isolation: only the envelope module reads `WALDO_SIGN_IN_KEY`, and `env` is never serialised.
   - Browser modules capture no console or log events.
   - No `DEBUG=pw:*`.
   - The route guard never reads `postData`.
5. **Console.** Vault Passwords UI and the routes. The add and replace actions go in `unfingerprinted`.
6. **Adversarial tests, one per threat row.** These run on real workerd through the full composition, with Langfuse text
   capture on. The fixture site serves:
   - a normal form;
   - a two-step login;
   - a show-password toggle;
   - an echoing div;
   - a canvas echo;
   - a focus-stealing field;
   - a form whose `action` changes after load;
   - a navigation started during the fill;
   - a GET form;
   - a cross-origin `action`;
   - a cross-origin iframe login;
   - a redirect to a lookalike;
   - a lookalike origin;
   - a 307 to another origin after submit;
   - a page that logs the field to its console;
   - a same-page script that calls `history.back()` when the field gains focus;
   - a cross-origin iframe that calls `history.back()` when the field gains focus.

   For the two `history.back()` fixtures, the earlier document (on another origin) records every value and input event
   it receives, and the canary must never appear there.

   The canary is a synthetic password. The test asserts its absence, raw and percent-encoded, from:
   - provider request bodies;
   - tool results;
   - DO KV (checkpoint, ledger, offload store);
   - R2 writes;
   - OTLP export bodies;
   - Worker console output;
   - receipts and event payloads;
   - the desk ledger;
   - thrown errors;
   - route-guard logs.

   Turn-rule tests:
   - a standing grant cards in an inbound-mail turn, a proactive turn, and an owner turn that read another site;
   - it runs without a card in an owner turn that read only the sign-in's origin.
7. **Live probes on real Browser Rendering** (staging, synthetic site and synthetic credentials only, under the
   staging authority of the day): `Autofill.disable`, the password-manager launch preference, and the fence on a
   cross-origin navigation. Whatever cannot be confirmed is recorded UNAVAILABLE in PR 2.

The gate commands are `-r typecheck`, `verify:guards` and `git diff --check`, with pgTAP UNAVAILABLE on macOS (PGlite as
the local substitute) and the full `verify`.

## 9. Impact surface

| Area | Change |
|---|---|
| Contracts | `browserTaskCommandSchema`: additive command. Observation: additive fields. `approvalKindV1Schema`: additive behind a revision. New console DTOs |
| Persistence | Three Supabase tables, router-signed functions, two triggers. Nothing new in DO SQLite beyond the checkpoint's filled sign-in ids and release times |
| Secrets | New Worker secret `WALDO_SIGN_IN_KEY` plus a key id. A rotation HMAC exists only for a rotation run. The owner sets them; no session does. Under D7 option B they live on the custodian Worker instead |
| Privacy | New notice version; sub-processor wording for Cloudflare |
| Agent tools | `browse_act` gains `sign_in`; the taint rule gains `sign_in_filled` |
| Guards | Key isolation, no console capture, no protocol debug logging, no `postData` access |
| Downstream repos | waldo-app (later revision); waldo-brain (launch contract and ADR registry, drafted in the ADR file) |
| Rollback | `WALDO_SIGN_INS=0`, committed off until the owner turns it on, hides `saved_sign_ins` and refuses `sign_in`. Dropping the tables is a forward migration that first deletes their Vault rows |

## 10. Owner decisions

| | Decision | Recommendation |
|---|---|---|
| D1 | Envelope under a Worker key (ADR rule 2), or Vault-only plaintext read by a service-role Edge Function | **Envelope** (accepted by the gate). A database-only breach yields nothing usable, a re-pointed row cannot decrypt, and no Worker-callable function returns plaintext. The Edge Function route would hand plaintext to the Worker anyway, because the Worker types it |
| D2 | Time scope of "Allow on this site" | **90 days, renewable in one tap.** CLAUDE.md requires grants to be time-scoped; the console shows the end date |
| D3 | Step-up on "Allow on this site" | **Yes**, matching `mcp.runs`. Page reads stay unlocked |
| D4 | Daily release caps | **100 fill, 20 scan_restore and 20 rewrap per owner (140 in all), and 1000 across the server**, as SQL ceilings with lower env defaults. One owner can use at most 14% of the server's day |
| D5 | Use-log retention | **365 days from each use, content-free after the sign-in is deleted, erased with the account** (DPDP Rules log retention as read from secondary sources, subject to counsel) |
| D6 | When the app gets the `sign_in_use` card | **At the app lane's next contract revision.** The console carries the card until then |
| D7 | Where the key and the fill live | See below. **Recommended: B, if its spike passes; otherwise A** |

### D7: where the key and the fill live

**A. In the runtime Worker** (this design as written).

- The envelope module, release, decrypt and fill all run in the owner object, behind the key-isolation guard.
- *For:* no new deployable, no cross-Worker browser hand-over, and the scan runs where the observation is built.
- *Against:* any code-execution or supply-chain compromise of the runtime (the model tooling, every dependency, every
  route) reaches the key, the router HMAC and every value. The guard stops accidental reads only, not hostile code.

**B. A dedicated custodian Worker.**

- A small, separately deployed Worker holds `WALDO_SIGN_IN_KEY`, its own Browser Rendering binding and a release HMAC
  separate from the runtime's router HMAC. The release functions then accept only that HMAC.
- It exposes one service-binding RPC, `signIn(ownerDoName, signInId, browserSessionId, approvalRef?, requestId)`.
  1. It attaches to the task's Browser Rendering session by id: the runtime detaches, and the custodian connects with
     the same SDK `connect(binding, { sessionId })` the runtime already uses (`cloudflare-general-browser.ts:164-167`).
  2. It runs steps 3 to 9 of the atomic operation and detaches.
  3. It returns a fixed code and the filled `backendNodeId`s, never the value.
- The runtime keeps masking by node id and withholding screenshots. The exact-value scan becomes a scan oracle: the
  runtime sends each outbound text to the custodian's `scan(browserSessionId, texts)` and gets back a yes or no. The
  custodian holds the value for the 10-minute bound. The oracle's limits:
  - It answers only for sessions it filled.
  - It answers only whether the whole value occurs, raw or percent-encoded, in the submitted text. It never answers
    for a prefix, a substring or a position, so it cannot be used to guess the value a character at a time.
  - Its queries are rate-capped per session and per owner, and counted in content-free counters beside the use log.
- *For:* a compromise of the runtime no longer yields any password. It can still drive fills to the exact origins
  under approvals or grants (the runtime writes approvals) and act inside the signed-in session. That is account use,
  not password theft, and it stays capped and visible in the use log. The custodian's dependency surface is the
  browser SDK and Web Crypto, and it carries no model code.
- *Against:*
  - a second Worker to deploy, version, configure and gate;
  - a detach and reattach of the browser session for every sign-in, which costs latency, and Browser Rendering's
    single-connection behaviour must allow the hand-over [inference: needs a spike on real Browser Rendering];
  - a scan round trip on every observation in the 10 minutes after a fill;
  - a second HMAC secret and a second set of release grants.
- *Spike before PR 2:* on staging, with a synthetic site and synthetic credentials, a runtime-held session is detached,
  the custodian attaches, fills and detaches, and the runtime reattaches with its state intact. If that fails, B is not
  buildable on Browser Rendering today, and A ships with the guard.

**Recommendation: B, if the spike passes.** The owner accepted custody risk for "a leak means account takeover", and B
shrinks that from every value to capped account use for any runtime compromise. That is the largest remaining lever.
The cost is one Worker and one spike, before any tester saves a real password. If the spike fails, A ships, and B stays
the first hardening step once a second-client hand-over works.
