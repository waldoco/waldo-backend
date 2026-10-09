import { z } from 'zod';

// Proposed wire shapes for app sign-in and session management. Shapes only: lifetimes, routes,
// storage and the credential rail are decided elsewhere. Every object is strict, so an extra
// credential or routing field cannot parse.

const epochMs = z.int().nonnegative();
const opaqueSecret = z.string().min(1).max(512);

// Server-issued identifiers: a fixed kind prefix and an opaque body. A routing name, a UUID, a
// JWT or a client-made value cannot parse as one.
const ref = <P extends string>(prefix: P) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{16,64}$`));
export const accountRefSchema = ref('acct');
export const installIdSchema = ref('inst');
export const sessionRefSchema = ref('sess');
export const reconcileRefSchema = ref('recon');

// The app's own session. The surface is the literal app; an install is required and belongs to
// the account named by account_ref. The owner routing name never appears on the wire.
export const appCurrentSessionSchema = z
  .strictObject({
    session_ref: sessionRefSchema,
    account_ref: accountRefSchema,
    install_id: installIdSchema,
    surface: z.literal('app'),
    absolute_expires_at: epochMs,
    idle_expires_at: epochMs,
    credential_expires_at: epochMs,
    renew_after: epochMs,
  })
  .refine((s) => s.idle_expires_at <= s.absolute_expires_at, { error: 'idle expiry cannot pass the absolute expiry', path: ['idle_expires_at'] })
  .refine((s) => s.credential_expires_at <= s.idle_expires_at, { error: 'credential expiry cannot pass the idle expiry', path: ['credential_expires_at'] })
  .refine((s) => s.renew_after <= s.credential_expires_at, { error: 'renew_after cannot pass the credential expiry', path: ['renew_after'] });
export type AppCurrentSession = z.infer<typeof appCurrentSessionSchema>;

// A console session as the app may list it: no credential, no app fields.
export const consoleSessionListItemSchema = z.strictObject({
  session_ref: sessionRefSchema,
  surface: z.literal('console'),
  created_at: epochMs,
  last_seen_at: epochMs,
});
export type ConsoleSessionListItem = z.infer<typeof consoleSessionListItemSchema>;

// One opaque rotating credential, nothing rail-specific. It exists only on an active account;
// the other three results carry nothing a client could present as authority.
export const appVerifyResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('active'), credential: opaqueSecret, session: appCurrentSessionSchema }),
  z.strictObject({ status: z.literal('not_activated') }),
  z.strictObject({ status: z.literal('needs_invite') }),
  z.strictObject({ status: z.literal('needs_phone_proof') }),
]);
export type AppVerifyResult = z.infer<typeof appVerifyResultSchema>;

export const appRevokeRequestSchema = z.strictObject({ session_ref: sessionRefSchema });
export type AppRevokeRequest = z.infer<typeof appRevokeRequestSchema>;

// Revoke is idempotent: a session that is already gone answers already_gone. A revoke the server
// could not finish is pending, never done, and names what to ask about later.
export const appRevokeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('revoked'), revoked_at: epochMs }),
  z.strictObject({ status: z.literal('already_gone') }),
  z.strictObject({ status: z.literal('pending'), reconcile_ref: reconcileRefSchema, retry_after_ms: z.int().positive() }),
]);
export type AppRevokeResult = z.infer<typeof appRevokeResultSchema>;

// Rotation replaces credential timing and never moves the session identity or its absolute expiry.
export const rotatedExpiryHolds = (before: AppCurrentSession, after: AppCurrentSession): boolean =>
  before.session_ref === after.session_ref && before.absolute_expires_at === after.absolute_expires_at;
