import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { EffectQuotaError, EffectRefusedError, ownerEffectLedger, type EffectIntent } from '../src/channels/owner-effect-ledger';

const intent = (operationId: string, max = 3): EffectIntent => ({ operationId, owner_ref: 'owner', tool: 'calendar_change', payload: { start: operationId },
  quota: { owner_ref: 'owner', grant_ref: 'calendar.move_own_block:sam@example.com', area: 'calendar', action: 'own_block', local_day: '2026-11-03', timezone: 'UTC', max_per_day: max } });
const inDo = (name: string, run: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => run(state));

it('rechecks authority inside the reserve, before any I/O, and records the trace in order', async () => {
  await inDo('authorize-trace', async state => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const trace: string[] = [];
    const receipt = await effects.execute(intent('a'), {
      authorize: () => { trace.push(`authorize:${effects.get('a')?.state ?? 'none'}`); return true; },
      dispatch: async () => { trace.push(`write:${effects.get('a')!.state}`); return { provider_id: 'evt', result: null }; },
      reconcile: async () => { trace.push('readback'); return { status: 'unknown' }; },
    });
    trace.push(`report:${effects.get('a')!.state}`);
    expect(receipt.provider_id).toBe('evt');
    expect(trace).toEqual(['authorize:none', 'write:attempting', 'report:done']);
  });
});

it('a refused authority reserves nothing, writes nothing and spends no budget', async () => {
  await inDo('authorize-refused', async state => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    let writes = 0;
    await expect(effects.execute(intent('a', 1), { authorize: () => false, dispatch: async () => { writes++; return { provider_id: 'x', result: null }; }, reconcile: async () => ({ status: 'unknown' }) }))
      .rejects.toBeInstanceOf(EffectRefusedError);
    expect(writes).toBe(0);
    expect(effects.get('a')).toBeNull();
    // The day's single use is still there for the next authorized intent.
    await effects.execute(intent('b', 1), { authorize: () => true, dispatch: async () => { writes++; return { provider_id: 'y', result: null }; }, reconcile: async () => ({ status: 'unknown' }) });
    expect(writes).toBe(1);
  });
});

it('a reserved intent resumed after its authority ended is rejected, never dispatched', async () => {
  await inDo('authorize-resume', async state => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    effects.reserve(intent('a'));
    let writes = 0;
    await expect(effects.execute(intent('a'), { authorize: () => false, dispatch: async () => { writes++; return { provider_id: 'x', result: null }; }, reconcile: async () => ({ status: 'unknown' }) }))
      .rejects.toBeInstanceOf(EffectRefusedError);
    expect(writes).toBe(0);
    expect(effects.get('a')!.state).toBe('rejected');
  });
});

it('an intent already in flight settles by readback whatever its authority is now', async () => {
  await inDo('authorize-readback', async state => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    await expect(effects.execute(intent('a'), { authorize: () => true, dispatch: async () => { throw new Error('socket closed'); }, reconcile: async () => ({ status: 'unknown' }) })).rejects.toThrow();
    expect(effects.get('a')!.state).toBe('unknown');
    let authorized = 0;
    const receipt = await effects.execute(intent('a'), { authorize: () => { authorized++; return false; }, dispatch: async () => { throw new Error('never'); },
      reconcile: async () => ({ status: 'done', receipt: { provider_id: 'evt', result: null } }) });
    expect(receipt.provider_id).toBe('evt');
    expect(authorized).toBe(0);
    expect(effects.get('a')!.state).toBe('done');
  });
});

it('two concurrent intents at the last unit of budget: exactly one reserves', async () => {
  await inDo('authorize-race', async state => {
    const effects = ownerEffectLedger(state.storage, () => 1000);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    const adapter = { authorize: () => true, dispatch: async () => { writes++; await gate; return { provider_id: `w${writes}`, result: null }; }, reconcile: async () => ({ status: 'unknown' as const }) };
    const first = effects.execute(intent('a', 1), adapter);
    const second = effects.execute(intent('b', 1), adapter);
    release();
    const settled = await Promise.allSettled([first, second]);
    expect(writes).toBe(1);
    expect(settled.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((settled.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(EffectQuotaError);
  });
});
