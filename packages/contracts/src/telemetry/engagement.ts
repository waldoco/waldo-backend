import { z } from 'zod';
import { pushClassSchema } from '../runtime/delivery-policy';

export const engagementChannelSchema = z.enum(['apns', 'telegram', 'in_app']);
export type EngagementChannel = z.infer<typeof engagementChannelSchema>;

export const engagementKindSchema = z.enum([
  'delivered',
  'opened',
  'reply',
  'callback_tap',
  'thumbs_up',
  'thumbs_down',
  'mute',
  'disable',
]);
export type EngagementKind = z.infer<typeof engagementKindSchema>;

export const engagementEventSchema = z.strictObject({
  user_id: z.string().min(1),
  push_class: pushClassSchema,
  channel: engagementChannelSchema,
  kind: engagementKindSchema,
  occurred_at: z.string().datetime({ offset: true }),
  run_id: z.string().min(1).optional(),
});
export type EngagementEvent = z.infer<typeof engagementEventSchema>;

export const launchEngagementMetricSchema = z.enum([
  'engagement_open_by_channel',
  'thumbs_ratio',
  'retention_d7_d30',
  'mute_disable_rate',
]);
export type LaunchEngagementMetric = z.infer<typeof launchEngagementMetricSchema>;

export const lowCardinalityMetricLabelSchema = z.strictObject({
  channel: engagementChannelSchema.optional(),
  push_class: pushClassSchema.optional(),
});
export type LowCardinalityMetricLabel = z.infer<typeof lowCardinalityMetricLabelSchema>;

export function isEngagementOpen(event: Pick<EngagementEvent, 'channel' | 'kind'>): boolean {
  if (event.channel === 'telegram') {
    return event.kind === 'reply' || event.kind === 'callback_tap';
  }

  return event.kind === 'opened';
}
