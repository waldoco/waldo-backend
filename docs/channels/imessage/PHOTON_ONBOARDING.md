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

Enrollment proves nothing about the phone, so it locks nothing. Several owners may enroll the same number until one of
them links it with `waldo CODE` from the phone. After that, other owners get a refusal. Until a link happens, a text
from an enrolled number gets one reply pointing at `IMESSAGE_CONSOLE_URL`. Like the waitlist reply, it is sent at most
once per 30 days and reaches no Waldo.

Waldo removes a Photon user only when all of these hold:

- Waldo created it.
- No enrollment references it any more.
- It isn't the owner's linked number.

A user Waldo found already in the project is never removed.

**Data at Photon.** Photon receives each enrolled owner's phone number and sign-in email, plus a first name derived from
the email. Every message passes through Photon. Deleting a Waldo account deletes the enrollment row, but it doesn't yet
remove the Photon user. Remove it by hand with `photon spectrum users remove` until that is automated.

## Operator setup, once per environment

Use one Photon project per environment. The database keeps one owner per number per environment, but a Photon project
is shared by every Worker that names it.

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
refreshes. Staging's daily cron rotates an idle token weekly. Production has no cron trigger yet, so an idle production
connection must be reconnected after 30 days. If Photon refuses the refresh token, the console shows
Photon as **Not connected** and enrollment asks for a reconnect. Nothing fails silently.
