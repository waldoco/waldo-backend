# Common authority seam map

Source snapshot: a91f9ceb. Synthetic preparation only. No runtime/schema changes, no CI/staging acceptance.

## Distinct identity systems currently present

| Path | Trusted source | Owner representation | Currentness |
| --- | --- | --- | --- |
| Messaging directory | Signed route_presence RPC | waldo.owners UUID plus do_name; subject is a channel address | Active owner and presence routing |
| Canonical owner message | Private presence lookup | prn_/ten_ from waldo.owners UUID | Exact presence ID, owner state_version and admission_revision comparison at resume |
| Browser trial binding | Signed browser_owner_binding RPC with workspace mapping | Same waldo.owners UUID | Staging locator and Telegram-only presence checks |
| Public responsibility route | Supabase /auth/v1/user, verified JWT subject/session, active-session RPC, server metadata | owner_ + SHA256(auth user UUID) | Session expiry, active auth.sessions, authority policy/routing revision |
| Console | Validated cookie/server session | do_name | Session validation/revocation |

The public responsibility owner hash and messaging owner UUID are not text-equivalent. waldo.owners.auth_user_id is a distinct unique foreign key, so the directory schema has a mapping lead. Do not assume the hash belongs to a particular directory owner without reading and validating that owner/auth-user binding. Trace identity is observability, not this authority bridge.

## Persistence constraints

- DO presence_registrations permits multiple rows: primary registration ID, UNIQUE(owner_id,presence_id), owner-root FK. No SQL UNIQUE(owner_id) exists there.
- IdentityPresenceModule imposes the one-registration policy in code (count != 0 rejects). Removing that line alone would not supply a secure registration/admission mechanism.
- presence_sessions binds a session ID to exactly one registration. Reusing/fabricating a session for another channel is not valid.
- Supabase waldo.presences already permits multiple active presences per owner; UNIQUE(provider,subject) prevents one active channel address being used by multiple owners.
- admission_revision changes on owner/presence custody changes. An unlink/relink can invalidate older admitted work even if the visible values are restored.

## Production host restrictions

Canonical preparation in telegram-owner-do.ts explicitly requires channel == telegram and activeInbox, and feeds provider telegram into ownerMessageAdmission. Broadening the pure admission type would not remove this host restriction. The existing browser_owner_binding RPC is also Telegram-only and staging-only and tied to workspace/browser locator custody. Do not widen that browser capability as a shortcut for common messaging authority. Browser binding remains absent and activation off under existing lane constraints.

## Next behavior slice requirements

1. Define the common authority from verified directory owner plus individually admitted presence/session, preserving actual issuer evidence and owner/presence custody version. Console session and messaging webhook proofs remain different variants, not invented fields.
2. Preserve one durable writer/root for task state. Explicitly reconcile old root naming/owner mapping and legacy stored tasks before directing traffic. No silent namespace/class rename or migration.
3. Map admitted owner-message input and background continuation to the existing Coordinator task contracts without letting a surface/model manufacture canonical authority. Review root/session/presence lifecycle and task revision guards.
4. Use cross-surface real ingress/DO tests. After a task is persisted, eviction and another surface/background continuation must retain the same task/approval/effect identity. Foreign, stale, unlinked/relinked authority cannot act. Provider uncertainty must reconcile without resend; closure needs readback evidence.

The two reproduced REDs prove concrete restrictions in unchanged source, not the full design, production identity binding or shared execution. Dalda coordination remains pending before touching composition files. The owner directed a common brain; no new architecture permission question is needed. Engineering authority cannot fill missing identity evidence or production effects permission.
