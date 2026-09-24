import { z } from 'zod';

// ConnectIntent (CONNECT_FLOW_DESIGN 4.4, slice S4): a connector tool reports "auth required"
// as a typed intent, never as a URL in text. The responder acts on it through the channel's
// offerConnect seam; the model only ever sees fixed words. Feature mirrors GoogleFeature in
// runtime/connectors/google - the union lives here because contracts cannot import runtime.
export const connectIntentSchema = z.strictObject({
  status: z.literal('auth_required'),
  service: z.literal('google'),
  reason: z.enum(['not_connected', 'scope_missing', 'reauth_needed']),
  feature: z.enum(['calendar', 'mail', 'tasks']).optional(),
});
export type ConnectIntent = z.infer<typeof connectIntentSchema>;
