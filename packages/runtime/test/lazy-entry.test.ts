import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import entry, * as lazy from '../src/entry';
import * as full from '../src/index';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';
import type { IMessageBridgeDO } from '../src/channels/imessage/bridge-do';
import type { OwnerDO } from '../src/channels/owner-do';
import type { TaskWorkerDO } from '../src/tasks/worker-do';

// Runs with the deployed entry as main (vitest.lazy-entry.config.ts), so every binding here is a forwarding class.
const CLASSES = ['OwnerDO', 'DeviceBridgeDO', 'IMessageBridgeDO', 'TaskWorkerDO'] as const;
const HANDLERS = ['fetch', 'alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError'];
const names = (prototype: object) => Object.getOwnPropertyNames(prototype).filter((name) => name !== 'constructor');

describe('lazy deployed entry', () => {
  it('forwards only methods the real class has, and every Durable Object handler it defines', () => {
    for (const name of CLASSES) {
      const forwarded = names(Object.getPrototypeOf(lazy[name].prototype));
      const real = full[name].prototype as unknown as Record<string, unknown>;
      for (const method of forwarded) expect(typeof real[method], `${name}.${method}`).toBe('function');
      expect(forwarded.filter((method) => HANDLERS.includes(method)).sort(), name).toEqual(names(real).filter((method) => HANDLERS.includes(method)).sort());
    }
  });

  it('serves the default handler from the full Worker', async () => {
    const response = await entry.fetch(new Request('https://waldo.invalid/healthz'), { WALDO_RELEASE: 'lazy-entry' } as unknown as Cloudflare.Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, release: 'lazy-entry' });
  });

  it('builds the real object, and the blockConcurrencyWhile its constructor starts, before the first event', async () => {
    const stub = env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.newUniqueId()) as unknown as DurableObjectStub<DeviceBridgeDO>;
    await runInDurableObject(stub, (instance) => { expect(instance).toBeInstanceOf(lazy.DeviceBridgeDO); });
    const now = Math.floor(Date.now() / 1000);
    expect(await stub.admitNonce('nonce-1', now)).toBe(true);
    expect(await stub.admitNonce('nonce-1', now)).toBe(false);
    expect(await stub.listCommands()).toEqual([]);
    expect(await stub.status()).toEqual({ online: false, last_heartbeat_at: null });
    await stub.revoke();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });

  it('forwards fetch and RPC to the owner and iMessage objects', async () => {
    const owner = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('lazy-entry-owner'));
    expect((await owner.fetch(new Request('https://owner.invalid/console/browser/trial'))).status).toBe(401);
    const bridge = env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.newUniqueId()) as unknown as DurableObjectStub<IMessageBridgeDO>;
    expect(await bridge.tapbacksReady()).toBe(false);
  });

  it('runs a task worker alarm whose owner RPC goes through both forwarders', async () => {
    const ownerId = env.OWNER_DO!.idFromName('lazy-entry-task-owner');
    const ticket = { jobId: 'job-unknown', attempt: 1, token: 'token-unknown' };
    const owner = env.OWNER_DO!.get(ownerId) as unknown as DurableObjectStub<OwnerDO>;
    expect(await owner.taskHeartbeat(ticket)).toBe(false);
    const tasks = (env as unknown as { TASK_WORKER_DO: DurableObjectNamespace<TaskWorkerDO> }).TASK_WORKER_DO;
    const worker = tasks.get(tasks.idFromName('lazy-entry-task'));
    await worker.start({ owner: ownerId.toString(), ticket });
    // start arms an immediate alarm; an unknown job is not claimable, so the attempt ends and the worker clears its ticket.
    await vi.waitFor(() => runInDurableObject(worker, (_instance, state) => { expect([...state.storage.kv.list()]).toEqual([]); }));
  });
});
