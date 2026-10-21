# WHOOP and Oura (21 October 2026)

Health Connect and HealthKit stay the main path. WHOOP is a cloud source behind the same health-source seam. Oura stops at pure
record mappers. Read this before registering a developer app, setting a secret, or enabling either source.

## Terms that decide what is built

Quoted from the vendors' own pages, read on 21 October 2026. Vendors can change both documents; re-read before launch.

**WHOOP API Terms of Use**, effective October 6, 2026: https://developer.whoop.com/api-terms-of-use/ (§4, WHOOP Data)

> Prohibitions on WHOOP Data. Unless expressly authorized by the WHOOP Data owner or by applicable law, Company will not, and will not permit Company's End Users or others acting on Company's behalf to, do any of the following:
> Expose WHOOP Data to other users or to third parties without explicit opt-in consent from the user that provided the WHOOP Data and in accordance with the Terms;
> Scrape, build databases, or otherwise create permanent copies of WHOOP Data, or keep cached copies longer than permitted by the cache header;
> Use any API or WHOOP Data to create, develop, test, train, fine-tune or improve any large language model or any other machine learning or artificial intelligence model, application, or system;

How the build meets it:

- Storage in the health plane and use by the AI model are authorized by the owner, expressly, through the two grants every source
  has, for source `whoop`: `storage_compute` (Waldo stores the data) and `model_processing` (AI models process it to plan the owner's
  day). Both must be live before a connection starts, before the callback code is traded for tokens, and before every sync or
  webhook fetch. The notice version recorded on the grants is WHOOP-specific copy saying exactly that; the copy is the onboarding
  lane's, and the backend records the version it is given. The database refuses a WHOOP reading while `storage_compute` is not
  live. Withdrawing `storage_compute` withdraws the source and purges what it stored (see below for what it leaves); withdrawing
  `model_processing` stops sync and model use and deletes nothing.
- WHOOP data is never used to create, develop, test, train, fine-tune or improve any model, prompt or eval. The tests, fakes and
  eval cases for WHOOP use synthetic values only (`packages/runtime/test/fixtures/whoop-synthetic.ts`). No recording of a real
  account is committed, and none may be used for a model or prompt change.
- **Residual risk:** the first clause bars permanent copies and databases unless the owner expressly authorizes them. Express
  authorization by the owner is what the build relies on. Whether a consent screen satisfies "expressly authorized" to WHOOP's
  reading is a legal call, not a code one.

**Oura API and MCP Agreement**, effective June 8, 2026: https://cloud.ouraring.com/legal/api-agreement

> (d) To the extent you seek to use any Oura Data or User Data in connection with a large language model, you may (unless you are an Aggregator) access and process such Oura Data or User Data solely through the MCP Server subject to the provisions of this Agreement. You shall not use, and shall not permit any third party to use, the Oura API to develop, train, fine-tune, evaluate, prompt, or otherwise provide input or data to any AI Model or AI Platform. (§4(d))

> (xx) aggregating, caching, or storing geographic location information or other User Data accessible via the Oura API or MCP Server. (§4(a)(xx), a Prohibited Use "unless Oura provides prior written consent")

> (c) With respect to User Data, the foregoing Prohibited Uses shall apply regardless of whether a User has purportedly consented to any such use (§4(c))

> (m) Unless and until you are authorized to do so by the Company in a separate written agreement or consent, you shall not store or cache any data accessed or obtained through the MCP Server. (§3(m))

So an Oura connection that stores readings and shows them to a model is a Prohibited Use that owner consent does not cure. Nothing
in the live path reads from Oura: no OAuth, no sync, no webhook, no `oura` entry in the source enum the app can send or the
database accepts. `oura-map.ts` and its tests are pure functions over synthetic records.

Owner decision for Oura (pick one):

1. Ask Oura for prior written consent or a partnership that covers storage and model use. Then the OAuth, sync and webhook slice
   is the WHOOP one with Oura's differences (PKCE, single-use refresh token, signature encoding, `410` cancels a subscription).
2. Oura owners reach Waldo through Apple Health or Health Connect on the device. The ring app writes there; no Oura API is used.
3. Use Oura's MCP server at model time with nothing stored. This loses per-source baselines, so the trigger has nothing to compare against.

## WHOOP in the build

- Connect: the app `POST /app/v1/health/providers/connect` (health revision 2) returns a WHOOP authorize URL. The `state` WHOOP
  requires to be eight characters is a random base62 string resolved through the existing connect-session table (hash only,
  single use, 30 minutes), so it carries no owner identity.
- Callback: `GET /oauth/whoop/callback` on the Worker resolves the attempt, then calls the owner object over the signed provider
  route (it binds owner, operation and body digest). The owner object hands the code to the `oauth-proxy` Edge Function, which
  trades it with the client secret it holds, reads the WHOOP account id (`user_id`), and saves the tokens in Vault.
- Tokens: the owner object never receives a token, a code's result or the client secret. The `oauth-proxy` Edge Function holds
  them (WHOOP is registered to it in `waldo.connection_custody`), makes every WHOOP request under the pinned API base, and
  refreshes and rotates WHOOP's single-use refresh token with a compare-and-set on the stored secret. The object keeps only the
  connection id, the WHOOP account id, the version of the token last used and its expiry. It is the one retry owner: it refreshes
  once, single-file, before a token lapses or after the edge reports one expired or refused (passing the version that failed),
  then retries once. A second refusal means the owner revoked access at WHOOP: the object marks the connection `needs_reconnect`
  and stops calling until the owner connects again. An edge that could not save a rotated token fails the sync for a retry; the
  next refresh then meets a spent token and asks the owner to reconnect.
- Sync: a `provider_sync` schedule entry (a daily interval, no model turn) backfills 30 days in seven-day windows on the first run, then
  reconciles the last three days. A webhook only makes the owner object fetch; the fetch uses the owner's own token.
- Webhook: `POST /events/whoop`, signature `X-WHOOP-Signature` = base64(HMAC-SHA256(timestamp + raw body, client secret)), checked against the
  raw body; deduped on `trace_id`. WHOOP can miss a webhook, so the daily sync reconciles.
- Disconnect: `POST /app/v1/health/providers/disconnect` revokes at WHOOP (`DELETE /v2/user/access`, through the edge), has the edge
  mark the connection revoked and delete the Vault secret, and cancels the sync entry.
- Withdrawing a grant is a separate act in the health plane. Withdrawing `storage_compute`: the database refuses new WHOOP readings and
  purges the stored ones. Withdrawing either grant: the owner object's next sync reads `consent_required` and only re-checks daily.
  Neither revokes at WHOOP or removes the saved token; the owner disconnects for that. Having withdrawal disconnect as well is a follow-up.
- A connect request that finds a grant missing answers `consent_required` with `missing` naming the grants that are not live
  (`storage_compute`, `model_processing`), so the app sends the owner to exactly those. A callback that finds one missing shows a page
  saying so and leaves the code unused.
- Every reading goes through the same `waldo.health_ingest` the app uses. The producer ranks one source per day and keeps a
  baseline per source and per HRV method; WHOOP's `hrv_rmssd_milli` is RMSSD.

## Owner steps (nothing here is done by the build)

1. Register a WHOOP developer app (Sandbox tier lets 10 members connect; Build lets 100). Scopes requested:
   `offline read:profile read:sleep read:recovery read:workout`.
2. Set the redirect URL to `https://<worker host>/oauth/whoop/callback` and the webhook URL to `https://<worker host>/events/whoop` (v2 webhooks).
3. Set Worker secrets `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` and `WHOOP_REDIRECT_URI` (the redirect URL above, exactly). The Worker
   uses the client secret only to verify `X-WHOOP-Signature`; the owner object uses the client id and redirect address only. Without all
   three the routes answer `not_configured` and nothing is sent to WHOOP.
4. Enter the client for the edge once, with the same id, secret and redirect address (the edge reads it by issuer and redirect address,
   and the client id must match): `select waldo.oauth_client_put('https://api.prod.whoop.com', '<worker host>/oauth/whoop/callback', '<client id>', 'client_secret_post', '<client secret>');`
5. Apply migration `20261021150000_health_wearables_zone_change.sql` to the health plane before the deploy that reads it. It registers WHOOP
   with the `oauth-proxy` custodian, so it needs the connections migration that creates `waldo.connection_custody`, and the `oauth-proxy`
   Edge Function must be deployed before a connection can start.
6. Decide the terms question above and the WHOOP-specific consent wording with the onboarding lane; the grants are `storage_compute` and `model_processing` on source `whoop`.
7. One bundled deploy, then connect a WHOOP account on an owner account through the app.
