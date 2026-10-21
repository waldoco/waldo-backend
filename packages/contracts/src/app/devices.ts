import { z } from 'zod';

// Push registration for this app installation, held by waldo.app_push_* (Supabase). The token is sent once
// and never returned. device_epoch counts registrations: register with 0 for a new installation, else the
// current epoch; revoke with the current epoch. A stale epoch is refused. A Worker without these routes answers 404.
const operation = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
// expo is an Expo push token, which Expo's push service delivers through APNs or FCM.
const provider = z.enum(['apns', 'fcm', 'expo']);
const nativeToken = /^[A-Za-z0-9:_-]+$/, expoToken = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/;
const environment = z.enum(['sandbox', 'production']);
export const appDeviceRegisterV1Schema = z.strictObject({
  operation_id: operation, installation_id: z.uuid(), provider, environment,
  token: z.string().min(16).max(4096), expected_device_epoch: z.int().nonnegative(),
}).refine(device => (device.provider === 'expo' ? expoToken : nativeToken).test(device.token), { error: 'the token does not match its provider', path: ['token'] });
export const appDeviceRevokeV1Schema = z.strictObject({ operation_id: operation, installation_id: z.uuid(), expected_device_epoch: z.int().positive() });
export const appDeviceV1Schema = z.strictObject({
  installation_id: z.uuid(), provider, environment, device_epoch: z.int().positive(), state: z.enum(['active', 'revoked']), registered_at: z.int().nonnegative(),
});
export const appDevicesResultV1Schema = z.strictObject({ devices: z.array(appDeviceV1Schema) });
export const appDeviceMutationResultV1Schema = z.strictObject({ device: appDeviceV1Schema, result: z.enum(['registered', 'revoked', 'already_recorded']) });
export const appDeviceRoutesV1 = [
  { method: 'GET', path: '/app/v1/devices', response: appDevicesResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/devices/register', request: appDeviceRegisterV1Schema, response: appDeviceMutationResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/devices/revoke', request: appDeviceRevokeV1Schema, response: appDeviceMutationResultV1Schema, authenticated: true, success_status: 200 },
] as const;

export type AppDeviceV1 = z.infer<typeof appDeviceV1Schema>;
