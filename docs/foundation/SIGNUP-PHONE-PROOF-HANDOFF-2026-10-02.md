# Disabled signup phone proof — 2 October 2026

This bounded slice prepares provider-managed phone challenges for new invited signup. It is disabled by default and has no HTTP route, credential binding, completion, provisioning or session grant. Existing Supabase email OTP and member email-only login remain unchanged. Scope registration: [#116](https://github.com/waldoco/waldo-backend/issues/116#issuecomment-5950353754).

## Provider decision

Use Twilio Verify for the first Indian cohort pilot, subject to the activation gates below. Verify generates and checks the code; Waldo stores only challenge identity, operation state and approved evidence. Plain SMS would require Waldo to generate, hash, expire and validate codes, adding maintenance and another OTP state machine. The existing SMS/email signup contract currently collects a phone but does not prove it or complete signup.

Official trial documentation checked on 2 October 2026 describes a 30-day trial, five verified recipients, 100 SMS messages and 40 successful verifications. Trial traffic is restricted to the account signup country. An Indian trial therefore cannot simultaneously exercise the US cohort. Preserve the broader US core and test its synthetic recipient bindings locally; do not describe the Indian trial as cross-country delivery proof. MSG91's default managed widget has separate pricing and no free trial in the previously reviewed official material.

Sources: [Twilio trial limits](https://www.twilio.com/docs/usage/trials), [Verify trial](https://www.twilio.com/docs/usage/trials/try-out-verify), [Verify API](https://www.twilio.com/docs/verify/api).

## Durable boundary

- A verified email, exact live email-bound invite and original signed signup attempt are required for send, check and finalize. Approval never consumes an invite or creates an owner.
- A signed RPC reserves each operation before provider work. Finalize must match the immutable attempt, auth identity, email, invite hash, phone, service, operation and stored verification SID. The entered code is never persisted.
- First phone deadline is at most ten minutes and never extends on resend; signup retains its original fifteen-minute deadline. Resend waits sixty seconds, with at most three sends and five checks per attempt.
- The singleton pilot budget admits at most twenty sends, fifty checks and ten potential successful verifications. These are request ceilings, not a currency guarantee. A reservation remains charged after uncertain outcomes; there is no reset endpoint.
- Recipient quarantine survives cancellation and Auth identity deletion. Known pending sends hold for ten minutes after response. Unknown/in-flight sends hold indefinitely because delivery may have occurred. No automatic retries or reconciliation release exist in this slice.
- Forced RLS and revoked direct client table access protect the journal. Only the existing router HMAC authorizes the new RPC; signatures bind all payload fields and reject null values. No new secret is configured.

## Verification and corrections

Local Node fixtures and the real Cloudflare Workers test pool each passed 58 tests across provider, coordinator, existing signup, existing signup auth and request timeout files. Runtime TypeScript passed. Canonical migration history and fixture sync passed for all 38 migrations.

`node scripts/verify-signup-phone-proof.mjs` uses pinned local Supabase Postgres/Auth images, an internal network, synthetic identities and no published ports. It applied all migrations, replayed the additive migration, passed 130 focused pgTAP assertions and three concurrent cases, then removed its owned containers/network. Tests cover wrong code, expiry, resend, throttles, replay, recipient binding, canceled and revoked attempts, zero provisioning/invite consumption, and global budget exhaustion.

Adversarial QA reproduced a stale-clock bug: an approval waiting on a budget lock could cross expiry and still approve. Reading the clock after all locks fixes it; approval and send lock-wait regressions now reject expired work. The runtime cancel path also rejected expired continuations even though SQL allowed safe immutable cancellation; an expired-cancel regression now covers that boundary.

Independent security and QA reviews passed this disabled slice. They reviewed source and independently ran the 58 runtime fixtures; the database execution evidence belongs to the implementation lane. A broader local pgTAP attempt failed existing public health-helper grant expectations in the disposable bootstrap (`schema_contract.sql`); this is not a full SQL verification pass. The standard all-guards runner also stops at its Linux PostgreSQL bootstrap on this macOS host; the Docker fixture runner supplies the focused SQL evidence instead. Canonical CI remains a required release gate.

CI follow-up: head `ca2e05e` passed all four runtime shards and canonical Supabase migrate-from-zero/pgTAP. Its core guard failed because the plain-PostgreSQL shim omitted `auth.users.email_confirmed_at`. The local-only correction adds a nullable timestamp with no default; all 373 SQL assertions then passed in a fresh plain cluster inside the pinned local Postgres image, including confirmed/unconfirmed phone eligibility. The earlier stale 37-migration staging fixture was corrected with an exact preceding-history regression; its 67 workflow/preflight tests passed locally and in CI. No full core-green claim is made until the shim correction is published and canonical CI reruns.

Further pushes are held by the owner's preview pause. The local shim correction is reviewable but unpublished. External Cloudflare build metadata shows failure without annotations/error text; its dashboard requires sign-in, so the cause remains blocked behind account access. This lane does not change preview settings, deploy or bypass that boundary.

## Required decisions before activation

1. User creates the Twilio account, enters their own password, verifies their own Indian signup number and accepts current legal terms. No account has been created or personal signup data submitted by this lane. Marketing consent stays optional. Google signup would introduce a separate grant and is not used.
2. Confirm the current account's India SMS/Verify route, recipient verification, country restriction, any required local registration and actual Verify code TTL. **The recipient quarantine assumes provider TTL is no longer than ten minutes; do not enable until this is proved for the chosen service.** If longer, revise and retest the bound first.
3. Approve the India-only cohort and the provider-disabled-to-live transition separately. Do not upgrade or purchase during this trial task. Recheck published quotas, pricing and account spend controls immediately before live work. Establish a provider spending cap/alert and an operator stop switch; local request budgets alone cannot promise a monetary ceiling.
4. Configure server credentials through the approved secret path only after credential authorization. Never place tokens in docs, fixtures, logs or browser-visible content. No provider credentials or live bindings are part of this PR.
5. Review the HTTP consumer, continuation custody, completion transaction, proof replay/consumption contract, retention/deletion and uncertain-operation reconciliation before routing traffic. The existing UI retry lane and A1 admission lane retain ownership; this slice does not wire either.
6. Add content-free outcome counters for disabled, reserved, pending, approved, expired, throttled, denied and unknown in the route consumer. Never label metrics with phone, email, SID or code. Observe reservation totals separately from confirmed delivery; uncertain effects are not successful sends.

The release lane alone owns merge, deployment and migration application. No SMS was sent and no money spent during this work.
