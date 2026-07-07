import { z } from 'zod';

export const pushClassSchema = z.enum([
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
export type PushClass = z.infer<typeof pushClassSchema>;
