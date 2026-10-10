import { describe, expect, it } from 'vitest';
import { appDeleteSubmitV1Schema, appDeviceRegisterV1Schema, appDeviceV1Schema, appRightsRoutesV1 } from './rights';

describe('owner data rights and device API contract', () => {
  it('never admits caller identity and keeps device/consent epochs distinct', () => {
    const device = { operation_id: 'register-operation-0001', installation_id: 'a0000000-0000-4000-8000-000000000001', provider: 'apns', environment: 'sandbox', token: 'synthetic-token-00000000', expected_device_epoch: 0 };
    expect(appDeviceRegisterV1Schema.safeParse(device).success).toBe(true);
    expect(appDeviceRegisterV1Schema.safeParse({ ...device, owner: 'other-owner' }).success).toBe(false);
    expect(appDeviceRegisterV1Schema.safeParse({ ...device, session_ref: 'spoofed-session' }).success).toBe(false);
    expect(appDeviceRegisterV1Schema.safeParse({ ...device, consent_epoch: 1 }).success).toBe(false);
    expect(appDeviceRegisterV1Schema.safeParse({ ...device, expected_device_epoch: -1 }).success).toBe(false);
    expect(appDeviceRegisterV1Schema.safeParse({ ...device, token: 'https://unapproved.invalid/path' }).success).toBe(false);
  });
  it('requires deliberate deletion confirmation and exposes no push token in device projections', () => {
    const submission_capability = `rights_v1.${'a'.repeat(16)}.${'b'.repeat(80)}`;
    expect(appDeleteSubmitV1Schema.safeParse({ submission_capability, confirmed: true }).success).toBe(true);
    expect(appDeleteSubmitV1Schema.safeParse({ submission_capability, confirmed: false }).success).toBe(false);
    const view = { installation_id: 'a0000000-0000-4000-8000-000000000001', provider: 'apns', environment: 'sandbox', device_epoch: 1, state: 'active', registered_at: 0, delivery: 'native_ack_unverified' };
    expect(appDeviceV1Schema.safeParse(view).success).toBe(true);
    expect(appDeviceV1Schema.safeParse({ ...view, token: 'synthetic-token-00000000' }).success).toBe(false);
  });
  it('only submit and receipt-status accept special capability authority instead of ambient sessions', () => {
    expect(appRightsRoutesV1.filter(route => !route.authenticated).map(route => route.path)).toEqual(['/app/v1/rights/delete/submit','/app/v1/rights/receipts/status']);
    expect(appRightsRoutesV1.find(route => route.path === '/app/v1/rights/exports')?.success_status).toBe(202);
    expect(appRightsRoutesV1.find(route => route.path === '/app/v1/devices/register')?.success_status).toBe(200);
  });
});
