import { expect, it, vi } from 'vitest';
import { handleDeviceRedeem } from '../src/devices/redeem-route';
import { genericReject } from '../src/devices/generic-reject';
const env = {};
it('makes every malformed redeem failure identical, including wrong methods and infrastructure absence', async () => {
  const expected = genericReject();
  for (const [method, body] of [['GET', undefined], ['POST', '{}'], ['POST', '{"a":1,"a":2}'], ['POST', 'x'.repeat(2049)]] as const) {
    const response = await handleDeviceRedeem(new Request('https://bridge.test/devices/redeem', { method, body }), env);
    expect(response.status).toBe(401);
    expect([...response.headers]).toEqual([...expected.headers]);
    expect(await response.text()).toBe('{"error":"invalid_request"}');
  }
});
it('does not look up a code when a request has invalid shape', async () => {
  const fetcher = vi.fn();
  await handleDeviceRedeem(new Request('https://bridge.test/devices/redeem', { method: 'POST', body: '{}' }), env, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
});
