import { describe, expect, it, vi } from 'vitest';
import { calendarChannelToken, CALENDAR_WATCH_URL, CHANNEL_STOP_URL, GooglePushError, parseCalendarPush, startCalendarWatch, stopChannel, verifyCalendarChannel, watchDue } from '../src/connectors/google-push';

const SECRET = 'router-secret-fixture-0000000000';

describe('calendar channel token', () => {
  it('names the owner it was minted for, on that channel only', async () => {
    const token = await calendarChannelToken(SECRET, 'owner-a', 'chan-1');
    expect(token.length).toBeLessThanOrEqual(256);
    expect(await verifyCalendarChannel(SECRET, token, 'chan-1')).toBe('owner-a');
    expect(await verifyCalendarChannel(SECRET, token, 'chan-2')).toBeNull();
    expect(await verifyCalendarChannel('another-secret-fixture-000000000', token, 'chan-1')).toBeNull();
  });

  it('a token edited to name another owner is refused', async () => {
    const token = await calendarChannelToken(SECRET, 'owner-a', 'chan-1');
    const [version, , mac] = token.split('.');
    const forged = `${version}.${btoa('owner-b').replace(/=+$/, '')}.${mac}`;
    expect(await verifyCalendarChannel(SECRET, forged, 'chan-1')).toBeNull();
  });

  it.each(['', 'v1', 'v1..', 'v2.b3duZXI.00', `v1.${'a'.repeat(300)}.00`, 'v1.!!!.00'])('malformed token %j is refused', async (token) => {
    expect(await verifyCalendarChannel(SECRET, token, 'chan-1')).toBeNull();
  });
});

describe('calendar push headers', () => {
  const headers = (over: Record<string, string> = {}) => new Headers({ 'x-goog-channel-id': 'chan-1', 'x-goog-channel-token': 't', 'x-goog-resource-state': 'exists', 'x-goog-message-number': '7', 'x-goog-resource-id': 'res-1', ...over });
  it('reads channel, token, state and message number', () => {
    expect(parseCalendarPush(headers())).toEqual({ channelId: 'chan-1', token: 't', state: 'exists', messageNumber: 7 });
    expect(parseCalendarPush(headers({ 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' }))).toMatchObject({ state: 'sync', messageNumber: 1 });
  });
  it.each<Record<string, string>>([{ 'x-goog-channel-id': '' }, { 'x-goog-message-number': 'x' }, { 'x-goog-message-number': '-1' }, { 'x-goog-resource-state': 'weird' }, { 'x-goog-channel-id': 'c'.repeat(200) }])('malformed headers %j are refused', (over) => {
    expect(parseCalendarPush(headers(over))).toBeNull();
  });
});

describe('watch and stop calls', () => {
  it('starts a web_hook watch on the primary calendar with the token and a bounded ttl', async () => {
    const fetcher = vi.fn(async () => Response.json({ kind: 'api#channel', id: 'chan-1', resourceId: 'res-1', expiration: '1760000000000' }));
    const watch = await startCalendarWatch(fetcher as unknown as typeof fetch, 'ya29.fixture', { channelId: 'chan-1', token: 'tok', address: 'https://w.test/events/gcal' });
    expect(watch).toEqual({ channelId: 'chan-1', resourceId: 'res-1', expiration: 1760000000000 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CALENDAR_WATCH_URL);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ya29.fixture');
    expect(JSON.parse(String(init.body))).toEqual({ id: 'chan-1', type: 'web_hook', address: 'https://w.test/events/gcal', token: 'tok', params: { ttl: '604800' } });
  });

  it('refuses a non-https or foreign-path address before any call', async () => {
    const fetcher = vi.fn();
    for (const address of ['http://w.test/events/gcal', 'https://w.test/elsewhere'])
      await expect(startCalendarWatch(fetcher as unknown as typeof fetch, 't', { channelId: 'c', token: 't', address })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[401, 'auth'], [403, 'refused'], [400, 'refused'], [429, 'transient'], [503, 'transient']] as const)('provider %i is a typed %s failure with no provider text', async (status, code) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'PRIVATE_CANARY' } }), { status }));
    const result = startCalendarWatch(fetcher as unknown as typeof fetch, 't', { channelId: 'c', token: 't', address: 'https://w.test/events/gcal' });
    await expect(result).rejects.toMatchObject({ status, code });
    await result.catch((error: unknown) => { expect(error).toBeInstanceOf(GooglePushError); expect(String(error)).not.toContain('PRIVATE_CANARY'); });
  });

  it('a reply naming another channel is malformed', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'other', resourceId: 'r', expiration: '1' }));
    await expect(startCalendarWatch(fetcher as unknown as typeof fetch, 't', { channelId: 'c', token: 't', address: 'https://w.test/events/gcal' })).rejects.toMatchObject({ code: 'malformed' });
  });

  it('stops a channel by id and resource', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await stopChannel(fetcher as unknown as typeof fetch, 't', { channelId: 'c', resourceId: 'r' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CHANNEL_STOP_URL);
    expect(JSON.parse(String(init.body))).toEqual({ id: 'c', resourceId: 'r' });
  });
});

describe('when a watch is due', () => {
  const HOUR = 3_600_000;
  it('is due with no watch, within a day of expiry, or after expiry', () => {
    expect(watchDue(null, 0)).toBe(true);
    expect(watchDue({ channelId: 'c', resourceId: 'r', expiration: 30 * HOUR }, 0)).toBe(false);
    expect(watchDue({ channelId: 'c', resourceId: 'r', expiration: 23 * HOUR }, 0)).toBe(true);
  });
  it('waits six hours after a failed attempt', () => {
    expect(watchDue({ failedAt: 0 }, 5 * HOUR)).toBe(false);
    expect(watchDue({ failedAt: 0 }, 6 * HOUR)).toBe(true);
  });
});
