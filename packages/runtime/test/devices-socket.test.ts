import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';
it('persists replay admission, refuses duplicate nonces, and maintains a revoke fence', async () => {
  const namespace = env.DEVICE_BRIDGE_DO!;
  const stub = namespace.get(namespace.idFromName('dev_socket_fixture')) as DurableObjectStub<DeviceBridgeDO>;
  await runInDurableObject(stub, async (instance) => {
    expect(instance.admitNonce('AAECAwQFBgcICQoLDA0ODw', Math.floor(Date.now() / 1000))).toBe(true);
    expect(instance.admitNonce('AAECAwQFBgcICQoLDA0ODw', Math.floor(Date.now() / 1000))).toBe(false);
    expect(await instance.status()).toEqual({ online: false, last_heartbeat_at: null });
    await instance.revoke();
    const rejected = await instance.fetch(new Request('https://bridge.test/devices/connect'));
    expect(rejected.status).toBe(401);
  });
});
