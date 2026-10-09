import { z } from 'zod';

// App sign-in and session wire shapes. Shapes only: lifetimes, routes and storage are decided
// elsewhere. Every object is strict, so an extra credential or routing field cannot parse.

const opaque = z.string().min(1).max(512);
const epochMs = z.int().nonnegative();

// What the app may know about its own session. The account is an opaque reference; the owner
// routing name never appears on the wire.
export const appCurrentSessionSchema = z
  .strictObject({
    account_ref: opaque,
    surface: z.enum(['app', 'console']),
    install_id: opaque.optional(),
    absolute_expires_at: epochMs,
    idle_expires_at: epochMs,
  })
  .refine((session) => session.idle_expires_at <= session.absolute_expires_at, {
    error: 'idle expiry cannot pass the absolute expiry',
    path: ['idle_expires_at'],
  });
export type AppCurrentSession = z.infer<typeof appCurrentSessionSchema>;

// Credentials exist only on an active account. The other three results are the whole of the
// "signed in but not usable yet" space and carry nothing a client could present as authority.
export const appVerifyResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('active'),
    access_token: opaque,
    refresh_token: opaque,
    session: appCurrentSessionSchema,
  }),
  z.strictObject({ status: z.literal('not_activated') }),
  z.strictObject({ status: z.literal('needs_invite') }),
  z.strictObject({ status: z.literal('needs_phone_proof') }),
]);
export type AppVerifyResult = z.infer<typeof appVerifyResultSchema>;

// A revoke the server could not finish yet is pending, never reported as done.
export const appRevokeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('revoked'), revoked_at: epochMs }),
  z.strictObject({ status: z.literal('pending') }),
]);
export type AppRevokeResult = z.infer<typeof appRevokeResultSchema>;

// Rotation replaces the credentials and never moves the absolute expiry.
export const rotatedExpiryHolds = (
  before: Pick<AppCurrentSession, 'absolute_expires_at'>,
  after: Pick<AppCurrentSession, 'absolute_expires_at'>,
): boolean => before.absolute_expires_at === after.absolute_expires_at;
