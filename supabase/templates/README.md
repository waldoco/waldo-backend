# Auth email templates

Hosted Supabase Auth templates are configured in the dashboard
(Authentication → Emails), not by `supabase/config.toml`. These files are the
reviewed source; paste them in when they change.

## `sign-in-code.html`

Email OTP body. Apply it to both templates that can carry the code, because
`signInWithOtp` sends **Magic Link** to existing users and **Confirm signup**
to new ones.

- Subject: `{{ .Token }} is your Waldo sign-in code`. Putting the code first in
  the subject and preheader lets iOS/macOS Mail autofill and Android
  notification "copy code" chips find it. Confirm with one test send that the
  subject renders the code; if literal braces arrive, use
  `Your Waldo sign-in code` (the preheader still leads with the code).
- Variables used: `{{ .Token }}`, `{{ .Email }}`. No links, so the email stays
  code-only and phishing-shaped lookalikes have nothing to imitate.
- Email clients run no JavaScript, so there is no real copy button. The code is
  one selectable word with `user-select: all`, so one tap or double-click grabs
  all of it.

A one-line note appears only for rare codes (`123456`, a `007` prefix, a code
that repeats its halves, a palindrome), using Go template builtins on `.Token`.
Each branch is guarded by `len .Token == 6`, so a different OTP length renders
no note instead of failing to render.
