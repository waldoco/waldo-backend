import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { FORGET_PURGE_ID } from '../src/memory/forget-purge';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
const { OwnerDO } = await import('../src/channels/owner-do');

// An owner whose last forget left a pending purge row for a claim that was then deleted has no pending topic and no purging
// claim, so nothing woke the purge job: the row, and the blank profile view it causes, stayed for good.
it('wakes the purge job for a pending row whose claim is gone, and the job clears it', async () => {
  const stub = env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('forget-orphan-owner'));
  await runInDurableObject(stub, async (_instance, state) => {
    const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    state.storage.sql.exec('INSERT INTO purge_pending (claim_id, fingerprint, created_at) VALUES (?, ?, ?)', 999, 'fp-orphan', '2026-10-01T00:00:00.000Z');
    expect(memory.orphanPurgeRows()).toBe(1);
    expect(memory.pendingTopics()).toEqual([]);
    expect(memory.claims('purging')).toEqual([]);
    state.storage.kv.put('do_name', 'forget-orphan-owner');
    const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC' });
    try {
      await owner.alarm();
      await vi.waitFor(() => expect(memory.orphanPurgeRows()).toBe(0), { timeout: 5_000, interval: 25 });
      expect(new Scheduler(state.storage.sql, state.storage, productionDeps()).lookup(FORGET_PURGE_ID).state).toBe('absent');
    } finally { await state.storage.deleteAlarm(); }
  });
});
