import { expect, it } from 'vitest';
import { appDeviceMutationResultV1Schema, appDeviceRegisterV1Schema, appDeviceRevokeV1Schema, appDeviceRoutesV1, appDevicesResultV1Schema } from './devices';

const installation_id = '3f2c8a10-4b7d-4c1e-9a2b-1234567890ab';
const register = { operation_id: 'register-0001', installation_id, provider: 'apns', environment: 'sandbox', token: 'a'.repeat(64), expected_device_epoch: 0 };
const device = { installation_id, provider: 'apns', environment: 'sandbox', device_epoch: 1, state: 'active', registered_at: 1_791_700_000_000 };

it('registers a new installation at epoch 0 and revokes only a registered epoch', () => {
  expect(appDeviceRegisterV1Schema.safeParse(register).success).toBe(true);
  expect(appDeviceRegisterV1Schema.safeParse({ ...register, provider: 'fcm', environment: 'production', token: 'fcm:abc_DEF-123456789', expected_device_epoch: 3 }).success).toBe(true);
  expect(appDeviceRevokeV1Schema.safeParse({ operation_id: 'revoke-00001', installation_id, expected_device_epoch: 1 }).success).toBe(true);
  for (const invalid of [
    { ...register, expected_device_epoch: -1 }, { ...register, token: 'short' }, { ...register, token: `${'a'.repeat(20)} spaced` },
    { ...register, provider: 'webpush' }, { ...register, operation_id: 'short' }, { ...register, installation_id: 'not-a-uuid' }, { ...register, secret: 'x' },
  ]) expect(appDeviceRegisterV1Schema.safeParse(invalid).success).toBe(false);
  expect(appDeviceRevokeV1Schema.safeParse({ operation_id: 'revoke-00001', installation_id, expected_device_epoch: 0 }).success).toBe(false);
});

it('takes an Expo push token under its own provider, and each provider only in its own token form', () => {
  const expo = { ...register, provider: 'expo', environment: 'production', token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' };
  expect(appDeviceRegisterV1Schema.safeParse(expo).success).toBe(true);
  expect(appDeviceRegisterV1Schema.safeParse({ ...expo, token: 'ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]' }).success).toBe(true);
  for (const invalid of [
    { ...expo, token: 'a'.repeat(64) }, { ...expo, token: 'ExponentPushToken[short]' }, { ...expo, token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] ' },
    { ...expo, token: `ExponentPushToken[${'x'.repeat(129)}]` }, { ...register, token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' },
    { ...register, provider: 'fcm', token: 'ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]' },
  ]) expect(appDeviceRegisterV1Schema.safeParse(invalid).success).toBe(false);
  expect(appDevicesResultV1Schema.safeParse({ devices: [{ ...device, provider: 'expo' }] }).success).toBe(true);
});

it('never returns a token, and lists devices with their epoch', () => {
  expect(appDevicesResultV1Schema.safeParse({ devices: [device, { ...device, state: 'revoked', device_epoch: 2 }] }).success).toBe(true);
  expect(appDeviceMutationResultV1Schema.safeParse({ device, result: 'already_recorded' }).success).toBe(true);
  for (const invalid of [{ ...device, token: 'a'.repeat(64) }, { ...device, token_hash: 'f'.repeat(64) }, { ...device, delivery: 'native_ack_unverified' }, { ...device, device_epoch: 0 }])
    expect(appDevicesResultV1Schema.safeParse({ devices: [invalid] }).success).toBe(false);
  expect(appDeviceMutationResultV1Schema.safeParse({ device, result: 'pending' }).success).toBe(false);
  expect(appDeviceRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual(['GET /app/v1/devices', 'POST /app/v1/devices/register', 'POST /app/v1/devices/revoke']);
});

it('registers an Expo push token under the expo provider, and only there', () => {
  const expo = { ...register, provider: 'expo', environment: 'production', token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' };
  expect(appDeviceRegisterV1Schema.safeParse(expo).success).toBe(true);
  expect(appDeviceRegisterV1Schema.safeParse({ ...expo, token: 'ExpoPushToken[AbC_dEf-1234567890]' }).success).toBe(true);
  for (const token of ['a'.repeat(64), 'ExponentPushToken[short]', 'ExponentPushToken[has space here ok]', 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]x', `ExponentPushToken[${'x'.repeat(129)}]`])
    expect(appDeviceRegisterV1Schema.safeParse({ ...expo, token }).success).toBe(false);
  for (const provider of ['apns', 'fcm']) expect(appDeviceRegisterV1Schema.safeParse({ ...register, provider, token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' }).success).toBe(false);
  expect(appDevicesResultV1Schema.safeParse({ devices: [{ ...device, provider: 'expo', environment: 'production' }] }).success).toBe(true);
});
