import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { rearmSharedAlarm, WAKE_DUE_KEYS } from '../src/scheduler/alarm-slot';
import { COMMON_BROWSER_LEASE_DUE } from '../src/channels/owner-browser-runtime';

// The owner object's one alarm is the earliest of its lanes' persisted wakes and the schedule's next entry.
const { OwnerDO } = await import('../src/channels/owner-do');
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const inObject = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    try { await work(state); } finally { await state.storage.deleteAlarm(); }
  });

it('every listed lane\'s wake alone arms the alarm at its time; the schedule\'s sooner entry wins; nothing due clears it', async () => {
  await inObject('wake-keys-arbiter', async state => {
    const now = Date.now();
    for (const [n, key] of WAKE_DUE_KEYS.entries()) {
      await state.storage.delete([...WAKE_DUE_KEYS]);
      const at = now + 60_000 * (n + 1);
      await state.storage.put(key, at);
      await rearmSharedAlarm(state.storage, null, now);
      expect(await state.storage.getAlarm(), key).toBe(at);
      await rearmSharedAlarm(state.storage, now + 30_000, now);
      expect(await state.storage.getAlarm(), key).toBe(now + 30_000);
    }
    await state.storage.delete([...WAKE_DUE_KEYS]);
    await rearmSharedAlarm(state.storage, null, now);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

// An owner with no surface the directory admits takes the unbound path; a Telegram owner with no directory, the bound one.
const owners = {
  unbound: (state: DurableObjectState) => new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' }),
  bound: (state: DurableObjectState) => {
    state.storage.kv.put('do_name', 'wake-keys-lease-bound'); state.storage.kv.put('telegram_subject', '7');
    return new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: '7' });
  },
};
it.each(Object.keys(owners) as (keyof typeof owners)[])('on the %s path, a browser lease wake that has come runs browser maintenance, which clears it so the arbiter never re-arms a past wake', async path => {
  await inObject(`wake-keys-lease-${path}`, async state => {
    const owner = owners[path](state);
    const browser = (owner as unknown as { ownerBrowser: { maintain(): Promise<void> } }).ownerBrowser;
    const maintain = vi.spyOn(browser, 'maintain');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      state.storage.kv.put(COMMON_BROWSER_LEASE_DUE, Date.now() - 1_000);
      await owner.alarm();
      expect(maintain).toHaveBeenCalledTimes(1);
      await maintain.mock.results[0]!.value;
      expect(state.storage.kv.get(COMMON_BROWSER_LEASE_DUE)).toBeNull();
    } finally { maintain.mockRestore(); quiet.mockRestore(); }
  });
});
