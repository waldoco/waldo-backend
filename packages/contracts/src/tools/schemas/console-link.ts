import { z } from 'zod';

// send_console_link: the host mints a one-time console sign-in link and sends it straight to the surface the owner's
// turn arrived on. The link is a credential, so the model chooses nothing about it: no arguments, and a result that
// says only whether it went out and where, or why not.
export const sendConsoleLinkArgsSchema = z.strictObject({});
export type SendConsoleLinkArgs = z.infer<typeof sendConsoleLinkArgsSchema>;

export const CONSOLE_LINK_SURFACES = ['telegram', 'imessage'] as const;
export const CONSOLE_LINK_UNSENT_REASONS = [
  // The app has no in-app route for the link yet; it is never sent into chat there.
  'app_unsupported',
  // A surface with no console-link delivery.
  'surface_unsupported',
  // Not the owner's own typed words: a job turn, or a forwarded, quoted or transcribed request.
  'not_owner_typed',
  // The turn carries outside content (a reply to someone else's message, or something read this turn).
  'outside_content',
  // One link per turn: a second mint would void the first.
  'already_sent',
  // Console sign-in cannot mint here (no public origin, issuer or signing secret).
  'unavailable',
  // The send was refused, blocked or failed.
  'send_failed',
] as const;
export const sendConsoleLinkResultSchema = z.discriminatedUnion('sent', [
  z.strictObject({ sent: z.literal(true), surface: z.enum(CONSOLE_LINK_SURFACES) }),
  z.strictObject({ sent: z.literal(false), reason: z.enum(CONSOLE_LINK_UNSENT_REASONS) }),
]);
export type SendConsoleLinkResult = z.infer<typeof sendConsoleLinkResultSchema>;
