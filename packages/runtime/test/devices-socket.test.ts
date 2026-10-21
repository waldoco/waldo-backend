import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';
it('persists replay admission, refuses duplicate nonces, and maintains a revoke fence', async () => {
  const namespace = env.DEVICE_BRIDGE_DO!;
  const stub = namespace.get(namespace.idFromName('dev_socket_fixture')) as DurableObjectStub<DeviceBridgeDO>;
  await runInDurableObject(stub, async (instance) => {
    expect(instance.admitNonce('AAECAwQFBgcICQoLDA0ODw', Math.floor(Date.now() / 1000))).toBe(true);
    expect(instance.admitNonce('AAECAwQFBgcICQoLDA0ODw', Math.floor(Date.now() / 1000))).toBe(false);
    expect(instance.admitNonce('BAECAwQFBgcICQoLDA0ODw', Math.floor(Date.now() / 1000) - 301)).toBe(false);
    expect(await instance.status()).toEqual({ online: false, last_heartbeat_at: null });
    await instance.revoke();
    const rejected = await instance.fetch(new Request('https://bridge.test/devices/connect'));
    expect(rejected.status).toBe(401);
  });
});
it('retains nonce and logical fingerprint custody across an instance eviction', async () => {
  const namespace = env.DEVICE_BRIDGE_DO!;
  const stub = namespace.get(namespace.idFromName('dev_restart_fixture')) as DurableObjectStub<DeviceBridgeDO>;
  await runInDurableObject(stub, async (instance, state) => {
    expect(instance.admitNonce('AAECAwQFBgcICQoLDA0ODw', Math.floor(Date.now() / 1000))).toBe(true);
    state.storage.sql.exec('INSERT INTO frames(message_id,fingerprint,type,created_at) VALUES(?,?,?,?)', '01ARZ3NDEKTSV4RRFFQ69G5FAZ', 'public-fixture-hash', 'heartbeat', Math.floor(Date.now() / 1000));
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (instance, state) => {
    expect(instance.admitNonce('AAECAwQFBgcICQoLDA0ODw', Math.floor(Date.now() / 1000))).toBe(false);
    expect(state.storage.sql.exec('SELECT fingerprint FROM frames').one().fingerprint).toBe('public-fixture-hash');
  });
});
it('arms nonce cleanup strictly after the retention boundary without a past alarm loop', async () => {
  const namespace = env.DEVICE_BRIDGE_DO!;
  const stub = namespace.get(namespace.idFromName('dev_alarm_fixture')) as DurableObjectStub<DeviceBridgeDO>;
  await runInDurableObject(stub, async (instance, state) => {
    const initial = Math.floor(Date.now() / 1000);
    expect(instance.admitNonce('AAECAwQFBgcICQoLDA0ODw', initial)).toBe(true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue((initial + 600) * 1000);
    try {
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      expect(state.storage.sql.exec('SELECT count(*) AS count FROM nonces').one().count).toBe(1);
    } finally { clock.mockRestore(); }
  });
});
