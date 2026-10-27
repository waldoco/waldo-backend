# Moving staging onto heywaldo.in

Staging is served from `waldo-runtime-staging.piyushfulper3210.workers.dev`, and every OAuth callback and webhook
names that host, which carries a personal account name. This runbook moves them to `staging.heywaldo.in`. It keeps
the website (Vercel), Google Workspace mail and Resend auth mail working, and keeps the old host serving until every
callback has moved. The Google OAuth app is published only after the old host is retired (owner ruling, 27 Oct 2026).

Hostnames, one Worker origin per environment, with the console at `/console` on it:

| Environment | Worker origin | `WALDO_PUBLIC_ORIGIN` |
|---|---|---|
| Staging | `staging.heywaldo.in` | `https://staging.heywaldo.in` after cutover |
| Production (later) | `app.heywaldo.in` | `https://app.heywaldo.in`, with `workers_dev: false` from the first deploy |

Don't use `auth.` (Resend auth mail), `mail.` (reserved for agent mail) or the apex and `www` (Vercel).

Who does what:
- **Owner:** every DNS, registrar and provider-console step.
- **Gate session:** deploys, and only to staging.
- **Scripts:** checks, plus provider calls the owner has said yes to.

## How the Worker chooses its host

`WALDO_PUBLIC_ORIGIN` is the one origin the Worker puts in everything it issues or registers:
- the Google, MCP and WHOOP OAuth callbacks;
- the Telegram webhook;
- Calendar watch addresses;
- console, export and file links;
- the iMessage console reply.

It is read in `packages/runtime/src/connectors/public-origin.ts`. Unset, the request's own origin is used.

Each owner object adopts the configured value when it starts, so alarm work for an owner who sends nothing (Calendar
watch renewals, scheduled cards, connect offers) names the configured host too. Unset, owners kept the origin of their
last request, and with both hosts serving, requests through the other host would move them back and forth.

The Telegram webhook belongs to the bot, not to an owner, so it does not move with the value: it is re-pointed by hand
at cutover (checklist item 5).

A browser that opens a connect ticket (`/c/…`) or a console page on the other host is redirected (307) to the
configured one before any cookie is set, so its browser binding, console cookie and OAuth callback land on one host.
Old console and invite links keep working: browsers carry the `#fragment` across the redirect. Form posts, page script
calls, the console sign-in callback, webhooks, `/app/v1` and `/healthz` are never redirected.

Some flows that start and finish in one browser, or that describe the request they answer, stay on the request's own
host:
- console Google sign-in;
- Photon start;
- the MCP client metadata document;
- the Gmail push audience check.

## Phases

1. **Pin.** `WALDO_PUBLIC_ORIGIN` is set to the workers.dev host. Behaviour is unchanged.
2. **Zone.** heywaldo.in moves to Cloudflare (section "DNS move" below).
3. **Serve both.** A deploy with the custom-domain route and an explicit `workers_dev: true`.
   - Check: `https://staging.heywaldo.in/healthz` and the workers.dev `/healthz` report the same release.
   - Wrangler turns workers.dev off whenever routes are set and `workers_dev` is not. `guard-wrangler-local-bindings.mjs` enforces the explicit value.
4. **Register the new callbacks** next to the old ones (checklist items 1–3).
5. **Cut over.** Set `WALDO_PUBLIC_ORIGIN=https://staging.heywaldo.in` and deploy. Then move the single-target webhooks (items 5–8).
6. **Retire.** Do this only once every condition in item 9 holds. Remove the old entries and set `workers_dev: false`.

**Rollback:**
- Before phase 5, nothing issued has changed.
- After it, set `WALDO_PUBLIC_ORIGIN` back to the workers.dev host and deploy. Owner objects adopt it as they start. Point Telegram and the other single-target webhooks back by hand.

## DNS move (owner, with Claude checking)

These are the records on GoDaddy on 27 Oct 2026, found by querying `ns65.domaincontrol.com`. GoDaddy refuses zone
transfers, so this table is a cross-check. The source of truth is GoDaddy's zone-file export.

| Name | Type | Value | Cloudflare proxy |
|---|---|---|---|
| `@` | A | `216.198.79.1` (Vercel) | DNS only |
| `www` | CNAME | `cname.vercel-dns.com` | DNS only |
| `_vercel` | TXT | `vc-domain-verify=www.heywaldo.in,…` | — |
| `@` | MX | `1 smtp.google.com` | — |
| `@` | TXT | `google-site-verification=…` (verifies the domain for Google, needed to publish the OAuth app) | — |
| `google._domainkey` | TXT | Google Workspace DKIM, 2048-bit, **two strings** | — |
| `_dmarc` | TXT | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` | — |
| `send.auth` | CNAME | `send.forge.rmta.net` (Resend return path: MX and SPF come through it) | DNS only |
| `resend._domainkey.auth` | TXT | Resend DKIM | — |
| `_domainconnect` | CNAME | `_domainconnect.gd.domaincontrol.com` | Leave it out; it is GoDaddy-only |

Facts about the zone:
- DNSSEC is off (no DS record at the `.in` registry), so there is no DNSSEC step.
- The parent NS TTL is 900 s.
- There are no CAA, AAAA or wildcard records.
- There is no SPF record at the apex. Workspace mail passes DMARC through DKIM alignment only. Step 6 below is the optional fix.

### 1. Prepare (owner present; nothing visible changes)

1. **GoDaddy:** go to DNS → **Export zone file**, and keep the file. It is the record list and the rollback reference.
2. **Cloudflare:** use the account that owns `waldo-runtime-staging`. Workers Custom Domains need the zone on the Worker's own account. Add a site → `heywaldo.in` → **Free** plan, then import the GoDaddy zone file.
3. **Reconcile** the imported records with the export and the table above:
   - Set every A and CNAME record to **DNS only (grey cloud)**. A proxied Vercel or Resend record breaks Vercel certificate renewal and Resend verification later, without an error at the time.
   - Delete anything Cloudflare added that is not in the export.
   - Leave out `_domainconnect`.
4. **Don't enable Cloudflare Email Routing** on heywaldo.in. It replaces the Google MX. Agent mail goes on `mail.heywaldo.in` only, and later.
5. **Note** the two nameservers Cloudflare assigns.

### 2. Check before switching (Claude)

Diff every record between GoDaddy and a Cloudflare nameserver, including both DKIM strings, byte for byte:

```bash
for n in heywaldo.in www.heywaldo.in _vercel.heywaldo.in _dmarc.heywaldo.in google._domainkey.heywaldo.in send.auth.heywaldo.in resend._domainkey.auth.heywaldo.in; do for t in A CNAME MX TXT; do diff <(dig +short $t $n @ns65.domaincontrol.com | sort) <(dig +short $t $n @CF_NAMESERVER | sort) || echo "MISMATCH $t $n"; done; done
```

Switch only when the loop prints nothing.

### 3. Lower TTLs (optional, at least an hour before)

In GoDaddy, set the record TTLs to 600 s. This only speeds up fixing a single record afterwards. The switch itself
is seamless because both sides serve identical answers.

### 4. Switch (owner, at GoDaddy)

Go to Domain → Nameservers → Change → "I'll use my own nameservers", and enter the two Cloudflare nameservers.
Change nothing else at the registrar.

### 5. Check after switching

- `dig +short NS heywaldo.in @ns4.registry.in` names Cloudflare, and the Cloudflare zone shows **Active**.
- The diff loop from step 2 is clean against `1.1.1.1` and `8.8.8.8`.
- `https://heywaldo.in` and `https://www.heywaldo.in` load, and Vercel shows both domains as valid.
- **Inbound mail:** a message from a personal account to a heywaldo.in Workspace address arrives.
- **Outbound mail:** the reply shows `DKIM: PASS` and `DMARC: PASS` for heywaldo.in under "Show original".
- **Resend:** one Supabase auth code to a tester arrives from `no-reply@auth.heywaldo.in` with DKIM passing for `auth.heywaldo.in`.
- Google Search Console still lists heywaldo.in as verified.

### 6. Optional, owner-approved: an SPF record for Google Workspace

Add `@ TXT "v=spf1 include:_spf.google.com ~all"`. Do it in Cloudflare after the switch has been checked, as its own
change, so a mail problem can be traced to one step.

Facts to weigh before adding it:
- Resend sends with its own return path under `send.auth`, so this record does not cover Resend.
- `~all` soft-fails other senders rather than rejecting them.

Check it with a Workspace message whose headers show `SPF: PASS`. Remove the record to undo it.

### Rollback

- At GoDaddy, set the nameservers back to `ns65.domaincontrol.com` and `ns66.domaincontrol.com`. The zone-file export from step 1 restores any record GoDaddy no longer holds.
- Keep the Cloudflare zone, unchanged, for at least a day. Resolvers that cached Cloudflare's NS records (TTL 86400) keep asking it, and identical records on both sides answer them correctly.

## Re-registration checklist

Start this only after phase 3, once `https://staging.heywaldo.in/healthz` answers. Every provider-console step needs
the owner's yes first.

| # | Item | Who | Verify |
|---|---|---|---|
| 1 | Google Cloud, project waldo-dev-492217, OAuth client "Web client 1": **add** `https://staging.heywaldo.in/oauth/google/callback`. Keep the old one. | Owner, or Claude in the browser with the owner watching | After item 4, a Google connect from the app completes |
| 2 | Supabase Auth (staging): **add** `https://staging.heywaldo.in/console/signin/google/callback` to the redirect allow list. At item 4, change the Site URL to `https://staging.heywaldo.in/console/signin`. | Script (Management API `PATCH /v1/projects/{ref}/config/auth`) on the owner's yes | Re-read the config; console Google sign-in works on the new host once enabled |
| 3 | Photon OAuth client: **add** `https://staging.heywaldo.in/imessage/photon/callback` | Owner | The Photon connect from `/console/imessage` completes |
| 4 | Deploy `WALDO_PUBLIC_ORIGIN=https://staging.heywaldo.in` | Gate session | `/healthz` reports the release; a connect link sent in chat names `staging.heywaldo.in` |
| 5 | **Required, straight after item 4:** Telegram `setWebhook` to `https://staging.heywaldo.in/telegram/webhook` with the same secret token and allowed updates (`message`, `callback_query`). Nothing moves it automatically. | Script on the owner's yes | `getWebhookInfo` names the new host with 0 pending, then a real message gets a reply |
| 6 | Meta WhatsApp app webhook: `https://staging.heywaldo.in/whatsapp/webhook`, same verify token | Owner (Meta dashboard), or the WhatsApp MCP tool on the owner's yes | Meta's verification succeeds on save; a real message gets a reply |
| 7 | GitHub webhook on waldoco/waldo-backend: `https://staging.heywaldo.in/events/github` | Script (`gh api -X PATCH repos/waldoco/waldo-backend/hooks/<id>`) on the owner's yes | Recent deliveries show 2xx |
| 8 | Gmail Pub/Sub push subscription (`waldo-gmail-push`, waldo-dev-492217): change the endpoint **and** the audience together to `https://staging.heywaldo.in/events/gmail` | Owner, or `gcloud pubsub subscriptions modify-push-config` on the owner's yes | Pub/Sub shows acks; new mail wakes a connected owner |
| 9 | **Retire the old host.** Start only once all of these hold: at least 7 days after item 4, so every Calendar watch channel has renewed onto the new address; every tester is on an app build that uses the new origin; invite links issued before item 4 have expired (14 days) or been re-issued; and a day of traffic on the new host shows no failures. Then remove the old Google redirect, the old Supabase allow-list entry and the old Photon redirect, and deploy `workers_dev: false`. | Owner and gate session | The old `/healthz` stops answering; a probe pass on the new host is clean |
| 10 | Publish the Google OAuth app | Owner | Consent screen status |

New registrations name the new host from the start:
- Slack (`/oauth/mcp/callback`, see `PRE_REGISTERED_OAUTH_CLIENTS.md`);
- WHOOP: register `https://staging.heywaldo.in/oauth/whoop/callback` in the WHOOP developer portal. The Worker derives its redirect and the
  start page the app opens from `WALDO_PUBLIC_ORIGIN`, and the app accepts a start page on either reviewed staging host, so WHOOP moves
  with the cutover. If WHOOP is set up before cutover, register both hosts' callbacks;
- any MCP server, which registers itself with the current origin.

The edge finds a pre-registered client's secret by issuer **and exact redirect address** (`waldo.oauth_client_secret`), so a
client seeded under one host is not found under the other. A client seeded before cutover (WHOOP, Slack) is seeded again under
the new redirect before item 4, next to the provider's new redirect; both rows work side by side, and the old one goes at item 9.
`waldo.oauth_clients` had no rows on 27 Oct 2026, so there was nothing to migrate.

## Production, later

Production should not run on a personal account. Before production gets `app.heywaldo.in`, move the Worker and the
heywaldo.in zone to a Cloudflare account Waldo owns. That is its own task: moving a zone between accounts means
re-adding it there and redeploying. Production then sets `WALDO_PUBLIC_ORIGIN=https://app.heywaldo.in` and
`workers_dev: false`, and no personal name appears anywhere.
