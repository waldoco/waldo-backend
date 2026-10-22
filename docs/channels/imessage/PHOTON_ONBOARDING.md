# iMessage on Photon: per-owner Waldo numbers

The shared Waldo iMessage number can run on a Photon (Spectrum cloud) shared-pool line. The host is the
`nativeMode: "photon"` build of `waldoco/waldo-imessage-host`, paired from `/console/imessage` like any shared host.
On Photon's Free and Pro plans a phone can text the pool only once it is a user of Waldo's Photon project, and Photon
assigns each user the pool number they text. The Worker does that enrollment, so an owner never touches Photon.

## Owner flow

1. On `/console/imessage` (or the iMessage view in the console app), the owner enters their iPhone number, prefilled
   from signup, and taps **Get my Waldo number**.
2. The Worker finds or creates the owner's user in the Photon project, records the assigned number in
   `waldo.imessage_photon_enrollments`, and issues an iMessage link code in the same step.
3. The page shows their Waldo number and an **Open Messages** link with `waldo CODE` filled in. Sending it links the
   number to the owner's own Waldo, through the existing link-code redemption.

Enrollment links no one. Until the code arrives from that phone, a text from the enrolled number gets one reply
pointing at `IMESSAGE_CONSOLE_URL`. Like the waitlist reply, it is sent at most once per 30 days and reaches no
Waldo. When an owner changes number, their previous Photon user is removed, so it doesn't hold a Free-plan slot.

## Operator setup, once per environment

1. In the Photon dashboard, open **Developer → Apps** and create a confidential OAuth app:
   - Redirect URI: `<worker origin>/imessage/photon/callback`, exactly.
   - Scopes: `openid offline_access projects:read projects:write spectrum:read spectrum:write`.
   Keep the client secret. Photon shows it once.
2. Configure the Worker:
   - Vars: `PHOTON_PROJECT_ID`, `PHOTON_OAUTH_CLIENT_ID`, `IMESSAGE_CONSOLE_URL`.
   - Secret: `wrangler secret put PHOTON_OAUTH_CLIENT_SECRET --env <env>`.
   Without all three of the project id, client id and secret, Photon is off and the console falls back to
   `IMESSAGE_WALDO_ADDRESS`.
3. An admin opens `/console/imessage` and clicks **Connect Photon**. They sign in to Photon and approve. The callback
   only accepts the browser that started the sign-in.

Photon's Dashboard API takes only user OAuth tokens. Refresh tokens rotate on every use and last 30 days, so one
Durable Object holds them: the `IMessageBridgeDO` instance named `["photon-oauth", <environment>]`. It serializes
refreshes, and the daily cron rotates an idle token weekly. If Photon refuses the refresh token, the console shows
Photon as **Not connected** and enrollment asks for a reconnect. Nothing fails silently.
