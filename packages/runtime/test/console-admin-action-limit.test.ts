import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { CONSOLE_ACTION_PATH, consoleAccess } from '../src/channels/console';

// An admin's write through the console's JSON action route spends the console action budget, as the admin read spends the
// read budget: once it is spent, the route answers 429 before any directory call.
it('the console admin action route is rate-limited like every other console action', async () => {
  const name = `console-admin-action-limit-${crypto.randomUUID()}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_unused, state) => {
    const owner = new OwnerDO(state, { ...env, OPENAI_API_KEY: 'synthetic-model-key', WALDO_OWNER_TIMEZONE: 'UTC' } as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('origin', 'https://telegram-owner');
    const token = await consoleAccess(state.storage).grant();
    const csrf = (await state.storage.get<Record<string, { csrf: string }>>('console:sessions'))![token]!.csrf;
    const revoke = () => owner.fetch(new Request(`https://telegram-owner${CONSOLE_ACTION_PATH}`, { method: 'POST',
      headers: { cookie: `waldo_console=${token}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, action: 'invite.revoke', id: 'invite-1' }) }));
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) statuses.push((await revoke()).status);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.indexOf(429)).toBeGreaterThan(0);
    // Up to the limit the route answers as it did, a refusal of its own included; past it, only 429.
    expect(statuses.slice(statuses.indexOf(429)).every((status) => status === 429)).toBe(true);
  });
});
