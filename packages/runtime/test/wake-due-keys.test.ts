import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { ALARM_FAILED_LANE_KEY, ALARM_LANES, ALARM_RETRY_DUE_KEY, armAlarm, COMMON_EXECUTION_DUE_KEY, rearmSharedAlarm, WAKE_DUE_KEYS } from '../src/scheduler/alarm-slot';
import { COMMON_BROWSER_LEASE_DUE } from '../src/channels/owner-browser-runtime';

// The owner object's one alarm is the earliest of its lanes' persisted wakes and the schedule's next entry.
const { OwnerDO } = await import('../src/channels/owner-do');
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const inObject = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    try { await work(state); } finally { await state.storage.deleteAlarm(); }
  });

// The handler's retry key is the failing lane's wake, not a lane's own; the hold tests below cover it.
it('every listed lane\'s wake alone arms the alarm at its time; the schedule\'s sooner entry wins; nothing due clears it', async () => {
  await inObject('wake-keys-arbiter', async state => {
    const now = Date.now();
    for (const [n, key] of WAKE_DUE_KEYS.filter(key => key !== ALARM_RETRY_DUE_KEY).entries()) {
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

it('every listed wake but the handler\'s retry belongs to exactly one lane; the run-loop object\'s execution wake belongs to none', () => {
  const lanes = new Map<string, string[]>();
  for (const [lane, keys] of Object.entries(ALARM_LANES)) for (const key of keys) lanes.set(key, [...lanes.get(key) ?? [], lane]);
  for (const key of WAKE_DUE_KEYS) expect(lanes.get(key) ?? [], key).toHaveLength(key === ALARM_RETRY_DUE_KEY || key === COMMON_EXECUTION_DUE_KEY ? 0 : 1);
  expect([...lanes.keys()].filter(key => !(WAKE_DUE_KEYS as readonly string[]).includes(key))).toEqual([]);
});

// Times are ten minutes ahead, so no wake armed here fires during the test.
it('while a lane waits for its retry, its wakes arm no sooner than the retry and other lanes\' as due; a whole-pass hold holds them all', async () => {
  await inObject('wake-keys-retry-floor', async state => {
    const now = Date.now() + 600_000, retry = now + 8_000, armed = () => state.storage.getAlarm();
    const hold = (lane: string | null, retryDue = retry) => state.storage.put(lane === null ? { [ALARM_RETRY_DUE_KEY]: retryDue } : { [ALARM_RETRY_DUE_KEY]: retryDue, [ALARM_FAILED_LANE_KEY]: lane });
    const reset = async () => { await state.storage.delete([...WAKE_DUE_KEYS, ALARM_FAILED_LANE_KEY]); await state.storage.deleteAlarm(); };
    await reset();
    await state.storage.put('telegram_owner_inbox_due_v1', now - 1_000);
    await rearmSharedAlarm(state.storage, null, now);
    expect(await armed(), 'no retry pending: the 250 ms floor').toBe(now + 250);
    await hold('inbox');
    await armAlarm(state.storage, now + 1_000);
    await rearmSharedAlarm(state.storage, null, now);
    expect(await armed(), 'only the held lane due: an earlier wake in the slot stays').toBe(now + 1_000);
    await state.storage.deleteAlarm();
    await rearmSharedAlarm(state.storage, null, now);
    expect(await armed(), 'only the held lane due, slot empty: its retry').toBe(retry);
    await state.storage.put('telegram_final_outbox_due_v1', now - 1_000);
    await rearmSharedAlarm(state.storage, null, now);
    expect(await armed(), 'another lane past due: the floor').toBe(now + 250);
    await state.storage.put('telegram_final_outbox_due_v1', now + 3_000);
    await rearmSharedAlarm(state.storage, null, now);
    expect(await armed(), 'another lane due before the retry: its time').toBe(now + 3_000);
    await rearmSharedAlarm(state.storage, now - 1_000, now);
    expect(await armed(), 'the schedule is another lane too').toBe(now + 250);
    await reset();
    await hold('schedule');
    await rearmSharedAlarm(state.storage, now - 1_000, now);
    expect(await armed(), 'the held schedule: its retry').toBe(retry);
    await reset();
    await hold(null);
    await state.storage.put('telegram_final_outbox_due_v1', now - 1_000);
    await rearmSharedAlarm(state.storage, null, now);
    expect(await armed(), 'a record with no lane holds the whole pass').toBe(retry);
    await state.storage.put('telegram_final_outbox_due_v1', now + 3_000);
    await state.storage.deleteAlarm();
    await rearmSharedAlarm(state.storage, null, now);
    expect(await armed(), 'a whole-pass hold holds a sooner future wake too').toBe(retry);
    await reset();
    // A retry due now is the retry: nothing waits for it, so the slot's earlier wake gives way.
    await hold('inbox', now);
    await state.storage.put('telegram_owner_inbox_due_v1', now - 1_000);
    await armAlarm(state.storage, now - 10);
    await rearmSharedAlarm(state.storage, null, now, 0);
    expect(await armed(), 'a retry due now holds nothing').toBe(now);
    await reset();
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
