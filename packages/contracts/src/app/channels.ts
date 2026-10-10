import { z } from 'zod';

export const APP_CHANNELS_VERSION = 'channels.v1' as const;
export const APP_CHANNELS_MAX_REQUEST_BYTES = 4096;
export const appChannelProviderV1Schema = z.enum(['app', 'telegram', 'whatsapp', 'imessage']);
export const appLinkableChannelV1Schema = z.enum(['telegram', 'whatsapp']);
export const appChannelRevisionV1Schema = z.string().regex(/^(0|[1-9][0-9]*):[1-9][0-9]{0,18}$/);
export const appChannelsV1Schema = z.strictObject({
  version: z.literal(APP_CHANNELS_VERSION), account_ref: z.string().regex(/^acct_[a-f0-9]{64}$/), revision: appChannelRevisionV1Schema,
  channels: z.array(z.strictObject({ provider: appChannelProviderV1Schema, state: z.enum(['linked', 'available', 'unavailable']),
    link_available: z.boolean(), unlink_available: z.boolean(), reason: z.enum(['not_configured', 'integration_absent']).nullable(),
    authority: z.literal('channel_only'),
  })).length(4),
});
export const appChannelMutationV1Schema = z.strictObject({ operation_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  provider: appLinkableChannelV1Schema, expected_revision: appChannelRevisionV1Schema });
export const appChannelReceiptV1Schema = z.strictObject({ version: z.literal(APP_CHANNELS_VERSION), operation_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  provider: appLinkableChannelV1Schema, kind: z.enum(['link', 'unlink']), state: z.enum(['recorded', 'unconfirmed', 'rejected']),
  revision: appChannelRevisionV1Schema.nullable(), recorded_at: z.int().nonnegative(), authority: z.literal('channel_only'), owner_state: z.literal('preserved'),
  link: z.strictObject({ code: z.string().regex(/^[A-Z2-9]{10}$/), expires_at: z.int().nonnegative(), completion: z.literal('provider_redemption_required') }).nullable(),
});
export const appChannelsRoutesV1 = [
  { method: 'GET', path: '/app/v1/channels', response: appChannelsV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/channels/link', request: appChannelMutationV1Schema, response: appChannelReceiptV1Schema, authenticated: true, success_status: 200, max_request_bytes: APP_CHANNELS_MAX_REQUEST_BYTES },
  { method: 'POST', path: '/app/v1/channels/unlink', request: appChannelMutationV1Schema, response: appChannelReceiptV1Schema, authenticated: true, success_status: 200, max_request_bytes: APP_CHANNELS_MAX_REQUEST_BYTES },
  { method: 'GET', path: '/app/v1/channels/operations/{operation_id}', response: appChannelReceiptV1Schema, authenticated: true, success_status: 200 },
] as const;
export type AppChannelsV1 = z.infer<typeof appChannelsV1Schema>;
export type AppChannelMutationV1 = z.infer<typeof appChannelMutationV1Schema>;
export type AppChannelReceiptV1 = z.infer<typeof appChannelReceiptV1Schema>;
