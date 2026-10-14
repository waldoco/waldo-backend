import { expect, it } from 'vitest';
import { googleProxy } from '../src/connectors/connections';

const sent: Record<string, unknown>[] = [];
const proxy = (reply: unknown) => googleProxy({ SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'k', WALDO_ROUTER_HMAC_SECRET: 's' } as never,
  (async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return Response.json(reply); }) as unknown as typeof fetch)!;

it('a Vault-backed calendar watch and stop cross to the edge as typed ops, never as a Google method call', async () => {
  sent.length = 0;
  const watch = await proxy({ data: { channelId: 'chan-1', resourceId: 'res-1', expiration: 1760000000000 } }).calendarWatch('owner', 'conn', { channelId: 'chan-1', token: 'v1.t', address: 'https://w.test/events/gcal' });
  expect(watch).toEqual({ channelId: 'chan-1', resourceId: 'res-1', expiration: 1760000000000 });
  await proxy({ data: null }).stopChannel('owner', 'conn', { channelId: 'chan-1', resourceId: 'res-1' });
  expect(sent).toEqual([
    { do_name: 'owner', op: 'calendar_watch', connection: 'conn', channel_id: 'chan-1', token: 'v1.t', address: 'https://w.test/events/gcal' },
    { do_name: 'owner', op: 'channel_stop', connection: 'conn', channel_id: 'chan-1', resource_id: 'res-1' },
  ]);
});

it('an edge refusal surfaces as an error with its status, and a malformed reply is refused', async () => {
  await expect(proxy({ error: { status: 403, message: 'insufficient scopes' } }).calendarWatch('owner', 'conn', { channelId: 'c', token: 't', address: 'https://w.test/events/gcal' })).rejects.toMatchObject({ status: 403 });
  await expect(proxy({ data: { channelId: 'other', resourceId: 'r', expiration: 1 } }).calendarWatch('owner', 'conn', { channelId: 'c', token: 't', address: 'https://w.test/events/gcal' })).rejects.toThrow();
});
