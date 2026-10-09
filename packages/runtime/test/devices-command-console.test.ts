import { expect, it, vi } from 'vitest';
import { deviceConsoleAction, renderDevices } from '../src/devices/console-devices';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';
const device = { device_id: 'device_fixture', label: '<script>hostile</script>', capabilities: 'machine_state_query,notify_local', created_at: 'fixture', last_seen_at: null, online: false };
const directory = () => ({ issuePairingCode: vi.fn(), revokeDevice: vi.fn(), listDevices: vi.fn(async () => [device]), deviceForAuth: vi.fn(async () => ({ owner_id: 'owner_fixture', pubkey: 'public-fixture', capabilities: ['machine_state_query' as const, 'notify_local' as const] })) });
const form = (action = 'device.notify') => {
  const value = new FormData();
  for (const [key, field] of Object.entries({ action, csrf: 'csrf_fixture', id: device.device_id, request_id: 'request_fixture', notification_id: 'notification_fixture', title: 'Waldo status', body: 'Your Mac is connected.', severity: 'info', query_kind: 'session_status' })) value.set(key, field);
  return value;
};
const namespace = (enqueueCommand: ReturnType<typeof vi.fn>) => ({ idFromName: vi.fn(() => 'device-do-fixture'), get: vi.fn(() => ({ enqueueCommand })) }) as unknown as DurableObjectNamespace<DeviceBridgeDO>;
it('renders explicit owner command forms with stable request identities and honest states', () => {
  const html = renderDevices([{ ...device, commands: [{ command_id: 'cmd_fixture', class: 'machine_state_query', state: 'acked', result_status: null, result_state: null, issued_at: 1, expires_at: 2 }] }], 'csrf_fixture');
  expect(html).toContain('device.query'); expect(html).toContain('device.notify');
  expect(html).toContain('name="request_id"'); expect(html).toContain('name="notification_id"');
  expect(html).toContain('acked'); expect(html).not.toContain('<script>hostile</script>');
  expect(html).not.toContain('done');
});
it('preserves exact explicit owner-selected neutral notification text and stable request IDs', async () => {
  const enqueue = vi.fn(async () => ({ accepted: true, command_id: 'command_fixture', state: 'queued', duplicate: false }));
  const response = await deviceConsoleAction(form(), 'csrf_fixture', 'owner_do_fixture', directory(), namespace(enqueue));
  expect(response.status).toBe(303);
  expect(enqueue).toHaveBeenCalledExactlyOnceWith({ owner_id: 'owner_fixture', device_id: 'device_fixture', request_id: 'request_fixture', class: 'notify_local', payload: { notification_id: 'notification_fixture', title: 'Waldo status', body: 'Your Mac is connected.', severity: 'info' } });
});
it('uses the owner-bound device principal for a closed query kind', async () => {
  const enqueue = vi.fn(async () => ({ accepted: true, command_id: 'command_fixture', state: 'queued', duplicate: false }));
  expect((await deviceConsoleAction(form('device.query'), 'csrf_fixture', 'owner_do_fixture', directory(), namespace(enqueue))).status).toBe(303);
  expect(enqueue).toHaveBeenCalledExactlyOnceWith({ owner_id: 'owner_fixture', device_id: 'device_fixture', request_id: 'request_fixture', class: 'machine_state_query', payload: { query_id: 'request_fixture', query_kind: 'session_status' } });
});
it('rejects invalid CSRF or another owner device before obtaining a command DO', async () => {
  const enqueue = vi.fn(), ns = namespace(enqueue), bound = directory();
  expect((await deviceConsoleAction(form(), 'wrong', 'owner_do_fixture', bound, ns)).status).toBe(403);
  expect(bound.listDevices).not.toHaveBeenCalled();
  bound.listDevices.mockResolvedValue([]);
  expect((await deviceConsoleAction(form(), 'csrf_fixture', 'another_owner', bound, ns)).status).toBe(400);
  expect(ns.get).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
});
it.each([['query_kind','arbitrary_task'], ['request_id',''], ['title',''], ['body','x'.repeat(1025)], ['severity','critical']])('rejects invalid command field %s without queueing', async (key, value) => {
  const request = form(key === 'query_kind' ? 'device.query' : 'device.notify'); request.set(key, value);
  const enqueue = vi.fn();
  expect((await deviceConsoleAction(request, 'csrf_fixture', 'owner_do_fixture', directory(), namespace(enqueue))).status).toBe(400);
  expect(enqueue).not.toHaveBeenCalled();
});
it('gives independent query and notification forms distinct stable request identities',()=>{
 const html=renderDevices([device],'csrf_fixture');
 const requests=[...html.matchAll(/name="request_id" value="([^"]+)"/g)].map(match=>match[1]);
 expect(requests).toHaveLength(2); expect(new Set(requests).size).toBe(2);
});
