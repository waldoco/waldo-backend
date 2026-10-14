import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { armBriefSweep, BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { gmailPushBook } from '../src/channels/gmail-push';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

const push = (history: string, connection = 'conn') => new Request('https://owner/gmail-push', { method: 'POST', headers: { 'x-waldo-gmail-connection': connection, 'x-waldo-gmail-history': history } });

it('a Gmail push for the watched mailbox pulls the update sweep forward once; older points and other mailboxes do not', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('owner-gmail-push')), async (_instance, state) => {
    ensureSchema(state.storage);
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    const start = Date.now();
    await armBriefSweep(scheduler, start);
    const due = () => scheduler.read(BRIEF_SWEEP_ID)!.due_at;
    gmailPushBook(state.storage.kv).record({ historyId: '100', expiration: start + 7 * 86_400_000 }, 'conn', start);
    const owner = new OwnerDO(state, env);
    try {
      expect((await owner.fetch(push('100'))).status).toBe(200);
      expect((await owner.fetch(push('500', 'other'))).status).toBe(200);
      expect(due()).toBeGreaterThan(start + 5 * 60_000);
      expect((await owner.fetch(push('101'))).status).toBe(200);
      expect(due()).toBeLessThanOrEqual(Date.now());
    } finally { await state.storage.deleteAlarm(); }
  });
});
