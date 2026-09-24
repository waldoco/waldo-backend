# Connect flow design: how Waldo hands out consent links (and console sign-in) - 2026-09-24

Status: **proposed, for lane review. Nothing in this note is built yet** beyond what "Current state" lists.
Scope: every flow where Waldo gives the owner a link that carries authority (OAuth consent for Google today, later WhatsApp, Discord, Browserbase logins, dashboard sign-in), and the console email sign-in, which is broken today for a separate reason (section 7).

## 1. Problem, from live evidence

Three live failures on 2026-09-24, each with the tail and database evidence behind it:

| Time (IST) | What the owner saw | Root cause (observed) |
|---|---|---|
| 20:27-20:28 | "This link has expired" after approving Google | `connect_service` put the signed consent URL in tool-result text. The model retyped it in its reply and corrupted it: signature 43 -> 8 chars, owner segment rewritten. The state check failed. No `waldo.connections` row. |
| 20:27-20:28 | Every callback URL arrived **twice**, about 2 s apart | The browser or in-app webview reloads. A stateless callback would exchange Google's single-use code twice, and the second exchange fails with `invalid_grant`. |
| 22:35-22:36 | "This link is not valid" (the new page, working as designed) | The model did **not** call `connect_service` (no `tool_connect_service` or `oauth_link_sent` hop). It copied the corrupted 20:28 URL out of **conversation history**: old state format, expired 15:13 UTC, same 8-char MAC. |

What these show:
1. A prompt rule ("never quote links") does not hold. The model broke it on the next turn.
2. Keeping the URL out of the *current* tool result is not enough. Any secret-bearing URL that ever reached history will come back.
3. The URL itself is part of the problem. Google's consent URL is 600-900 characters (client id, redirect, 6 scopes, state, PKCE challenge). It is a poor thing to put in chat, in a button, in an email or in a log.

## 2. How production systems handle this

This summarizes public designs I know of; **I did not re-verify it against current docs for this note**. Treat vendor specifics as leads to confirm, not citations. The standards (RFC 9700, RFC 7636) are stable.

- **OAuth 2.0 Security Best Current Practice (RFC 9700, 2025).** State (or PKCE) binds the callback to the attempt that started it. PKCE (RFC 7636, S256) is recommended for confidential clients too, not only public ones. Authorization codes are single-use, and redirect URIs match exactly.
- **Connector platforms: Nango "connect sessions", Pipedream Connect, Composio, Arcade.** The backend creates a short-lived **connect session token**. The user gets a short first-party link or a hosted connect UI, and the provider URL (with state and PKCE) is built **when the user clicks**. Composio and Arcade tools return an **"authorization required"** result that the **client application** renders. The model is told auth is needed; it never holds the URL.
- **ChatGPT and Claude connectors, Slack and Teams apps.** Connecting happens in the **product UI** (a button, an OAuth popup, a platform card), outside the model's text. The model talks about the connection but never carries the link.
- **Data-loss prevention on model output (enterprise LLM gateways).** A deterministic scanner on the egress path redacts secrets, tokens and signed URLs, as defense in depth when the primary control fails.
- **Magic links and email codes (Slack, Notion, Linear, Supabase Auth).** Short, single-use, short TTL, spent only by a deliberate action. Production senders use their own SMTP or email provider, not a platform's shared test mailer.

The shared principle: **authority travels in structured channels; the model only sees state.**

## 3. Invariants (proposed additions to ENGINEERING_FUNDAMENTALS)

1. **No secret-bearing URL in model context, ever.** That covers tool results, prompts, history, cards and memory. The model sees `auth_required` / `connected` / `link_sent`, never a URL.
2. **Links in chat are short and first-party:** `https://<worker>/c/<ticket>`. The provider URL is minted at click time and never leaves the server-to-browser redirect.
3. **Every OAuth attempt is single-use:** a server-side nonce and PKCE verifier, a 15-min attempt TTL, a callback that settles exactly once, and replays that show the same outcome. *(Built in 240214a.)*
4. **Egress guard:** before any model text reaches a channel, secret-bearing URLs are removed deterministically. This is a hard security line, which the repo's judgment rule allows.
5. **History hygiene:** anything persisted (conversation store, episodes, memory claims, trace text, Langfuse text) is redacted with the same matcher before it is written. Existing corrupted rows are scrubbed once.
6. **Every step is observable** by trace hop, with no secret in any log: link issued -> clicked -> consent returned -> exchanged -> linked.

## 4. Target design

### 4.1 Flow

```
owner: "connect my google"
  model -> connect_service(service: google)
  tool  -> ConnectIntent { status: auth_required, service: google, reason: not_connected }   (no URL)
  runtime (not the model) -> connectSessions.issue(owner, google, channel: telegram)
        -> ticket T (128-bit random, base64url, 22 chars); store sha256(T), owner, provider, expires, status=issued
  channel renderer (telegram) -> sendMessage + inline button "Connect Google" -> https://<worker>/c/T
  model reply (egress-guarded): "Tap Connect Google above."

owner taps button
  GET /c/T  (Worker)
    -> resolve sha256(T) -> owner, provider; reject if unknown, expired or completed (friendly page)
    -> owner DO: startConsent() -> nonce N + PKCE verifier, attempt record {ticket: T-hash}   (exists today)
    -> mark session clicked; 302 Location: accounts.google.com/...&state=<owner>.<N>.<mac>&code_challenge=...
       headers: no-store, referrer-policy no-referrer

Google -> GET /oauth/google/callback?state&code   (exists today)
  -> Worker verifies MAC -> owner DO finishConsent (serial, idempotent) -> proxy exchange with verifier
  -> linked: mark connect session completed; page "Google is connected" + Back to Telegram;
     Telegram message "Google is connected (email)"
```

### 4.2 Why a first-party `/c/<ticket>` link rather than the Google URL in the button

| Property | Google URL in button (today) | `/c/<ticket>` |
|---|---|---|
| Length in chat, email, logs | 600-900 chars | ~60 chars |
| When state/PKCE is minted | when the message is sent (goes stale in 15 min) | at click (the ticket TTL governs, e.g. 30 min) |
| Link previews / scanners | would burn nothing but would log a huge URL | a GET only mints an attempt; nothing is spent until the callback |
| Revocation, "already connected" | not possible after sending | ticket is `completed` -> page says "already connected" |
| Works on channels without buttons (email, SMS, WhatsApp text) | unsafe to paste | safe: useless without the server record, single-owner, short TTL |
| Funnel analytics (sent -> clicked -> linked) | no click signal | click is a hop |

The ticket is a **bearer capability for "start a consent for owner X"**, not a credential. It grants nothing by itself. The owner still has to sign in to Google and approve, and the resulting grant goes to the owner named server-side, not to whoever clicked. The residual risk is that someone who gets the ticket could link *their* Google account into the owner's Waldo. Mitigations: 30-min TTL, single completion, the button goes only to the owner's DM, the owner is notified on link with the account email, and the owner can disconnect in the console. At beta scale this is standard practice (Nango/Pipedream-style connect links carry the same property).

### 4.3 Data model

**Where state lives.** Routing a ticket to its owner is identity data, which Supabase already owns (`waldo.owners`, presences, router-HMAC RPCs). The PKCE attempt stays in the owner DO, where it is today.

```sql
create table waldo.connect_sessions (
  id           uuid primary key default gen_random_uuid(),
  ticket_hash  text not null unique,              -- sha256(ticket), hex; the ticket itself is never stored
  owner_id     uuid not null references waldo.owners (id),
  provider     text not null check (provider in ('google')),
  channel      text not null check (channel in ('telegram','console','email','whatsapp')),
  status       text not null default 'issued' check (status in ('issued','clicked','completed','expired','revoked')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  clicked_at   timestamptz,
  completed_at timestamptz
);
create index connect_sessions_owner_live on waldo.connect_sessions (owner_id, provider) where status in ('issued','clicked');
```

RPCs follow the existing router-HMAC pattern (`waldo.router_signed`): `issue_connect_session(do_name, provider, channel)` returns the ticket once, `resolve_connect_session(ticket_hash)` returns the do_name and provider and marks the session clicked, and `complete_connect_session(ticket_hash)`. RLS: none of these are callable by `anon` without the router signature. Issuing a new session for the same owner and provider revokes older live ones.

*Alternative, if we do not want a migration yet:* keep tickets in the owner DO and put the routing in the path, `/c/<do_name>.<ticket>`. That is simpler, but it puts the Telegram user id in the URL (PII in logs and referers) and cannot serve console or email sessions for owners without a DO route. **Recommend the Supabase table.**

### 4.4 Tool contract: "auth required" as a typed result, not text

`@waldo/contracts` gets a `ConnectIntent` result shape shared by every connector tool:

```ts
type ConnectIntent = { status: 'auth_required'; service: 'google'; reason: 'not_connected' | 'scope_missing' | 'reauth_needed'; feature?: GoogleFeature };
```

- **Which tools return it:** `connect_service`, `query_calendar`, `draft_email`, `get_communication` and any later connector tool return `ok: false, code: 'auth_failed', connect: ConnectIntent`, plus fixed model-facing text ("A connect button is in the chat; tell the owner to tap it").
- **Who acts on it:** the **dispatcher / responder** acts on `connect` and calls the channel's `offerConnect(intent)`. The tool itself never touches Telegram. That removes the per-tool `deliver` plumbing added in b9a4174 and 240214a, and gives WhatsApp, console and email one seam each.
- **Rate limit:** at most one button per owner, service and reason per 60 s. A repeat returns "already sent, point to it".

### 4.5 Channel rendering

| Channel | Rendering of `offerConnect` |
|---|---|
| Telegram | `sendMessage` with inline keyboard URL button -> `/c/<ticket>` (buttons are not link-previewed) |
| Console | "Connect Google" button that POSTs (CSRF-checked) -> issue session -> 303 to `/c/<ticket>` |
| WhatsApp (later) | CTA URL button template -> `/c/<ticket>` |
| Email (later) | short `/c/<ticket>` link; this is the channel where the short link matters most |

### 4.6 Egress guard (defense in depth)

A deterministic function applied to **every model-authored outbound message** (Telegram send, card send, console-rendered model text) and to the **persistence path**:

- **Matches:** `accounts.google.com/o/oauth2`, any URL with a `state=`, `code=`, `code_challenge=`, `access_token=`, `token=` or `sig=` query key, `/c/<22-char>` tickets, and our own `/oauth/*/callback` URLs.
- **Action:** replace the match with `[link removed]`, log hop `egress_redacted` (count and kind only), and if a consent URL was removed, trigger `offerConnect` for that service so the owner still gets a working button.
- **Not a judgment call:** it matches structure, not meaning, so it sits within the repo's rule that deterministic rejects are only for hard security lines.

### 4.7 History hygiene and one-time scrub

- **On write:** the same matcher runs over the conversation store, episode index, memory claims, trace-log text fields and Langfuse text capture (`LANGFUSE_CAPTURE_TEXT=true` is on in staging).
- **One-time scrub:** a DO migration step (the same pattern as `memory_backup` / `memory_migration`) redacts existing rows and logs how many it touched. This removes the corrupted 20:28 link that caused the 22:35 failure.

### 4.8 Observability (funnel)

The hops, all keyed `oauth:<nonce8>` or `connect:<ticket-hash8>`, never raw values:

| Hop | Where | Detail |
|---|---|---|
| `connect_offered` | responder | service, reason, channel, `sent` or `recent` |
| `connect_clicked` | Worker `/c` | outcome: redirected / expired / completed / unknown |
| `oauth_callback` | DO (exists) | linked / denied / expired / invalid / failed (+reason), replayed flag |
| `oauth_exchange` | DO (exists) | proxy / local, ok / error |
| `google_linked` | DO (exists) | scope count |
| `connector_proxy` | edge fn (exists) | op, ok, status, ms |
| `egress_redacted` | responder | count, kinds |

The console trace book already shows these; the E2E checklist should name the funnel.

### 4.9 Security controls checklist

- **Ticket:** 128-bit random, only its hash stored, 30-min TTL, single completion, revoked by a newer ticket, `no-store` responses.
- **`/c` endpoint:** GET-only redirect; rate-limited per IP and per ticket (Cloudflare rate-limit binding, as `RESPONSIBILITY_RATE_LIMITER`); friendly pages for expired, completed and unknown tickets; `referrer-policy: no-referrer`; never reflects input.
- **Callback:** MAC-checked state, single-use nonce, PKCE S256, exact redirect URI, idempotent settle, no throw. *(Built.)*
- **Logs:** never the ticket, code, verifier, token, state, URL or account email.
- **Egress:** the guard sits on every model-authored send.
- **Notification:** the owner is told in-channel whenever an account links, with the account email, so an unexpected link is visible.

### 4.10 Generalization

A small `ConnectorRegistry` entry per provider (consent-URL builder, exchange, scopes, display name) lets WhatsApp Business, Discord, Browserbase logins and Microsoft reuse `/c`, the attempts, the pages and the funnel. Google is the only entry for now. No abstraction beyond one interface until the second provider lands.

## 5. Current state (what is live at release 240214a, worker 81ff9cfe)

| Piece | State |
|---|---|
| Single-use state + PKCE + idempotent callback + result pages + oauth hops | live, proven by tests; the callback rejected the corrupted link correctly at 22:35 |
| Button delivery from `connect_service`, `query_calendar`, `draft_email`, day cards | live |
| First-party `/c/<ticket>` link | **not built** - the button still carries the full Google URL |
| Typed `ConnectIntent` result + channel renderer | **not built** - per-tool `deliver` plumbing |
| Egress guard | **not built** |
| History scrub | **not built** - the corrupted link is still in history and caused the 22:35 failure |
| End-to-end live proof (link -> linked -> calendar answer) | **not yet achieved** |

## 6. Implementation slices (proposed order)

| # | Slice | Proves | Tests / falsifier | Rollback |
|---|---|---|---|---|
| S1 | Egress guard + history scrub | the model can never deliver or recall a secret URL | a reply containing any matched URL reaches Telegram redacted and triggers one button; the scrub migration redacts seeded rows; proven red first | the guard is pure; remove the call |
| S2 | `waldo.connect_sessions` migration + RPCs + pgTAP | tickets resolve only through signed RPC | anon cannot call; the hash only is stored; expiry, single completion, revoke-on-reissue | down migration, table unused |
| S3 | `/c/<ticket>` endpoint + DO `startConsent` link to the session | a short link redirects to a fresh consent | unknown / expired / completed pages; the redirect carries state + challenge; a double GET mints two attempts and completes one | route removed; the button falls back to the direct URL |
| S4 | `ConnectIntent` contract + responder `offerConnect` + Telegram renderer; remove per-tool `deliver` | one seam for all connector tools | every connector tool's auth-failed result carries the intent and no URL; 60 s rate limit | contract is additive |
| S5 | Console "Connect Google" via session + funnel hops in the E2E checklist | console and chat share one path | console POST is CSRF-checked -> 303 `/c/...` | - |
| S6 | Live proof on staging | the owner connects, the page shows success, a `waldo.connections` row exists, a calendar question answers from real data | the tail shows the full funnel | - |

Deploy order for anything touching the proxy stays **edge function first, worker second**.

## 7. Console email sign-in: why no code arrives (diagnosed 2026-09-24 22:46 IST, read-only)

There are three independent causes. Each alone stops the email.

1. **Invite gate (primary).** `consoleAuth.sendCode` sends only if `waldo.signin_allowed(email)` is true: an active owner row with that email, or an open invite. Otherwise it returns silently, by design, so the page does not reveal who is invited. Today: the owner row `5458446350` has `email = null` (the wiring ran without `WALDO_OWNER_EMAIL`), `waldo.invites` has 0 rows, and `auth.users` has 0 rows. So **no address can pass the gate**, and no email is ever requested.
2. **Remote email template.** The remote project's magic-link template has **no `{{ .Token }}`** (subject "Your sign-in link"). `supabase/templates/magic_link.html` and `config.toml` apply only to the local stack; they are not pushed by `db push`. So even past the gate, the owner would get a link, not the code the console asks for. This is the same class as the 2026-09-24 bug-log row "Console email sign-in sent Supabase's default magic-link email", now on the remote.
3. **Mailer.** No custom SMTP is set (`smtp_host` empty), so Supabase's shared default mailer is used. `rate_limit_email_sent` is 2 per hour, and the default mailer is meant for testing: it may deliver only to the project's team members' addresses [inference from Supabase's documented default-mailer limits; confirm in the dashboard]. Also `site_url` is `http://localhost:3000`, and OTP length is 8.

**Fix plan (config and data, no code), for owner approval:**
- **Set the owner email:** set `WALDO_OWNER_EMAIL` in the repo `.env` and update `waldo.owners.email` for `5458446350`. The wiring script's seed is `on conflict do nothing`, so it will not update an existing row; this needs one `update` or an admin invite.
- **Push the auth config:** push the magic-link template and subject to the remote project (management API `PATCH /v1/projects/{ref}/config/auth`: `mailer_templates_magic_link_content`, `mailer_subjects_magic_link`). Set `site_url` to the worker origin, and decide OTP length (6 is conventional; the console accepts any length).
- **Custom SMTP:** configure a transactional email provider (Resend, Postmark or SES) with its own sender domain, and raise the email rate limit to a sane beta value.
- **Guard:** add a guard or live check that the *remote* template contains `{{ .Token }}`. The existing `guard-otp-template.mjs` checks only the repo file.
- **Admin visibility:** the silent "not allowed" path should log a hop (`console_signin`, `allowed: false`, no email) so a denied sign-in shows in the trace book instead of looking like a mail failure.

## 8. Open decisions for the owner

1. **Ticket store:** Supabase `connect_sessions` (recommended) or DO-only with owner in the path.
2. **Ticket TTL:** 30 min (recommended; attempt TTL stays 15 min, minted at click).
3. **Email provider for auth mail** (Resend, Postmark or SES) and its sender domain.
4. **OTP length:** 6 or 8.
5. **Scope of the egress guard:** Waldo-issued and provider-OAuth URLs only (recommended), or any URL with credential-like query keys, including third-party links the model legitimately shares.
6. **Scrub coverage for Langfuse:** redact at capture only, or also purge already-exported staging traces.
