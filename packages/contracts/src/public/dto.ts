import { z } from 'zod';

export const publicPushClassSchema = z.enum([
  'brief',
  'fetch_alert',
  'adjustment',
  'pre_activity_spot',
  'constellation_first',
  'constellation_update',
  'spot_digest',
  'intervention_knock',
  'sync_error',
  'system_consent',
]);
export type PublicPushClass = z.infer<typeof publicPushClassSchema>;

export const publicEngagementChannelSchema = z.enum(['apns', 'telegram', 'in_app']);
export type PublicEngagementChannel = z.infer<typeof publicEngagementChannelSchema>;

export const publicEngagementKindSchema = z.enum([
  'delivered',
  'opened',
  'reply',
  'callback_tap',
  'thumbs_up',
  'thumbs_down',
  'mute',
  'disable',
]);
export type PublicEngagementKind = z.infer<typeof publicEngagementKindSchema>;

export const publicEngagementEventRequestSchema = z.strictObject({
  push_class: publicPushClassSchema,
  channel: publicEngagementChannelSchema,
  kind: publicEngagementKindSchema,
  occurred_at: z.string().datetime({ offset: true }),
  run_id: z.string().min(1).optional(),
});
export type PublicEngagementEventRequest = z.infer<typeof publicEngagementEventRequestSchema>;

export const publicEngagementEventResponseSchema = z.strictObject({
  accepted: z.literal(true),
});
export type PublicEngagementEventResponse = z.infer<typeof publicEngagementEventResponseSchema>;

export const publicErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});
export type PublicError = z.infer<typeof publicErrorSchema>;
