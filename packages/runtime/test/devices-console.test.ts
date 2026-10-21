import { expect, it, vi } from 'vitest';
import { deviceConsoleAction, devicePageHeaders, renderDevices, renderPairingCode } from '../src/devices/console-devices';
import { devicePairingCodeHash } from '../src/devices/pairing-code';
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

const OWNER_UUID = 'e2e00000-0000-4000-8000-000000000001';
const pairForm = () => { const form = new FormData(); form.set('action', 'device.pair'); form.set('csrf', 'csrf_fixture'); return form; };
it('gives a browser one copyable Kennel code that names the owner, never cached or framed', async () => {
  const directory = { issuePairingCode: vi.fn(), issueOwnedPairingCode: vi.fn(async () => OWNER_UUID), revokeDevice: vi.fn() };
  const response = await deviceConsoleAction(pairForm(), 'csrf_fixture', 'do-a', directory, undefined, 'text/html,application/xhtml+xml');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const html = await response.text();
  const match = /id="code">wp1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})</.exec(html);
  expect(match?.[1]).toBe(OWNER_UUID);
  // The owner-scoped mint stored the digest of exactly the code shown, for the signed-in owner.
  expect(directory.issueOwnedPairingCode).toHaveBeenCalledWith('do-a', await devicePairingCodeHash(match![2]!));
  expect(directory.issuePairingCode).not.toHaveBeenCalled();
  expect(html).toContain('Copy code');
  const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
  expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
  expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
});
it('keeps the plain 43-character code for scripted clients', async () => {
  const directory = { issuePairingCode: vi.fn(async () => true), issueOwnedPairingCode: vi.fn(), revokeDevice: vi.fn() };
  const response = await deviceConsoleAction(pairForm(), 'csrf_fixture', 'do-a', directory, undefined, '*/*');
  expect(response.headers.get('content-type')).toContain('text/plain');
  expect((await response.text()).split('\n')[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(directory.issueOwnedPairingCode).not.toHaveBeenCalled();
});
it('refuses rather than showing a code the directory did not issue', async () => {
  const directory = { issuePairingCode: vi.fn(async () => true), issueOwnedPairingCode: vi.fn(async () => null), revokeDevice: vi.fn() };
  const response = await deviceConsoleAction(pairForm(), 'csrf_fixture', 'do-a', directory, undefined, 'text/html');
  expect(response.status).toBe(400);
  expect(await response.text()).not.toMatch(/wp1\./);
  expect(directory.issueOwnedPairingCode).toHaveBeenCalledTimes(3);
  expect(directory.issuePairingCode).not.toHaveBeenCalled();
});
it('styles the devices page under a per-response nonce and keeps the scripted hooks', () => {
  const html = renderDevices([{ device_id: 'dev_1', label: 'Mac', capabilities: 'machine_state_query', created_at: 'test', last_seen_at: null, online: true }], 'csrf_fixture', 'nonce_fixture');
  expect(html).toContain('<style nonce="nonce_fixture">');
  expect(html).not.toContain('<script');
  expect(html).toContain('Get pairing code');
  expect(html).toContain('<td>Online</td>');
  expect(html).toMatch(/name="csrf" value="csrf_fixture"/);
  expect(devicePageHeaders('nonce_fixture')['content-security-policy']).toContain("style-src 'nonce-nonce_fixture'");
  expect(devicePageHeaders('nonce_fixture')['content-security-policy']).toContain("form-action 'self'");
});
it('escapes the code value on the pairing page', () => {
  expect(renderPairingCode('<b>x</b>', 'n')).not.toContain('<b>x</b>');
});
