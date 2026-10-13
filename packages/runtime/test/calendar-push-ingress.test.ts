import { describe, expect, it, vi } from 'vitest';
import { handleEventIngress, type EventIngressEnv } from '../src/channels/event-ingress';
import { calendarChannelToken } from '../src/connectors/google-push';

const SECRET = 'router-secret-fixture-0000000000';
const namespace = (status = 200) => {
  const fetch = vi.fn(async () => new Response('ok', { status }));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};
const push = async (over: Record<string, string> = {}, token?: string) => new Request('https://w.test/events/gcal', { method: 'POST', headers: {
  'x-goog-channel-id': 'chan-1', 'x-goog-channel-token': token ?? await calendarChannelToken(SECRET, 'owner-a', 'chan-1'),
  'x-goog-resource-state': 'exists', 'x-goog-message-number': '7', 'x-goog-resource-id': 'res-1', ...over } });

describe('Calendar push ingress', () => {
  it('wakes the owner the token names, with only channel, state and number', async () => {
    const { fetch, idFromName, ns } = namespace();
    const env: EventIngressEnv = { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET };
    expect((await handleEventIngress(await push(), env, () => undefined)).status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('owner-a');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://owner/google-push');
    expect(init.headers).toEqual({ 'x-waldo-gcal-channel': 'chan-1', 'x-waldo-gcal-state': 'exists', 'x-waldo-gcal-number': '7' });
    expect(JSON.stringify(init)).not.toContain('v1.');
  });

  it('a forged token, or one minted for another channel, is refused and wakes no one', async () => {
    const { fetch, ns } = namespace();
    const env: EventIngressEnv = { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET };
    expect((await handleEventIngress(await push({}, `v1.b3duZXItYQ.${'0'.repeat(64)}`), env, () => undefined)).status).toBe(403);
    expect((await handleEventIngress(await push({}, await calendarChannelToken(SECRET, 'owner-a', 'chan-2')), env, () => undefined)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('malformed headers are acknowledged and dropped so Google does not retry them', async () => {
    const { fetch, ns } = namespace();
    expect((await handleEventIngress(await push({ 'x-goog-message-number': 'x' }), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, () => undefined)).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is not served without the router secret, and only to POST', async () => {
    const { fetch, ns } = namespace();
    expect((await handleEventIngress(await push(), { OWNER_DO: ns }, () => undefined)).status).toBe(404);
    expect((await handleEventIngress(new Request('https://w.test/events/gcal'), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, () => undefined)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an owner object that cannot take the wake gets a retry from Google', async () => {
    const { ns } = namespace(503);
    expect((await handleEventIngress(await push(), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, () => undefined)).status).toBe(503);
  });
});
