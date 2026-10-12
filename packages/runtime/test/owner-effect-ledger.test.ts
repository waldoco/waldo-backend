import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ownerEffectLedger, EffectUnknownError, EffectQuotaError } from '../src/channels/owner-effect-ledger';

const input = (operationId: string) => ({ operationId, owner_ref: 'owner', tool: 'send_email', payload: { to: 'friend' } });
const quota = { owner_ref: 'owner', grant_ref: 'grant', area: 'mail', action: 'send', local_day: '2026-10-08', timezone: 'Asia/Calcutta', max_per_day: 1 };

describe('owner effect ledger', () => {
  it('reserves intent before send and reconciles a crash without sending twice', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effects-crash'));
    await runInDurableObject(stub, async (_instance, state) => {
      const ledger = ownerEffectLedger(state.storage, () => 1000);
      let sends = 0;
      await expect(ledger.execute(input('send'), {
        dispatch: async () => { sends++; expect(ledger.get('send')?.state).toBe('attempting'); throw Error('lost response'); },
        reconcile: async () => ({ status: 'unknown' }),
      })).rejects.toBeInstanceOf(EffectUnknownError);
      const restarted = ownerEffectLedger(state.storage, () => 2000);
      const receipt = await restarted.execute(input('send'), {
        dispatch: async () => { sends++; return { provider_id: 'duplicate', result: 'wrong' }; },
        reconcile: async () => ({ status: 'done', receipt: { provider_id: 'gmail-id', result: 'sent' } }),
      });
      expect(receipt).toEqual({ provider_id: 'gmail-id', result: 'sent' });
      expect(sends).toBe(1);
      expect(restarted.get('send')?.state).toBe('done');
    });
  });
  it('atomically counts pending and unknown intents against a grant quota', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effects-quota'));
    await runInDurableObject(stub, async (_instance, state) => {
      const ledger = ownerEffectLedger(state.storage, () => 1000);
      ledger.reserve({ ...input('one'), quota });
      expect(await ledger.count(quota)).toBe(1);
      expect(() => ledger.reserve({ ...input('two'), quota })).toThrow(EffectQuotaError);
      expect(ledger.get('two')).toBeNull();
      // Reusing an intent must not consume a second quota unit.
      ledger.reserve({ ...input('one'), quota });
      await expect(ledger.execute({ ...input('one'), quota }, { dispatch: async () => { throw Error('timeout'); }, reconcile: async () => ({ status: 'unknown' }) })).rejects.toBeInstanceOf(EffectUnknownError);
      expect(await ledger.count(quota)).toBe(1);
    });
  });
  it('rejects changed payload, owner or grant on an operation id', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effects-conflict'));
    await runInDurableObject(stub, async (_instance, state) => {
      const ledger = ownerEffectLedger(state.storage, () => 1000);
      ledger.reserve({ ...input('one'), quota });
      for (const changed of [{ payload: {} }, { owner_ref: 'other' }, { quota: { ...quota, grant_ref: 'other' } }]) {
        expect(() => ledger.reserve({ ...input('one'), quota, ...changed })).toThrow('effect identity conflict');
      }
    });
  });
  it('does not reconcile or dispatch an operation while its provider call is in flight', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effects-concurrent'));
    await runInDurableObject(stub, async (_instance, state) => {
      const ledger = ownerEffectLedger(state.storage, () => 1000);
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const first = ledger.execute(input('one'), { dispatch: async () => { await wait; return { provider_id: 'id', result: true }; }, reconcile: async () => ({ status: 'unknown' }) });
      await Promise.resolve();
      await expect(ledger.execute(input('one'), { dispatch: async () => { throw Error('duplicate'); }, reconcile: async () => { throw Error('premature readback'); } })).rejects.toBeInstanceOf(EffectUnknownError);
      release(); await first;
    });
  });
  it('recovers when the provider returned but persisting its receipt crashed', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effects-settle-crash'));
    await runInDurableObject(stub, async (_instance, state) => {
      let failSettle = true;
      const storage = { kv: {
        get: state.storage.kv.get.bind(state.storage.kv), list: state.storage.kv.list.bind(state.storage.kv),
        put: (key: string, row: { state: string }) => { if (row.state === 'done' && failSettle) throw Error('storage down'); state.storage.kv.put(key, row); },
      }, transactionSync: state.storage.transactionSync.bind(state.storage) } as unknown as DurableObjectStorage;
      const ledger = ownerEffectLedger(storage, () => 1000);
      let sends = 0;
      const adapter = { dispatch: async () => { sends++; return { provider_id: 'provider', result: 'sent' }; }, reconcile: async () => ({ status: 'done' as const, receipt: { provider_id: 'provider', result: 'sent' } }) };
      await expect(ledger.execute(input('one'), adapter)).rejects.toThrow('storage down');
      expect(ledger.get('one')?.state).toBe('attempting');
      failSettle = false;
      const restarted = ownerEffectLedger(storage, () => 2000);
      expect(await restarted.execute(input('one'), adapter)).toMatchObject({ provider_id: 'provider' });
      expect(sends).toBe(1);
    });
  });
  it('reserves quota across independently constructed hosts and releases only on confirmed non-application', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effects-atomic-hosts'));
    await runInDurableObject(stub, async (_instance, state) => {
      const first = ownerEffectLedger(state.storage, () => 1000);
      const second = ownerEffectLedger(state.storage, () => 1000);
      const results = await Promise.allSettled([
        first.execute({ ...input('one'), quota }, { dispatch: async () => { throw Error('timeout'); }, reconcile: async () => ({ status: 'unknown' }) }),
        second.execute({ ...input('two'), quota }, { dispatch: async () => ({ provider_id: 'wrong', result: true }), reconcile: async () => ({ status: 'unknown' }) }),
      ]);
      expect(results.every(result => result.status === 'rejected')).toBe(true);
      expect(second.get('two')).toBeNull();
      await expect(second.execute({ ...input('one'), quota }, { dispatch: async () => { throw Error('duplicate'); }, reconcile: async () => ({ status: 'not_applied' }) })).rejects.toThrow('effect was not applied');
      expect(await first.count(quota)).toBe(0);
      expect(first.reserve({ ...input('two'), quota }).state).toBe('reserved');
    });
  });
  it('reconciles an in-flight effect recorded under an aliased owner ref instead of conflicting or dispatching', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('effects-owner-alias'));
    await runInDurableObject(stub, async (_instance, state) => {
      const legacy = ownerEffectLedger(state.storage, () => 1000);
      const old = { ...input('approval:p1:apply'), owner_ref: '42' };
      await expect(legacy.execute(old, { dispatch: async () => { throw Error('lost response'); }, reconcile: async () => ({ status: 'unknown' }) })).rejects.toBeInstanceOf(EffectUnknownError);
      expect(legacy.get('approval:p1:apply')?.state).toBe('unknown');
      const principal = { ...old, owner_ref: 'prn_10000000000000000000000000000001' };
      const ledger = ownerEffectLedger(state.storage, () => 2000);
      const never = { dispatch: async () => { throw Error('must not dispatch'); }, reconcile: async () => ({ status: 'unknown' as const }) };
      await expect(ledger.execute(principal, never)).rejects.toThrow('effect identity conflict');
      await expect(ledger.execute(principal, never, undefined, ['7000000000001'])).rejects.toThrow('effect identity conflict');
      await expect(ledger.execute({ ...principal, payload: { to: 'someone else' } }, never, undefined, ['42'])).rejects.toThrow('effect identity conflict');
      let dispatched = 0, reconciled = 0;
      const receipt = await ledger.execute(principal, { dispatch: async () => { dispatched++; return { provider_id: 'twice', result: null }; },
        reconcile: async () => { reconciled++; return { status: 'done', receipt: { provider_id: 'gmail-id', result: 'sent' } }; } }, undefined, ['42']);
      expect(receipt).toEqual({ provider_id: 'gmail-id', result: 'sent' });
      expect({ dispatched, reconciled }).toEqual({ dispatched: 0, reconciled: 1 });
      expect(ledger.get('approval:p1:apply')).toMatchObject({ owner_ref: '42', state: 'done' });
      ledger.reserve({ ...input('quota-one'), owner_ref: '42', quota: { ...quota, owner_ref: '42' } });
      expect(() => ledger.reserve({ ...input('quota-one'), owner_ref: 'prn_x', quota: { ...quota, owner_ref: 'prn_x' } }, undefined, ['42'])).toThrow('effect identity conflict');
    });
  });

});
