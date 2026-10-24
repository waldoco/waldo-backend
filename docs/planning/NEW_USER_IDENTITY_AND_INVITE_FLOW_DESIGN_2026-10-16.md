# New-user identity and invite flow: one owner, linked by email and phone

Status: **design for owner review**. Nothing here is built, migrated or deployed. Planning text, not capability.
Pinned to `beta-mvp` at `ee487af2` and draft #1294 at `1bcb0ca7` (16 Oct 2026, 11:40Z).

## Outcome

A new person ends up with **one** Waldo owner, one Durable Object and one memory, reachable from the app, the console, WhatsApp and iMessage.
- They can sign in with an **email code or with Google**.
- Their **phone number is proven** by them texting Waldo from it.
- Nothing a stranger forwards, guesses or inherits can attach to that owner.

## What exists today

All of this is `[verified]` from source at `ee487af2` unless marked.

| Piece | Where | Behaviour |
|---|---|---|
| Authority root | `waldo.owners` (migration `20260924120000`) | One row per owner, `auth_user_id unique` → `auth.users`, `do_name unique`, `lower(email)` unique (`20260925130000`). |
| Invites | `waldo.invites`, `admin_invite`, `issue_member_invite` (`20260928190000`) | Keyed by **email**. Expire in 14 days. A member can issue up to 5. The link is `/console/signup#email=…&invite=…` (`identity/invite-code.ts`); the fragment never reaches a server. |
| Join | `signup_owner_for_auth` (`20261002170021`) | Creates an owner only from a **confirmed** Supabase email plus the exact live invite for that email, atomically. Used by console signup (`identity/console-signup.ts`) and app `verifyOrJoin` (`identity/console-auth.ts`). |
| Sign-in | `owner_for_auth`, `signin_allowed`, email OTP via Supabase `/auth/v1/otp` | Resolves existing members only. Unknown addresses get the same answer and no email. Throttled per email and per IP (`channels/console-signin.ts:19-25`). |
| Sessions | `console_session_*` | Separate console-cookie and app-bearer signing contexts. 12 h app session (#1133 proposes 30 days). |
| Phone | `owners.phone`, `owners.phone_verified_at` | Phone is optional and **unverified** at signup (`SignupProgress.phoneVerification: 'not_configured'`). **Nothing sets `phone_verified_at`.** There is **no unique index on phone**. |
| WhatsApp gate | trigger `presences_whatsapp_verified_phone` (`20260925130000`) | Refuses any WhatsApp presence while `phone_verified_at` is null. `[inference]` So `waldo CODE` cannot bind WhatsApp for any owner today unless someone set the column by hand. |
| Provider link codes | `issue_provider_link_code`, `redeem_link_code` (`20261014120000`) | 10-minute single-use codes for telegram, whatsapp and imessage. Redeeming one replaces the owner's previous presence. A subject live under another owner raises `claimed`, and the code stays unspent. |
| iMessage | shared Waldo number, `imessage_sender_authority` | A sender reaches an owner only through that owner's active `imessage` presence. Unknown senders get one throttled onboarding reply. **A handle can be a phone or an Apple ID email.** |
| Text-first WhatsApp | draft #1294 (needs owner security review) | An unlinked sender whose number matches exactly one owner's `owners.phone` gets a one-tap link. The signed-in owner confirms on a page that shows the full number, and the database consume sets `phone_verified_at`. Anyone else gets the waitlist. |
| Telegram console links | `channels/console-link.ts` | One-time, 10-minute console links. Not offered to new people (#1297). |
| Google sign-in | owner decision of 11 Oct ("O2-A + `profile`") | **Designed, not built.** There is no `GOOGLE_SIGNIN_ENABLED`, handoff table or `id_token` exchange anywhere in source. The Google *connector* (Gmail and Calendar OAuth) is a separate thing. |

Related open plans: #1297 (console web onboarding: admin per-email invites, no Telegram for new people), #1296 (WhatsApp row in the new console), #1294.
This doc covers only the identity-binding layer under them, and does not change their flows.

## The model

1. **One authority root:** `waldo.owners` → exactly one `auth.users` row.
   - Email OTP and Google are two ways to sign in to **that same Supabase user**.
   - Supabase's own automatic identity linking joins them on a matching **verified** email.
     - `[inference]` This is from Supabase's documented behaviour, and the build slice must prove it with a test.
   - No path ever creates a second owner for the same person.
2. **Email is the account key and the recovery factor.** It is verified when the person joins. Invites stay keyed by email.
3. **Phone is possession evidence, never a sign-in or recovery factor.**
   - It is proven only by an inbound WhatsApp or iMessage message from that number, closed by a confirm in the owner's signed-in app or console.
   - Recommendation: phone does **not** become a Supabase phone identity. That would need an SMS provider and a new login path, and it would make SIM swap an account-takeover path. See decision D2.
4. **Proof lives on each presence, not on the owner.**
   - Many people use different numbers on different channels: WhatsApp on a +91 number, iMessage on a US number or an Apple ID.
   - With a single `owners.phone_verified_at`, linking iMessage on number B would silently re-point the "verified phone" away from a live WhatsApp presence on A. Unlinking one channel would also clear the proof that the other still relies on.
   - So each `presences` row carries its own `proven_at`, set only by the confirm. The `presences_whatsapp_verified_phone` trigger is rewritten to require `new.proven_at` instead of `owners.phone_verified_at`.
   - Presence subjects stay in their provider's own form: WhatsApp digits plus the business-scoped user ID (BSUID, see F3 and F5), or the iMessage handle.
   - `owners.phone` (`+E.164`) becomes the owner's **contact number** only. The first confirm fills it, and the owner may pick another proven presence later. `phone_verified_at` then means "this contact number matches a proven presence".
5. **Uniqueness:** one owner per live subject per provider. That rule already exists as `presences_live_subject`. A partial unique index on verified `owners.phone` stops two owners from showing the same contact number (D6).
6. **An iMessage handle that is an email is a presence, not phone evidence.** It proves neither the email nor a phone, and it can never become `owners.phone`.

## Entry points

### A. Invite link (primary)

1. An admin or member invites an email address. The link opens the console signup or the app.
2. The person proves the email with an **email code**, or with **Google** when the Google account's verified email equals the invited email.
3. `signup_owner_for_auth` creates the owner.
4. **Link your phone** (onboarding step; #1297's Connect step hosts it):
   1. The signed-in app or console issues a provider link code.
   2. It opens `https://wa.me/<waldo-number>?text=waldo%20CODE`, or the iMessage equivalent.
   3. The person taps Send.
   4. The redemption opens a **pending** link request, not a live presence.
   5. The app or console that issued the code shows "Link +91 98765 43210?" with **Yes** and **Not my number**.
   6. Yes binds the presence with `proven_at`, which satisfies the rewritten trigger, and fills `owners.phone` if it is empty.

Two sides together make the proof: the code shows the sender acted for this owner, and the confirm shows the signed-in owner saw this exact number.
- This is the same request-and-confirm aggregate as #1294, opened from the other side.
- **Code-first** (above) and **text-first** (#1294, for members with a phone on file) both close through one confirm.
- So there is one writer for "phone verified".

### B. First text from an unknown number

- **Beta recommendation: waitlist reply only**, which is #1294's behaviour and iMessage's onboarding reply.
- A message never creates an account, and never carries its sender into a signup.

Post-beta option (decision D1): **phone-keyed invites.**
- An admin invites a number. The first text from it gets a signup link, and the person still proves an email (code or Google).
- The sender is **not** bound at signup. After joining, the new owner runs the code-first link from their own signed-in device.
- That costs one extra tap, and it closes the forwarding takeover described in F1.

### C. App

- Email code with an optional invite. `/app/v1/auth/code` and `/auth/verify` exist and use `verifyOrJoin`.
- Google O2-A: the backend runs Google OIDC with PKCE and a nonce, exchanges `grant_type=id_token` with Supabase, and returns a device-bound ticket.
  - It must refuse an ID token without `email_verified: true`.
- Then the phone step from A.4. The app polls its own pending request.

### D. Console

The same as C, through `/console/signin` and `/console/signup`, plus Google behind the same flag. #1297 restyles these pages; this design adds only the Google button and the phone step.

## Conflicts

| Case | Behaviour |
|---|---|
| The number is live under **another owner** | `claimed`: nothing moves, the code is not spent, and the sender hears "this number is linked to another Waldo account". The confirming owner sees the same. **Beta:** an admin resolves it by hand. Post-beta: a reclaim flow (D4). |
| The number is another owner's contact number but has no live presence on this provider | The presence binds, and the contact number stays empty for this owner (unique index). An admin sees both. |
| WhatsApp and iMessage on different numbers | Allowed. Each presence is proven separately, and the owner picks one contact number. |
| The owner re-links a new number on one provider | It replaces that provider's presence, as `redeem_link_code` already does. The other provider's presence and proof are untouched. The old number is no longer admitted (#1294 fixes the DO rebind). |
| The Google email differs from the invite or account email | `needs_invite`, the 11 Oct ruling. A signed-in owner adding a *different* Google login through Supabase manual linking is D3. |
| The invite email is not the address the person wants | The admin revokes it and reissues. No in-flow edit. |
| The unverified `owners.phone` from signup differs from the texting number | Code-first ignores `owners.phone`. The confirm replaces an unverified contact number with the proven one. Text-first (#1294) falls back to the waitlist. #1294's stated gap, "no phone on file means no way to link", is closed by code-first. |
| The same person tries to join with a second email | It needs a second invite. The unique phone index stops that second owner from verifying the same phone. |

## Recovery

- **Lost device:** sign in again by email code or Google. Revoke the old session from the sessions list, or sign out everywhere.
- **Lost number or new SIM:** unlink in the console. The phone becomes unverified, and the person re-links with the new number.
- **Lost email access:** there is no self-serve path, by design.
  - A Google login is not an independent factor in the beta, because it must match the account email.
    - For a Gmail address, it is the same factor.
    - For a non-Gmail Google account, the person is not locked out: they just sign in with Google.
  - So an admin-assisted email change rests on two things: a proven presence messaging from its number, **and** the admin knowing the person. It is never the phone alone (D5).
- **Changing email** while signed in: a code to the new address, then `auth.users` and `owners.email` are updated together, and the old address is notified. Not designed in detail here.
- **Delete and rejoin is not recovery.** `delete_owner` erases the identity, and a rejoin makes a new, empty owner (pgTAP `waldo_delete_then_rejoin.sql`).

## Security falsifiers

Each one needs a named failing test before its slice is built.

- **F1. Link-forwarding takeover, text-first.**
  - *Attack:* the attacker texts Waldo and forwards the link to the victim. The victim signs in, and the attacker's WhatsApp now reaches the victim's Waldo.
  - *Existing members:* #1294 holds, because the request is bound to the single owner whose phone matches.
  - *New users:* that binding **does not exist** for someone with no phone on file. So a message-started signup must never auto-bind its sender (B, D1).
  - *Test:* a signup started from a WhatsApp link creates an owner with no presence and no proven contact number.
- **F2. Reverse takeover, code-first.**
  - *Attack:* the attacker sees or is forwarded the owner's code and texts it first.
  - *Defence:* redemption opens only a pending request. The owner's confirm shows the full number, and "Not my number" spends the request.
  - *Test:* a redeemed code with no confirm admits nothing, and a confirm naming a different subject is refused.
- **F3. Recycled numbers.**
  - *Risk:* a carrier reassigns the number, and the old presence still routes to the old owner. A live presence outlives the SIM, and nothing on `beta-mvp` detects this.
  - *The deliberate move:* Meta's `user_changed_number` system webhook covers a user who moves with WhatsApp's Change Number feature. It carries the new number, the new BSUID and the previous BSUID. That event should unlink the old presence and offer the owner a re-link of the new number.
  - *The common case is different:* an abandoned SIM is reassigned by the carrier, and someone else registers it.
    - WhatsApp's help center treats a number as recycled after 45 days of inactivity followed by activation on a new device, and deletes the old account data.
    - `[inference]` The new user then arrives as a different WhatsApp user with a **new BSUID** and no linking event. I found no Meta text that states this.
  - *Detector:* key the WhatsApp presence on the **BSUID** as well as the digits. An inbound message from linked digits with an unfamiliar BSUID is refused. The presence drops to "needs re-proof", and the owner is told in the app.
  - This makes BSUID capture the core of F3, not only of F5. Until Meta sends BSUIDs on this integration, there is no detector.
  - *Fallback that does not depend on Meta:* a re-proof after long inactivity (D4).
  - *Tests:*
    - the Change Number event unlinks the old presence;
    - linked digits arriving with a different BSUID admit nothing;
    - re-proof restores the presence only through the owner confirm.
- **F4. SIM swap.**
  - *Risk:* an attacker re-registers the victim's number. The BSUID does not change, so it is invisible from the channel `[inference]`.
  - *Bound:* phone is never a sign-in or recovery factor (model §3, D2, D5). Consequential actions keep app- or console-side approval (13 Oct ruling: approvals go through an app link).
  - *Residual risk, stated plainly:* a swapped number can still converse with the owner's Waldo, and read through it whatever the conversation may read.
- **F5. BSUID and usernames.**
  - *Risk:* a user with a username who hides their number arrives with no `from`. The BSUID is on `messages[].from_user_id`, and `user_id` and `profile.username` are on `contacts[]` (per the BSUID side session's reading of Meta's docs). Phone proof holds **only when the phone is present**. Such a sender can link a presence keyed on the BSUID alone, but it never becomes `owners.phone`.
  - *Bug today:* `whatsapp-webhook.ts:37` (`if (!message.from) continue;`) silently drops these senders.
  - *Change:* store the BSUID on the WhatsApp presence.
  - *Unverified:* the rollout date. Secondary sources give dates from late March to May 2026; check Meta's page.
- **F6. Google email trust.**
  - Accept only `email_verified: true`, and bind the nonce and PKCE to a device ticket (app) or a state cookie (console).
  - *Test:* an unverified-email token, a replayed nonce and a cross-device ticket are each refused.
- **F7. Enumeration.**
  - Sign-in already answers unknown addresses the same way.
  - Reply throttles exist (iMessage 1 per sender per 30 days; #1294 3 per hour). The confirm page names a number only to the owner it is bound to.
- **F8. Normalisation drift.**
  - `owners.phone` is `+E.164`, the WhatsApp subject is digits only, and Meta's `wa_id` can differ from the number as dialled in some countries `[inference]`.
  - Use one canonicaliser and compare only canonical forms.
  - *Test:* a mismatch between `+`-prefixed and bare-digit forms of the same number cannot verify a different number.

## Contracts and migrations it would touch

- **Database functions**
  - Changed:
    - `signup_owner_for_auth`: stop treating the signup phone as data, or drop it.
    - `redeem_link_code` / `redeem_link`: whatsapp and imessage open a pending request instead of a presence.
      - This alters the **live iMessage shared-number flow**, which the iMessage lane owns (`20261014120000`).
      - Existing active presences must keep routing unchanged; give them `proven_at` = `created_at` in the migration.
      - Coordinate with that lane before I1.
    - `delete_owner`: clear the new columns.
  - Adopted: #1294's `open_presence_link_request` / `consume_presence_link_request`, generalised to both entry sides.
  - Affected: `route_presence`, `assert_channel_presence` and `admin_overview` (a verified-phone hint, never the full number).
- **Schema**
  - New columns: `presences.proven_at`, and a BSUID column on WhatsApp presences.
  - New indexes: a partial unique index on verified `owners.phone`, and a live-presence index on the BSUID.
  - New tables: #1294's link-request table, and the O2 Google handoff table.
  - Optional: `invites.phone`, only if D1 is accepted.
  - The `presences_whatsapp_verified_phone` trigger is rewritten to check `new.proven_at`.
- **Runtime contracts**
  - `ConsoleAuth`: provider link status and a confirm method.
  - `SignupProgress.phoneVerification`.
  - `whatsapp-webhook.ts` sender key.
- **`app.v1` (additive only; tell the app lane first):** Google start and finish, phone link start, status and confirm.
- **Dashboard API v1** (#1296, #1297): the phone step.
- **Env:** `GOOGLE_SIGNIN_ENABLED` and the Google web client id (config, not a secret).
- **ADR:** the identity model (one auth root; phone as possession evidence, not a factor; recovery needs two factors) is an owner-authority decision. Recommend a short ADR in Brain before slice I1 merges.

## Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | Can an uninvited or phone-invited first text start a signup? | Beta: waitlist only. Later: phone-keyed invites with no sender auto-bind. |
| D2 | Is phone a sign-in identity (Supabase phone and SMS) or verified evidence only? | Evidence only. |
| D3 | May a signed-in owner add a Google login with a different email? | Later, through Supabase manual linking, from a signed-in session only. Beta keeps `needs_invite`. |
| D4 | Recycled-number policy | Unlink on Meta's Change Number event. Refuse and re-prove on a BSUID mismatch. Re-prove after 90 days without inbound traffic. Admins resolve `claimed` by hand for the beta. |
| D5 | Recovery when email access is lost | Admin-assisted: a proven presence plus the admin knowing the person. Never the phone alone. |
| D6 | Proof per presence, with one contact number per owner and one owner per contact number? | Yes. |
| D7 | Does code-first linking require the owner-side confirm (one extra tap)? | Yes. It is the F2 defence. |
| D8 | Does #1294 keep binding its text-first offer on the unverified `owners.phone`? | Yes, as a hint only, since the confirm is what binds. |
| D9 | Apple sign-in before App Store submission (guideline 4.8) | Revisit then. It stays out of the beta (12 Oct ruling). |

## Build slices, after approval

| Slice | Content | Depends on | Rollback |
|---|---|---|---|
| I1 | Code-first phone link with the owner confirm; `proven_at`, rewritten trigger, contact-number index; one confirm writer shared with #1294 | #1294's review, D2, D6, D7, the iMessage lane | Revert the runtime. The additive columns stay unused. Existing presences keep `proven_at`. |
| I2 | Capture the BSUID; stop dropping `from`-less senders; Change Number event and BSUID-mismatch refusal | D4 | Flag off the mismatch refusal. The BSUID column is additive. |
| I3 | Google sign-in (O2-A) for the app and console | D3; the Google client in the dashboard | `GOOGLE_SIGNIN_ENABLED` off. Email code is untouched. |
| I4 | Phone-keyed invites | D1 | Stop issuing them. Email invites are unchanged. |
| I5 | Admin-assisted recovery and email change | D5 | Disable the admin action. |

Each slice ships with pgTAP for its database functions, runtime tests for F1–F8 as they apply, and a staging trace on a test account, never the owner's.

## Evidence

- **Observed:**
  - The files and migrations cited above, read at `ee487af2`.
  - #1294's description at `1bcb0ca7` (its diff was not reviewed line by line).
  - #1297's description.
  - Grep across `packages`, `supabase` and `wrangler.jsonc`: no Google sign-in source.
  - Grep: `phone_verified_at` is written only in migration comments and the trigger, never set.
  - Grep for any index naming phone in `supabase/migrations`: no matches.
- **Inference:**
  - That `waldo CODE` cannot bind WhatsApp on staging; I did not query staging.
  - Supabase's automatic linking on verified email.
  - SIM-swap invisibility.
  - That `wa_id` can differ from E.164.
  - That a recycled number arrives with a new BSUID and no linking event.
- **Unverified:**
  - Meta's BSUID rollout date for this integration, and the recycled-number BSUID behaviour.
  - Sources:
    - [Meta, business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids)
    - [Meta, system message webhooks](https://developers.secure.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/system/)
    - [WhatsApp FAQ on recycled numbers](https://whatsapp.com/faq/en/general/24068052)
    - [YCloud BSUID guide](https://docs.ycloud.com/reference/bsuid)
    - [Clickatell on BSUIDs](https://clickatell.com/blog/what-whatsapps-bsuid-means-for-your-business/)
