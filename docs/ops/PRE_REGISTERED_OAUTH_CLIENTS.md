# Pre-registered OAuth clients

Some providers only let a client sign in once it has been registered with them by hand, rather than through
dynamic client registration or a client metadata document. Slack's MCP server is the first such provider,
and GitHub, Asana and HubSpot work the same way. For these, the operator registers Waldo once per environment
and seeds the client into the `oauth-proxy` edge. The client secret then lives only in Supabase Vault: never in
the Worker, a prompt, a log or this repository.

## How it works

- **Storage.** `waldo.oauth_clients` holds one row per issuer and redirect address. A seeded row also pins the
  token endpoint (required) and the revocation endpoint (optional) that its secret may be sent to
  (migration `20261026130000_waldo_oauth_client_endpoints.sql`).
- **Lookup.** The owner's object asks the edge for the client with the `client` operation. The edge answers with
  the client id and authentication method only. A dynamic registration is never returned as pre-registered.
- **Binding.** The edge reads a confidential client's secret through `waldo.oauth_client_secret`, for the one
  endpoint it is about to send it to. A seeded row answers only for its own token or revocation endpoint. A
  request whose pins name any other endpoint gets no secret, and nothing is sent. A revocation endpoint that is
  refused does not receive the token either.
- **Unseeded rows.** A row with no pinned endpoints keeps the behaviour it had before the migration: a dynamic
  registration, or a client entered with `oauth_client_put` (such as WHOOP). Seed WHOOP again with
  `oauth_client_seed` to bind it too.

## Deploy order

1. Apply the migration to the health plane.
2. Deploy the `oauth-proxy` Edge Function. This order matters: the new edge reads secrets only through
   `oauth_client_secret`, so deploying it before the migration fails every confidential-client exchange and
   refresh (WHOOP included).
3. Seed the clients below. The existing edge keeps working against the migrated schema, because no existing
   function changed.

**Rollback.** Redeploy the previous `oauth-proxy`; it ignores the new columns and functions. The migration is
additive.

## Seeding a client, or rotating its secret

Run this from a local `psql` session connected to the project's database as `postgres`, the role that owns the
function. Don't use the dashboard SQL editor, which keeps query history. Only `service_role` and the owner can
execute the function. Seeding again replaces the client id, endpoints and Vault secret in place, so it also rotates a
regenerated secret.

```sql
\prompt 'Client secret: ' client_secret
select waldo.oauth_client_seed(
  '<issuer>',                      -- exactly as the provider's authorization server metadata names it
  '<console origin>/oauth/mcp/callback',
  '<client id>',
  'client_secret_post',            -- or client_secret_basic, as the provider advertises
  :'client_secret',
  '<token endpoint>',
  null                             -- the revocation endpoint, when the provider has one
);
```

The function returns `false` and changes nothing when any of these holds:

- an endpoint is not https;
- a confidential client has no secret;
- the authentication method is outside the set.

## Slack: owner actions

None of this has been done. The Worker side that offers Slack in Connections follows in a separate change.

1. **Choose how Waldo is distributed.**
   - **Internal app.** It installs only in the workspace that owns it, and needs no review. This fits the
     owner's own workspace and testers inside it.
   - **Slack Marketplace listing.** It is needed for any other workspace, and Slack reviews it first. Slack bars
     unlisted distributed apps from MCP ("Only directory-published apps or internal apps may use MCP",
     docs.slack.dev/ai/mcp-server, read 26 Oct 2026).
2. **Create the app from this manifest** at api.slack.com/apps → Create New App → From a manifest. Use one app
   per environment, or one app listing every environment's redirect URL.

   ```yaml
   display_information:
     name: Waldo
   oauth_config:
     redirect_urls:
       - https://<console origin>/oauth/mcp/callback
     scopes:
       user:
         - search:read.public
         - search:read.private
         - search:read.im
         - search:read.mpim
         - search:read.users
         - channels:history
         - groups:history
         - im:history
         - mpim:history
         - channels:read
         - groups:read
         - im:read
         - mpim:read
         - users:read
         - chat:write
   settings:
     token_rotation_enabled: true
   ```

   - **Scopes.** These are the least Waldo needs to search, read channels and threads, and send:
     - Waldo cannot read emails, files, canvases, lists, reactions or emoji.
     - It cannot create channels.
     - `chat:write` is its only write.
   - **Token rotation.** It makes access tokens expire, so a deleted grant stops working at Slack too. Slack has
     no standard revocation endpoint, so without rotation a user token stays valid until the owner removes the
     app in Slack.
3. **Set the redirect URL** to the console origin of each environment, for example
   `https://waldo-runtime-staging.piyushfulper3210.workers.dev/oauth/mcp/callback` for staging. Slack requires
   https, and the `redirect_uri` must equal, or be a subdirectory of, a configured URL.
4. **Seed each environment** with the app's Client ID and Client Secret (Basic Information → App Credentials):

   ```sql
   \prompt 'Slack client secret: ' client_secret
   select waldo.oauth_client_seed('https://mcp.slack.com', '<console origin>/oauth/mcp/callback', '<client id>',
     'client_secret_post', :'client_secret', 'https://slack.com/api/oauth.v2.user.access', null);
   ```

   The issuer and token endpoint are taken from `https://mcp.slack.com/.well-known/oauth-authorization-server`,
   read 26 Oct 2026. Slack accepts only `client_secret_post` there.
5. **Approve the app.** A workspace admin approves it if the workspace requires app approval.

## Known limits

- **Unbound secret read.** `waldo.oauth_client_get` still returns a client secret without an endpoint check.
  The deployed edge reads secrets through it until this change's edge is live; drop its secret column in a
  follow-up migration once it is.
- **Unverified Slack behaviour.** Until an owner signs in, these are not checked:
  - whether Slack accepts space-separated scopes and the RFC 8707 `resource` parameter at
    `/oauth/v2_user/authorize`;
  - how Slack rotates refresh tokens;
  - the real tool names and read-only labels.
