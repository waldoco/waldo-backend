import { expect, it, vi } from 'vitest';
import { deviceConsoleAction, renderDevices } from '../src/devices/console-devices';
it('escapes hostile labels and supplies CSRF-protected forms', () => {
  const html = renderDevices([{ device_id: 'dev_1', label: '<script>bad</script>', capabilities: 'machine_state_query', created_at: 'test', last_seen_at: null, online: false }], 'csrf_fixture');
  expect(html).not.toContain('<script>bad</script>');
  expect(html).toContain('csrf_fixture');
  expect(html).toContain('device.pair');
  expect(html).toContain('device.revoke');
});
it('rejects invalid CSRF without minting a code or calling the directory', async () => {
  const directory = { issuePairingCode: vi.fn(), revokeDevice: vi.fn() };
  const form = new FormData(); form.set('action', 'device.pair'); form.set('csrf', 'wrong');
  const response = await deviceConsoleAction(form, 'csrf_fixture', 'owner_fixture', directory, undefined);
  expect(response.status).toBe(403);
  expect(directory.issuePairingCode).not.toHaveBeenCalled();
});
