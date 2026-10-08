import { z } from 'zod';

export const grantAreaSchema = z.enum(['mail', 'calendar', 'messages', 'tasks', 'files', 'purchases']);
export const grantModeSchema = z.enum(['tell', 'ask', 'auto']);
const exactScope = z.array(z.string().min(1)).nonempty();
export const standingGrantSchema = z.strictObject({
  id: z.string().min(1),
  owner_ref: z.string().min(1),
  area: grantAreaSchema,
  action: z.string().min(1),
  constraints: z.strictObject({
    recipients: exactScope.optional(),
    calendars: exactScope.optional(),
    accounts: exactScope.optional(),
    max_per_day: z.int().nonnegative().optional(),
    amount_max: z.strictObject({ currency: z.string().min(1), value: z.number().nonnegative() }).optional(),
    content_kinds: z.array(z.enum(['reminder', 'reply', 'scheduling'])).nonempty().optional(),
  }),
  mode: grantModeSchema,
  created_from: z.strictObject({ surface: z.string().min(1), message_ref: z.string().min(1) }),
  expires_at: z.iso.datetime({ offset: true }).optional(),
  revoked_at: z.iso.datetime({ offset: true }).optional(),
  revision: z.int().positive(),
});
export type StandingGrant = z.infer<typeof standingGrantSchema>;
export type GrantArea = z.infer<typeof grantAreaSchema>;
export type GrantMode = z.infer<typeof grantModeSchema>;
