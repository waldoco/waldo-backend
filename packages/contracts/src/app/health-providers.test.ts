import { describe, expect, it } from 'vitest';
import { healthConsentListAtRevisionV1, healthConsentGrantV1Schema, healthPurposeV1Schema, isHealthProviderSourceV1 } from './health-ingest';
import {
  appHealthProviderRoutesV1, healthProviderConnectResultV1Schema, healthProviderConnectV1Schema, healthProviderDisconnectResultV1Schema,
  healthProviderDisconnectV1Schema, healthProviderErrorV1Schema, healthProviderListV1Schema, healthProviderStatusV1Schema,
} from './health-providers';

const rejected = (schema: { safeParse(input: unknown): { success: boolean } }, inputs: unknown[]) => inputs.forEach(input => expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(false));
const status = { provider: 'whoop', state: 'connected', last_sync_at: '2026-10-21T06:00:00.000Z' };
const connect = { request_id: 'provider-connect-1', provider: 'whoop' };

describe('health providers: status', () => {
  it('reports each provider with its state and last sync, and never a reading', () => {
    expect(healthProviderListV1Schema.safeParse({ providers: [status] }).success).toBe(true);
    expect(healthProviderStatusV1Schema.safeParse({ ...status, state: 'not_connected', last_sync_at: null }).success).toBe(true);
    for (const state of ['not_connected', 'connected', 'needs_reconnect', 'consent_required']) expect(healthProviderStatusV1Schema.safeParse({ ...status, state }).success, state).toBe(true);
    rejected(healthProviderStatusV1Schema, [{ ...status, state: 'syncing' }, { ...status, provider: 'oura' }, { ...status, recovery: 'low' }, { ...status, last_sync_at: 'yesterday' }, { provider: 'whoop', state: 'connected' }]);
    rejected(healthProviderListV1Schema, [{ providers: [status, status] }, { providers: [] , extra: 1 }]);
  });
});

describe('health providers: connect and disconnect', () => {
  it('starts a connection with a request id and a provider, and answers with the provider\'s own https page and an expiry', () => {
    expect(healthProviderConnectV1Schema.safeParse(connect).success).toBe(true);
    expect(healthProviderConnectResultV1Schema.safeParse({ provider: 'whoop', authorize_url: 'https://api.prod.whoop.com/oauth/oauth2/auth?client_id=x&state=y', expires_at: 1_790_000_000 }).success).toBe(true);
    rejected(healthProviderConnectV1Schema, [{ ...connect, provider: 'garmin' }, { request_id: 'short', provider: 'whoop' }, { ...connect, owner_id: 'forged' }, { ...connect, redirect_uri: 'https://evil.example/' }, { provider: 'whoop' }]);
    rejected(healthProviderConnectResultV1Schema, [{ provider: 'whoop', authorize_url: 'http://api.prod.whoop.com/auth', expires_at: 1 }, { provider: 'whoop', authorize_url: 'javascript:alert(1)', expires_at: 1 }, { provider: 'whoop', authorize_url: 'https://x.example/', expires_at: 0 }, { provider: 'whoop', authorize_url: 'https://x.example/' }]);
  });

  it('answers a disconnect with the state and whether the provider confirmed', () => {
    expect(healthProviderDisconnectV1Schema.safeParse(connect).success).toBe(true);
    for (const revoked_at_provider of [true, false]) expect(healthProviderDisconnectResultV1Schema.safeParse({ provider: 'whoop', state: 'not_connected', revoked_at_provider }).success).toBe(true);
    rejected(healthProviderDisconnectResultV1Schema, [{ provider: 'whoop', state: 'connected', revoked_at_provider: true }, { provider: 'whoop', state: 'not_connected' }, { provider: 'whoop', state: 'not_connected', revoked_at_provider: 'yes' }]);
  });

  it('names closed error codes', () => {
    for (const error of ['invalid_request', 'not_linked', 'consent_required', 'already_linked', 'not_configured', 'unavailable']) expect(healthProviderErrorV1Schema.safeParse({ error }).success, error).toBe(true);
    rejected(healthProviderErrorV1Schema, [{ error: 'teapot' }, { error: 'unavailable', detail: 'x' }, {}]);
  });

  it('declares authenticated routes with an idempotency key on every write', () => {
    expect(appHealthProviderRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual(['GET /app/v1/health/providers', 'POST /app/v1/health/providers/connect', 'POST /app/v1/health/providers/disconnect']);
    for (const route of appHealthProviderRoutesV1) {
      expect(route.authenticated).toBe(true);
      if (route.method === 'POST') expect(route.idempotency_field).toBe('request_id');
    }
  });
});

describe('health providers: consent at revision 2', () => {
  const grant = { request_id: 'health-consent-w01', source: 'whoop', purpose: 'storage_compute', version: 2, expected_epoch: 0, age_attested_18_plus: true };

  it('takes the provider\'s express authorization as the two purposes every source has, and no third', () => {
    expect(healthPurposeV1Schema.options).toEqual(['storage_compute', 'model_processing']);
    for (const purpose of ['storage_compute', 'model_processing']) expect(healthConsentGrantV1Schema.safeParse({ ...grant, purpose }).success, purpose).toBe(true);
    rejected(healthPurposeV1Schema, ['provider_terms', 'provider', 'all']);
    rejected(healthConsentGrantV1Schema, [{ ...grant, purpose: 'provider_terms' }]);
  });

  it('shows an older build no provider rows, since it parses the list strictly', () => {
    const rows = [{ source: 'apple', purpose: 'storage_compute' }, { source: 'whoop', purpose: 'model_processing' }, { source: 'whoop', purpose: 'storage_compute' }];
    expect(healthConsentListAtRevisionV1(rows, 1)).toEqual([rows[0]]);
    expect(healthConsentListAtRevisionV1(rows, 2)).toEqual(rows);
    expect([isHealthProviderSourceV1('whoop'), isHealthProviderSourceV1('apple'), isHealthProviderSourceV1('oura')]).toEqual([true, false, false]);
  });
});
