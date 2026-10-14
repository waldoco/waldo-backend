import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';
import { loopBook } from '../src/channels/loops';

// The owner's ledger (what Waldo is on, their reminders and health log lines) is on their own console page, behind their
// own session. Each owner object is its own store, so a session opened on one never reads another's.
const config = { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' };
const MARKER = 'Synthetic loop only owner A has';
const activity = (owner: OwnerDO, token: string) =>
  owner.fetch(new Request('https://fixture.invalid/console/activity', { headers: { accept: 'application/json', cookie: `${CONSOLE_COOKIE}=${token}` } }));
const withOwner = <T>(name: string, run: (owner: OwnerDO, state: DurableObjectState) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), async (_instance, state) => {
    try { return await run(new OwnerDO(state, config), state); } finally { await state.storage.deleteAlarm(); }
  });

it('the ledger is on the owner\'s own console page, and another owner\'s session cannot read it', async () => {
  const tokenA = await withOwner('ledger-a', async (owner, state) => {
    loopBook(state.storage.sql, { newId: () => 'loop-a', now: Date.now }).open({ title: MARKER, due: null });
    const token = await consoleAccess(state.storage).grant();
    const own = await activity(owner, token);
    expect(own.status).toBe(200);
    expect((await own.json() as { ledger: string }).ledger).toContain(MARKER);
    return token;
  });
  await withOwner('ledger-b', async (owner, state) => {
    const foreign = await activity(owner, tokenA);
    expect(foreign.status).toBe(401);
    expect(await foreign.text()).not.toContain(MARKER);
    const theirs = await activity(owner, await consoleAccess(state.storage).grant());
    expect(theirs.status).toBe(200);
    expect((await theirs.json() as { ledger: string }).ledger).not.toContain(MARKER);
  });
});
