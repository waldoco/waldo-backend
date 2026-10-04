import { expect, it } from 'vitest';
import { handleDeviceConnect } from '../src/devices/connect-route';
it('fails closed with identical generic bytes before any upgrade for invalid admission', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await handleDeviceConnect(new Request('https://bridge.test/devices/connect', { method }), {});
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"error":"invalid_request"}');
  }
});
