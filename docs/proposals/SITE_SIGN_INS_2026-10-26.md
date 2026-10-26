# Waldo's own password store: website sign-ins the browser can use (26 October 2026)

Design note for the owner's ruling of 26 October 2026: "yes build our own password store". The ruling replaces the earlier
"Waldo never stores a password value", and the owner accepted the custody trade-off: Waldo holds testers' site passwords,
and a leak means account takeover. The custody decision is drafted in
[`ADR_DRAFT_SITE_SIGN_INS_2026-10-26.md`](ADR_DRAFT_SITE_SIGN_INS_2026-10-26.md). Nothing here is built yet. Read at
`waldoco/beta-mvp` `51b0c2fd` and `waldoco/feat/vault-rescope` `bbd7e607`.

**In one paragraph.** The owner saves a sign-in (site, username, password, label) in the console Vault. The password is
encrypted by the Worker under a key only the Worker holds, and the ciphertext is stored as one Supabase Vault secret.
The model only learns that a sign-in exists for the page it is on (label, origin, username). It asks to sign in by id.
The harness then does the whole sign-in as one host operation over CDP: fill the username, fill the password, submit,
wait for navigation. That runs only when the page's top-level origin, the form's frame origin and the stored origin are
exactly equal. The first use on a site needs an approval card. The owner may grant "allow on this site", which is
revocable and rechecked by the database on every fill. Every release of a value is logged beside the sign-in and shown
in the Vault. From the moment of the fill, every outbound sink is scanned for the value and fails closed.

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

One aggregate, the **sign-in**, lives in Supabase with one writer: the router-signed functions below, which the Worker
calls only from authenticated console routes and from the host's fill path.

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

create table waldo.site_sign_in_uses (
  id bigint generated always as identity primary key,
  sign_in_id uuid not null references waldo.site_sign_ins (id) on delete cascade,
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  used_at timestamptz not null default now(),
  authority text not null check (authority in ('approval', 'site_allowed')),
  approval_ref text,               -- desk proposal id when authority = 'approval'
  purpose text not null check (purpose in ('fill', 'scan_restore', 'rewrap'))
);
```

- **RLS.** Both tables run `enable` and `force row level security` with no policies, as `waldo.connections` does. Nothing
  reads them except the security-definer functions. The console reads through the Worker.
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

| Function | Does | Returns |
|---|---|---|
| `sign_in_list(do_name)` | Lists the owner's sign-ins | id, origin, username, label, created, updated, last used, uses, allowed_until; never `secret_id` or the envelope |
| `sign_in_store(do_name, origin, username, label, envelope, key_id)` | Inserts the row and its secret | id |
| `sign_in_edit(do_name, id, username?, label?, envelope?)` | Changes username or label. A username change carries the re-wrapped envelope (see below) | boolean |
| `sign_in_replace(do_name, id, envelope, key_id)` | `vault.update_secret`, bumps `generation` | boolean |
| `sign_in_allow(do_name, id, until)` / `sign_in_ask(do_name, id)` | Sets or clears the standing grant | boolean |
| `sign_in_delete(do_name, id)` | Deletes the row; a `before delete` trigger deletes its `vault.secrets` row in the same transaction | boolean |
| `sign_in_release(do_name, id, origin, authority, approval_ref, purpose)` | See below | envelope, key_id, generation, username, or null |
| `sign_in_uses(do_name, id, before)` | Pages the use log | rows |

- **`sign_in_release` is the narrow path.** In one statement it:
  - checks that the row belongs to the owner and that `origin` matches it exactly;
  - when `authority = 'site_allowed'`, checks `allowed_until > now()`;
  - counts today's releases against the per-owner and global caps (ADR rule 7);
  - inserts the use row;
  - for `purpose = 'fill'`, bumps `use_count` and `last_used_at`;
  - returns the envelope.

  A deleted row, a revoked grant or a mismatched origin returns null, and the host refuses.
- **Editing the username.** The username is in the authenticated data, so the edit route re-wraps the value: it
  releases the envelope with `purpose = 'rewrap'`, decrypts and re-encrypts it in memory, and stores the new envelope in
  the same call as the new username. A rewrap is logged, but it is not counted as a use and is never shown as one.
  [proposed]
- **Deletion.**
  - `sign_in_delete` and the row trigger remove the secret with the row.
  - Account deletion is covered by a `before delete on waldo.owners` trigger, `site_sign_in_owner_delete`, in the style
    of `app_push_owner_delete`. It deletes every owner sign-in's `vault.secrets` row; the rows then cascade.
  - `delete_owner` is not redefined a sixth time. Its pgTAP test gains a sign-in fixture and asserts that the Vault row
    count returns to baseline.

## 3. Fill

### What the model sees

- When an observation's top-level origin exactly equals the origin of one or more of the owner's sign-ins, the
  observation carries `saved_sign_ins: [{ id, label, username }]`.
- The model sees nothing for any other origin, so a lookalike page gets no hint.
- There is no tool that lists sign-ins for other sites in v1. [proposed]

### The command

A new `browse_act` command:

```ts
z.strictObject({ operation: z.literal('sign_in'), sign_in_id: z.uuid(), username_ref: z.string().min(1).max(80).optional() })
```

- The command has no value field, and strict mode refuses an extra `password` key.
- The model never names the password target. The harness picks it.
- `username_ref` is optional. The harness uses it only when it is not a secret field and sits in the same form as the
  password field.

### One atomic host operation

1. **Admission.** The command must name a sign-in listed in the current observation's `saved_sign_ins`. The observation
   revision must be current, which is the same stale-observation rule as every action.
2. **Authority.** The sign-in's `allowed_until` must be in the future, or the desk must hold an approved, unconsumed
   `sign_in_use` approval for this sign-in, origin and browser session. Otherwise the harness proposes a card (section
   4) and returns `approval_required`. Nothing is released.
3. **Target.**
   - The password field must be the only visible, enabled, writable `input[type=password]` in its form, and must be in
     the top frame.
   - Two password fields (a sign-up or change-password form) are refused.
   - A form whose `method` is `get` is refused, because the password would land in the URL.
   - So is a form whose `action` resolves to a different origin.
   - A page with a username field and no password field (a two-step login) gets the username only, then implicit
     submission. The password step is a second `sign_in` call on the next page, which repeats every check.
4. **Origin, re-read immediately before the value leaves the host.** The checks run over CDP: `Target.getTargetInfo` for
   the top-level URL, and the frame tree for the field's frame. Top-level origin, frame origin and stored origin must be
   equal as `URL.origin` strings. They must be `https:`, with no userinfo. There is no subdomain, eTLD+1 or `www`
   folding.
5. **Release.** `sign_in_release(..., origin = the origin read in step 4)` is called, the Worker decrypts the envelope
   in memory, and the field's `backendNodeId` and the value are put in the session's **filled registry**.
6. **Fill.**
   - `DOM.focus` on the resolved node, then `Input.insertText`, which is raw CDP. The value never passes through
     `page.evaluate` arguments, Playwright locators, or a Playwright call log.
   - The origin check from step 4 is repeated after the insert. If the origin moved, the harness ends the browser
     session, so the document holding the value is gone, and returns `origin_changed`.
7. **Submit.** Implicit submission: CDP Enter on the password node. Then the harness waits for navigation or settle. No
   observation is built or published between steps 5 and 7.
8. **Publish.** The next observation is built through the filled-registry rules below, then returned as the command's
   result.

Every failure maps to a fixed code: `not_saved_here`, `approval_required`, `origin_mismatch`, `no_password_field`,
`ambiguous_form`, `get_form`, `cross_origin_form`, `frame_refused`, `origin_changed`, `unavailable`. No message
interpolates a value, an envelope, a URL or a database error.

### Filled registry: masking and scanning for the rest of the session

- **Masking by node id.**
  - The filled nodes' `backendNodeId`s join the secret set in the accessibility snapshot and in `field_values`, whatever
    their type becomes.
  - The screenshot mask adds the host selector for those nodes.
- **Exact-value scan at every outbound sink.** Each sink checks the value in raw form and percent-encoded form. A hit
  fails closed: the whole observation is withheld, image included, and replaced with `credential_exposed_on_page`. The
  image cannot be scanned, so a text hit drops it too. The sinks are:
  - the observation (text, accessibility snapshot, `field_values`, element names, title, URL, tabs);
  - the `common-browser:*` checkpoint;
  - the tool-output ledger;
  - the tool result returned to the loop;
  - error strings;
  - the OTLP export;
  - the R2 screenshot write.
- **Model-request sanitiser.** The value is registered as an ephemeral canary, so the existing fail-closed canary check
  covers anything the other scans miss.
- **Lifetime.** The registry lives in Worker memory for the life of the browser session. The checkpoint records only the
  filled sign-in ids and generations.
  - A host that resumes the session without the in-memory registry first restores it with
    `sign_in_release(purpose = 'scan_restore')`. That is logged but not counted as a use.
  - If the restore fails, the host ends the browser session before reading the page again.
- **Engine scope.** Only `cloudflareGeneralBrowser` can sign in. Browser Use, Browserbase/Stagehand and the errand
  engine never receive a sign-in. The launch guard asserts `recording:false` before the first release.

## 4. Approval and standing permission

- **New approval kind `sign_in_use`** on the desk. The card shows:
  - the sign-in's label, origin and username;
  - the task the model is on;
  - "Allow once", "Allow on this site" and "Don't allow".

  The card's payload holds the sign-in id, label, origin, username, browser session id and task ref. It never holds a
  value or envelope.
  - **Allow once** records a single-use approval bound to (sign-in id, origin, browser session id) for 10 minutes. The
    approved effect resumes the task's retained browser session and runs the atomic sign-in. The approval is consumed
    at release. An expired or ended session ends the effect `not_applied`, and the model asks again.
  - **Allow on this site** does the same and also calls `sign_in_allow`. ADR rule 5 sets the grant's time scope; the
    console shows and renews it.
- **Contract.**
  - `sign_in_use` is added to `approvalKindV1Schema` only at a new `x-waldo-app-contract` revision.
  - An app that names an older revision is not sent these cards. The console shows them.
  - The app lane is told before the enum grows, by the additive-only rule.
- **Per-use records.** The use log is the Supabase table, not a desk ledger row. The desk records the proposal as a
  `RecordedLedgerKind` `sign_in_use_proposed`, so the type test that keeps recorded kinds out of approval kinds still
  holds.
- **Rechecks.** The grant is rechecked inside `sign_in_release` on every fill, in the same statement that returns the
  envelope. Revoking or deleting takes effect on the next fill. A fill already holding the value finishes within its
  bounded CDP call.

## 5. Threat model

| Threat | What stops it | Residual |
|---|---|---|
| Prompt injection steers the model to a lookalike (`examp1e.com`, `example.com.evil.io`, `login-example.com`) | No `saved_sign_ins` there; the command needs a listed id; host and SQL both compare exact `URL.origin` | None for the value |
| Subdomain or `www` variant of a real site | Exact origin only; the owner saves another sign-in for that origin | Owner may need two entries for one account |
| Redirect chain ends on another origin | The origin is read at the moment of release and re-read after insert; each redirect hop is already authorised by the route guard | None |
| Navigation races the fill | Re-read after insert; on change the session is ended | None |
| Page script reads the field and echoes it into the DOM | Exact-value scan withholds the observation and image; the model-request canary backs it up | A transformed echo (reversed, base64) is not caught. The exact-origin site is trusted with its own password, as a browser password manager trusts it |
| Show-password toggle flips the field to text | Masking by node id in the accessibility snapshot, `field_values` and the screenshot | None |
| Model asks to "type the password", or a page tells it to | The model never holds the value; `type` and `fill` into password fields are refused; `sign_in` has no value argument and picks its own target | None |
| Password lands in a URL (GET form) | GET and cross-origin `action` forms are refused; the scan covers URL and percent-encoded forms | None |
| Cross-origin login iframe (embedded identity provider) | Top frame only; frame origin must equal top origin; iframes have no refs | Those logins hand off to the owner (`owner_login`) |
| One-time codes, passkeys, CAPTCHAs | Not stored; the observation's `password_field` and `verification_challenge` signals lead to `owner_login` | Owner presence needed for second factors |
| Value in Langfuse, logs, ledger, checkpoint, errors or event payloads | Command args hold only ids; every sink is scanned; fixed error codes; the control-action receipt leaves the add and replace bodies out (`unfingerprinted`) | None, by the canary test |
| Database dump, including the Vault key | Envelope under the Worker key; authenticated data binds the row | Metadata exposed: origins, usernames, labels, use times |
| Database row re-pointed to an attacker's origin | Origin is in the authenticated data, so decrypt fails | None |
| Router HMAC leaks without the Worker key | `sign_in_release` returns only envelopes | None for values |
| **Worker compromise** (holds both the router HMAC and the Worker key) | Per-owner and global daily caps, plus the use log the owner sees | **Every stored value of every owner.** Accepted by the owner 26 Oct as the custody trade-off |
| Console session hijacked | Values are write-only: never displayed, returned or exported; "Allow on this site" is step-up gated (ADR rule 5) | Attacker can delete or replace sign-ins (a denial of service, not a leak) |
| Account deletion or sign-in deletion | Owner-delete trigger; per-row delete trigger; uses cascade | Cloudflare Browser Rendering saw the typed value in transit |
| Cloudflare Browser Rendering (sub-processor) | `recording:false`; the session ends with the task | Cloudflare processes the value when it is typed |

## 6. Privacy

### Notice passage

This is a draft for the privacy and terms document, which is still unpublished. It needs a new notice copy version
before any owner can save a sign-in.

> **Passwords you save in Waldo**
> If you save a website sign-in in Waldo's Vault, Waldo keeps the site, your username, a name you choose and the
> password, so its browser can sign in to that exact website for you. The password is encrypted before it is stored,
> and Waldo's AI models never see it: Waldo types it into the page itself, only on the exact website you saved it for,
> and only after you allow it, once or for that site. Nobody, including you, can read it back from Waldo; you can replace
> or delete it at any time. When Waldo types it, the website receives it as it would from you, and Cloudflare, which
> runs Waldo's browser, processes it while it is typed. Waldo keeps a record of each time it used a sign-in, which you
> can see in the Vault, for one year. Deleting a sign-in, or your account, deletes the password at once.

### Retention

| Data | Kept until |
|---|---|
| Value and metadata | The owner deletes the sign-in, or the account is deleted |
| Use log | 365 days, then a sweep deletes it |
| In-memory value | The end of the browser session |

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

1. **Migration.** The two tables, their functions and the two triggers.
   - pgTAP:
     - RLS forced, with no policies;
     - anon or authenticated selects return nothing;
     - unsigned calls refused;
     - owner isolation: owner B's signature cannot list, release or delete owner A's rows;
     - exact-origin release;
     - grant expiry;
     - the caps;
     - delete trigger and owner-delete trigger leave `vault.secrets` at baseline;
     - `sign_in_list` never returns `secret_id` or the envelope.
   - Locally: PGlite with bundled pgTAP. CI's migrate-from-zero job is the arbiter.
2. **Contracts.**
   - The `sign_in` command, with valid and invalid Zod pairs: extra `password` key, missing id, non-uuid id.
   - The `saved_sign_ins` observation field.
   - The `sign_in_use` approval kind, behind a revision bump.
   - The console Vault DTOs, whose schema cannot hold a value.
3. **Runtime.**
   - Envelope module: encrypt and decrypt, authenticated data, key id. Tests for tampered origin, owner, username and
     generation, and for a wrong key.
   - The release client.
   - The atomic `sign_in` host operation in `cloudflareGeneralBrowser` and `commonBrowserHost`.
   - The filled registry and the sink scans.
   - The ephemeral sanitiser canary.
   - The desk card and effect.
4. **Console.** Vault Passwords UI and the routes. The add and replace actions go in `unfingerprinted`.
5. **Adversarial tests, one per threat row.** These run on real workerd through the full composition, with Langfuse text
   capture on. The fixture site serves:
   - a normal form;
   - a two-step login;
   - a show-password toggle;
   - an echoing div;
   - a GET form;
   - a cross-origin `action`;
   - a cross-origin iframe login;
   - a redirect to a lookalike;
   - a lookalike origin.

   The canary is a synthetic password. The test asserts its absence, raw and percent-encoded, from:
   - provider request bodies;
   - tool results;
   - DO KV (checkpoint, ledger);
   - R2 writes;
   - OTLP export bodies;
   - console output;
   - receipts and event payloads;
   - the desk ledger;
   - thrown errors.

The gate commands are `-r typecheck`, `verify:guards` and `git diff --check`, with pgTAP UNAVAILABLE on macOS (PGlite as
the local substitute) and the full `verify`.

## 9. Impact surface

| Area | Change |
|---|---|
| Contracts | `browserTaskCommandSchema`: additive command. Observation: additive field. `approvalKindV1Schema`: additive behind a revision. New console DTOs |
| Persistence | Two Supabase tables, router-signed functions, two triggers. Nothing new in DO SQLite beyond the checkpoint's filled sign-in ids |
| Secrets | New Worker secret `WALDO_SIGN_IN_KEY`, plus a key id. The owner sets it; no session does |
| Privacy | New notice version; sub-processor wording for Cloudflare |
| Agent tools | `browse_act` gains `sign_in` |
| Downstream repos | waldo-app (later revision); waldo-brain (launch contract and ADR registry, drafted in the ADR file) |
| Rollback | `WALDO_SIGN_INS=0`, committed off until the owner turns it on, hides `saved_sign_ins` and refuses `sign_in`. Dropping the tables is a forward migration that first deletes their Vault rows |

## 10. Owner decisions

| | Decision | Recommendation |
|---|---|---|
| D1 | Envelope under a Worker key (ADR rule 2), or Vault-only plaintext read by a service-role Edge Function | **Envelope.** A database-only breach yields nothing usable, a re-pointed row cannot decrypt, and no Worker-callable function returns plaintext. The Edge Function route would hand plaintext to the Worker anyway, because the Worker types it |
| D2 | Time scope of "Allow on this site" | **90 days, renewable in one tap.** CLAUDE.md requires grants to be time-scoped; the console shows the end date |
| D3 | Step-up on "Allow on this site" | **Yes**, matching `mcp.runs`. Page reads stay unlocked |
| D4 | Daily release caps | **100 per owner and 1000 across the server**, as env values with committed defaults like `PHONE_SMS_DAILY_LIMIT`. Hitting a cap returns `unavailable` with a "try tomorrow or sign in yourself" handoff |
| D5 | Use-log retention | **365 days** (DPDP Rules log retention, subject to counsel) |
| D6 | When the app gets the `sign_in_use` card | **At the app lane's next contract revision.** The console carries the card until then |
