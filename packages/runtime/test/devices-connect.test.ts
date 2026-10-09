import { expect, it, vi } from 'vitest';
import type { DeviceBridgeEnv } from '../src/devices/connect-route';
import { handleDeviceConnect } from '../src/devices/connect-route';
it('fails closed with identical generic bytes before any upgrade for invalid admission', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await handleDeviceConnect(new Request('https://bridge.test/devices/connect', { method }), {});
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"error":"invalid_request"}');
  }
});
it('never allocates a device DO when the source IP handshake budget is exhausted', async () => {
  const get = vi.fn();
  const env = { RESPONSIBILITY_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) }, DEVICE_BRIDGE_DO: { idFromName: vi.fn(() => 'fixture'), get } } as unknown as DeviceBridgeEnv;
  const response = await handleDeviceConnect(new Request('https://bridge.test/devices/connect?contract_version=0.2.3&declared_capabilities=machine_state_query', { headers: { 'x-waldo-device-id': 'dev_fixture', upgrade: 'websocket' } }), env);
  expect(response.status).toBe(401);
  expect(get).not.toHaveBeenCalled();
});
