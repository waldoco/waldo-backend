import { z } from 'zod';

export const APP_RIGHTS_VERSION = 'rights.v1' as const;
const operation = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const receipt = z.string().uuid();
const capability = z.string().regex(/^rights_v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,2048}$/);
export const appRightsStoreV1Schema = z.enum(['owner_runtime', 'directory', 'health_plane', 'workspace', 'artifacts', 'push_devices', 'auth_identity', 'audit', 'backups', 'external_providers', 'offline_devices']);
export const appRightsInventoryV1Schema = z.strictObject({
  version: z.literal(APP_RIGHTS_VERSION), revision: z.string().regex(/^[a-f0-9]{64}$/),
  stores: z.array(z.strictObject({ store: appRightsStoreV1Schema, export: z.enum(['included', 'metadata_only', 'separate_authority', 'unavailable']), deletion: z.enum(['managed', 'pending_verification', 'outside_control']), explanation: z.string().min(1).max(500) })),
});
export const appRightsPhaseV1Schema = z.strictObject({
  store: appRightsStoreV1Schema, state: z.enum(['pending', 'running', 'completed', 'failed', 'retained', 'outside_control']), attempts: z.int().nonnegative(), updated_at: z.int().nonnegative(), error: z.enum(['unavailable', 'unconfirmed', 'scope_changed']).nullable(),
});
export const appRightsReceiptV1Schema = z.strictObject({
  version: z.literal(APP_RIGHTS_VERSION), receipt_id: receipt, operation_id: operation,
  job_revision: z.int().positive(),
  kind: z.enum(['export', 'delete']), state: z.enum(['prepared', 'pending', 'running', 'completed_with_limits', 'incomplete']),
  inventory_revision: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.int().nonnegative(), updated_at: z.int().nonnegative(),
  phases: z.array(appRightsPhaseV1Schema),
  file: z.strictObject({ artifact_id: z.string().min(1), revision: z.int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), byte_size: z.int().nonnegative(), download_path: z.string().regex(/^\/app\/v1\/files\/[^/?#]+\/content\?revision=\d+$/) }).nullable(),
  limits: z.array(z.enum(['raw_health_separate_authority', 'credentials_excluded', 'provider_records_not_erased', 'backup_retention_unverified', 'offline_copy_cleanup_unverified', 'audit_retention', 'auth_identity_erasure_unverified'])),
});
export const appExportRequestV1Schema = z.strictObject({ operation_id: operation, expected_inventory_revision: z.string().regex(/^[a-f0-9]{64}$/) });
export const appDeletePrepareV1Schema = appExportRequestV1Schema;
export const appDeletePreparedV1Schema = z.strictObject({ receipt: appRightsReceiptV1Schema, submission_capability: capability, submission_expires_at: z.int().nonnegative(), status_capability: capability, status_expires_at: z.int().nonnegative() });
export const appDeleteSubmitV1Schema = z.strictObject({ submission_capability: capability, confirmed: z.literal(true) });
export const appRightsStatusRequestV1Schema = z.strictObject({ status_capability: capability });
export const appDeviceRegisterV1Schema = z.strictObject({
  operation_id: operation, installation_id: z.string().uuid(), provider: z.enum(['apns', 'fcm']), environment: z.enum(['sandbox', 'production']),
  token: z.string().min(16).max(4096).regex(/^[A-Za-z0-9:_-]+$/), expected_device_epoch: z.int().nonnegative(),
});
export const appDeviceRevokeV1Schema = z.strictObject({ operation_id: operation, installation_id: z.string().uuid(), expected_device_epoch: z.int().nonnegative() });
export const appDeviceV1Schema = z.strictObject({ installation_id: z.string().uuid(), provider: z.enum(['apns', 'fcm']), environment: z.enum(['sandbox', 'production']), device_epoch: z.int().nonnegative(), state: z.enum(['active', 'revoked']), registered_at: z.int().nonnegative(), delivery: z.literal('native_ack_unverified') });
export const appDevicesResultV1Schema = z.strictObject({ devices: z.array(appDeviceV1Schema) });
export const appDeviceMutationResultV1Schema = z.strictObject({ device: appDeviceV1Schema, result: z.enum(['registered', 'revoked', 'already_recorded']) });
export const appRightsRoutesV1 = [
  { method: 'GET', path: '/app/v1/rights/inventory', response: appRightsInventoryV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/rights/exports', request: appExportRequestV1Schema, response: appRightsReceiptV1Schema, authenticated: true, success_status: 202 },
  { method: 'GET', path: '/app/v1/rights/exports/{receipt_id}', response: appRightsReceiptV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/rights/delete/prepare', request: appDeletePrepareV1Schema, response: appDeletePreparedV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/rights/delete/submit', request: appDeleteSubmitV1Schema, response: appRightsReceiptV1Schema, authenticated: false, success_status: 202 },
  { method: 'POST', path: '/app/v1/rights/receipts/status', request: appRightsStatusRequestV1Schema, response: appRightsReceiptV1Schema, authenticated: false, success_status: 200 },
  { method: 'GET', path: '/app/v1/devices', response: appDevicesResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/devices/register', request: appDeviceRegisterV1Schema, response: appDeviceMutationResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/devices/revoke', request: appDeviceRevokeV1Schema, response: appDeviceMutationResultV1Schema, authenticated: true, success_status: 200 },
] as const;
export type AppRightsReceiptV1 = z.infer<typeof appRightsReceiptV1Schema>;
export type AppRightsInventoryV1 = z.infer<typeof appRightsInventoryV1Schema>;
export type AppRightsStoreV1 = z.infer<typeof appRightsStoreV1Schema>;
export type AppDeviceRegisterV1 = z.infer<typeof appDeviceRegisterV1Schema>;
export type AppDeviceRevokeV1 = z.infer<typeof appDeviceRevokeV1Schema>;
export type AppDeviceV1 = z.infer<typeof appDeviceV1Schema>;
