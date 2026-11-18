import { describe, expect, it } from 'vitest';
import { HEALTH_SYNC_DAILY_LIMIT_V1, healthSyncPushV1Schema } from '../../contracts/src/app/health-ingest';
import { healthSyncRequester, type HealthSyncDeps } from '../src/health/sync-request';

// The silent push that asks the owner's phones to sync now: no alert, bounded by day and by gap, counted before it is sent.
const PHONE = { installation_id: '0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e', device_epoch: 1, token: 'ExponentPushToken[synthetic-a]' };
const OLD_PHONE = { installation_id: '1c7a4d2f-9b3e-4a6c-8d1f-2e3b4c5d6e7f', device_epoch: 2, token: 'ExponentPushToken[synthetic-b]' };
const MINUTE = 60_000;

const harness = (answer: unknown = { data: [{ status: 'ok' }] }, targets: unknown = [PHONE]) => {
  const store = new Map<string, unknown>();
  let clock = Date.parse('2026-11-16T03:00:00Z');
  const sent: unknown[] = [], retired: unknown[] = [], logs: string[] = [];
  const deps: HealthSyncDeps = {
    accessToken: 'synthetic-expo-token', now: () => clock, today: () => new Date(clock).toISOString().slice(0, 10),
    kv: { get: <T>(key: string) => store.get(key) as T | undefined, put: (key, value) => { store.set(key, value); } },
    targets: async () => targets, retire: async target => { retired.push(target); },
    send: (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return answer instanceof Error ? Promise.reject(answer) : new Response(JSON.stringify(answer)); }) as typeof fetch,
    log: code => { logs.push(code); },
  };
  return { request: healthSyncRequester(deps), sent, retired, logs, advance: (ms: number) => { clock += ms; } };
};

describe('the health sync request', () => {
  it('sends each phone a silent push that carries only its trigger: no title, body or sound', async () => {
    const { request, sent } = harness();
    expect(await request()).toBe('requested');
    expect(sent).toEqual([[{ to: PHONE.token, data: { trigger: 'health_sync' }, contentAvailable: true, priority: 'normal' }]]);
    expect(healthSyncPushV1Schema.safeParse({ trigger: 'health_sync', title: 'Sync now' }).success).toBe(false);
  });

  it('waits thirty minutes between requests and sends at most four a day', async () => {
    const { request, sent, advance } = harness();
    expect(await request()).toBe('requested');
    advance(29 * MINUTE);
    expect(await request()).toBe('too_soon');
    for (let i = 1; i < HEALTH_SYNC_DAILY_LIMIT_V1; i++) { advance(31 * MINUTE); expect(await request()).toBe('requested'); }
    advance(31 * MINUTE);
    expect(await request()).toBe('daily_limit');
    expect(sent).toHaveLength(HEALTH_SYNC_DAILY_LIMIT_V1);
  });

  it('counts a request whose send failed, so a retry cannot pass the gap', async () => {
    const { request, sent } = harness(new Error('synthetic outage'));
    expect(await request()).toBe('failed');
    expect(await request()).toBe('too_soon');
    expect(sent).toHaveLength(1);
  });

  it('retires a phone Expo no longer knows, and says so when no phone is registered or push is not set up', async () => {
    const two = harness({ data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }] }, [PHONE, OLD_PHONE]);
    expect(await two.request()).toBe('requested');
    expect(two.retired).toEqual([OLD_PHONE]);
    expect(await harness(undefined, []).request()).toBe('no_phone');
    const none = harness();
    expect(await healthSyncRequester({ ...({} as HealthSyncDeps), accessToken: undefined })()).toBe('not_configured');
    expect(none.sent).toEqual([]);
  });
});
