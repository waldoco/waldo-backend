import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';

// Calendar watch renewals, scheduled cards and connect offers run on alarms and read the stored origin, so an owner who
// sends nothing after a host move must not keep issuing the old host.
it('adopts the configured public origin when the owner object starts, before any request reaches it', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('public-origin-startup'));
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.kv.put('origin', 'https://old-host.fixture.invalid');
    new OwnerDO(state, { ...env, WALDO_PUBLIC_ORIGIN: 'https://staging.fixture.invalid' } as never);
    expect(state.storage.kv.get('origin')).toBe('https://staging.fixture.invalid');
    expect(await state.storage.get('origin')).toBe('https://staging.fixture.invalid');
  });
});

it('leaves the stored origin alone when the environment names none', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('public-origin-unset'));
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.kv.put('origin', 'https://old-host.fixture.invalid');
    new OwnerDO(state, { ...env, WALDO_PUBLIC_ORIGIN: '' } as never);
    expect(state.storage.kv.get('origin')).toBe('https://old-host.fixture.invalid');
  });
});
