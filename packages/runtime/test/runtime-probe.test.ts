import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { RuntimeProbeDO } from '../src/index';

// The primary workerd proof is functional: cloudflare:workers env and the
// cloudflare:test DO helpers below resolve and execute only inside workerd —
// plain Node cannot run them. navigator.userAgent is a light secondary signal.
describe('RuntimeProbeDO in the Workers runtime', () => {
  it('runs in workerd, not a Node approximation', () => {
    // workerd exposes navigator.userAgent === 'Cloudflare-Workers' (default-on since
    // compatibility_date 2022-03-21). This workers-types version does not declare the
    // global, so read it through a narrow typed view — a light secondary signal; the
    // primary proof is the cloudflare:test helpers executing below.
    const { navigator } = globalThis as unknown as { navigator: { userAgent: string } };
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });

  it('persists DO SQLite state across an alarm and survives eviction', async () => {
    const id = env.RUNTIME_DO.idFromName('probe');
    const stub = env.RUNTIME_DO.get(id);

    await stub.seed();

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Same live instance: SQLite advanced to 2 and the in-memory flag is set.
    await runInDurableObject(stub, async (instance: RuntimeProbeDO) => {
      expect(await instance.readTick()).toBe(2);
      expect(instance.inMemoryTouched).toBe(true);
    });

    await evictDurableObject(stub);

    // Reconstructed instance: durable SQLite survived (tick still 2) while the
    // in-memory flag reset to false — proving the eviction actually took effect.
    await runInDurableObject(stub, async (instance: RuntimeProbeDO) => {
      expect(await instance.readTick()).toBe(2);
      expect(instance.inMemoryTouched).toBe(false);
    });
  });
});
