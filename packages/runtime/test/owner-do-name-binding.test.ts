import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

// The DO learns its own name from the router's header. Only a name that addresses this very object may bind it,
// the same rule /enqueue and the app route already apply.
const grantWith = async (addressedAs: string, stored: string | null, header: string) => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(addressedAs));
  return runInDurableObject(stub, async (_instance, state) => {
    if (stored) state.storage.kv.put('do_name', stored);
    const owner = new TelegramOwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: undefined });
    const response = await owner.fetch(new Request('https://telegram-owner/grant-console', { method: 'POST', headers: { 'x-waldo-do-name': header } }));
    return { status: response.status, doName: state.storage.kv.get<string>('do_name') ?? null };
  });
};

describe('the owner DO binds its do_name only from a name that addresses it', () => {
  it('binds the name it was addressed by', async () => {
    expect(await grantWith('owner-binding-own', null, 'owner-binding-own')).toEqual({ status: 200, doName: 'owner-binding-own' });
  });

  it('refuses a header naming another owner and stores nothing', async () => {
    expect(await grantWith('owner-binding-fresh', null, 'owner-binding-other')).toEqual({ status: 403, doName: null });
  });

  it('refuses to rebind an already named DO to another owner', async () => {
    expect(await grantWith('owner-binding-named', 'owner-binding-named', 'owner-binding-other')).toEqual({ status: 403, doName: 'owner-binding-named' });
  });

  it('leaves a DO that already holds a wrong name refused rather than silently renamed', async () => {
    expect(await grantWith('owner-binding-legacy', 'owner-binding-wrong', 'owner-binding-legacy')).toEqual({ status: 403, doName: 'owner-binding-wrong' });
  });
});
