import { z } from 'zod';
import { HEALTH_PROVIDER_SOURCES_V1, healthInstantV1Schema, healthRequestIdV1Schema } from './health-ingest';

// Cloud wearables Waldo syncs for the owner (health contract revision 2). The app starts a connection, opens the returned
// address in a browser session, and the provider sends the owner back to Waldo's own callback; no token ever reaches the
// app. The owner's express authorization for storage and AI use (the provider_terms consent) must be live before a
// connection starts, so the app grants the provider's consents first. Self-contained: it imports only zod and siblings.
export const healthProviderV1Schema = z.enum(HEALTH_PROVIDER_SOURCES_V1);
// connected: syncing. needs_reconnect: the provider no longer accepts the saved access, so the owner connects again.
// consent_required: connected, but the owner's consent is not live (it was withdrawn), so nothing is stored.
export const healthProviderStateV1Schema = z.enum(['not_connected', 'connected', 'needs_reconnect', 'consent_required']);
export const healthProviderStatusV1Schema = z.strictObject({
  provider: healthProviderV1Schema,
  state: healthProviderStateV1Schema,
  // The last time a sync committed readings, or null. Never a reading.
  last_sync_at: healthInstantV1Schema.nullable(),
});
export const healthProviderListV1Schema = z.strictObject({ providers: z.array(healthProviderStatusV1Schema).max(HEALTH_PROVIDER_SOURCES_V1.length) });

export const healthProviderConnectV1Schema = z.strictObject({ request_id: healthRequestIdV1Schema, provider: healthProviderV1Schema });
// The address is the provider's own authorization page. It expires, and the connection is complete only when the status
// reads connected.
export const healthProviderConnectResultV1Schema = z.strictObject({
  provider: healthProviderV1Schema,
  authorize_url: z.url({ protocol: /^https$/ }).max(2048),
  expires_at: z.int().positive(),
});
export const healthProviderDisconnectV1Schema = z.strictObject({ request_id: healthRequestIdV1Schema, provider: healthProviderV1Schema });
// revoked_at_provider says whether the provider confirmed it stopped sharing; the saved access is gone either way, and the
// readings Waldo stored stay until the owner withdraws storage consent for that source.
export const healthProviderDisconnectResultV1Schema = z.strictObject({
  provider: healthProviderV1Schema,
  state: z.literal('not_connected'),
  revoked_at_provider: z.boolean(),
});
export const healthProviderErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'not_linked', 'consent_required', 'already_linked', 'not_configured', 'unavailable']),
  message: z.string().max(1000).optional(),
});

export const appHealthProviderRoutesV1 = [
  { method: 'GET', path: '/app/v1/health/providers', response: healthProviderListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/health/providers/connect', request: healthProviderConnectV1Schema, response: healthProviderConnectResultV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: 1024 },
  { method: 'POST', path: '/app/v1/health/providers/disconnect', request: healthProviderDisconnectV1Schema, response: healthProviderDisconnectResultV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: 1024 },
] as const;
export type HealthProviderStatusV1 = z.infer<typeof healthProviderStatusV1Schema>;
