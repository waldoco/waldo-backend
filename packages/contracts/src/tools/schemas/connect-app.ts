import { z } from 'zod';
import { CONSOLE_LINK_SURFACES } from './console-link';

// connect_app: the host starts the sign-in for one app from Waldo's catalogue and sends the owner, on the surface their
// turn arrived on, a one-time connect link or (where the app's sign-in service offers it) a device code. The model names
// only which catalogue app and which of the two; it never sees the link or the code, and names no address or destination.
// The id is checked against the runtime's catalogue, which this package does not hold.
export const connectAppArgsSchema = z.strictObject({
  connector_id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  method: z.enum(['link', 'code']).optional(),
});
export type ConnectAppArgs = z.infer<typeof connectAppArgsSchema>;

export const CONNECT_APP_UNSENT_REASONS = [
  // Not the owner's own typed words: a job turn, or a forwarded, quoted or transcribed request.
  'not_owner_typed',
  // The turn carries outside content (a reply to someone else's message, or something read this turn).
  'outside_content',
  // Not an app in Waldo's catalogue.
  'unknown_app',
  // A code was asked for and the app's sign-in service offers none, or this Waldo cannot run one.
  'code_unavailable',
  // One link or code per turn.
  'already_sent',
  // Connecting cannot start here (no public origin, signing secret or token custody).
  'unavailable',
  // The app's sign-in service could not be prepared (discovery, registration or the code request failed).
  'sign_in_failed',
  // The send was refused, blocked or failed.
  'send_failed',
] as const;
export const connectAppResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('sent'), method: z.enum(['link', 'code']), surface: z.enum(CONSOLE_LINK_SURFACES) }),
  z.strictObject({ status: z.literal('already_connected') }),
  z.strictObject({ status: z.literal('not_sent'), reason: z.enum(CONNECT_APP_UNSENT_REASONS) }),
]);
export type ConnectAppResult = z.infer<typeof connectAppResultSchema>;
