// The name an owner gave at sign-up reaches their owner object as their own "call me" answer, the claim the first run's
// name step keeps, through the same internal route trust as the console grant.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { claimStore } from '../src/memory/claims';

const owner = (name: string, work: (o: { state: DurableObjectState; profile(body: unknown, doName?: string): Promise<Response> }) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const object = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: undefined });
    const profile = (body: unknown, doName = name) => object.fetch(new Request('https://telegram-owner/signup-profile', {
      method: 'POST', headers: { 'x-waldo-do-name': doName, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    await work({ state, profile });
  });
const called = (state: DurableObjectState) => claimStore(state.storage.sql).claims().filter(claim => claim.text.startsWith('Wants to be called'))
  .map(claim => [claim.text, claim.origin, claim.source, claim.pinned]);

describe('the sign-up name in the owner object', () => {
  it('keeps the name as the owner\'s own pinned answer, and the first answer stands', () => owner('signup-profile-name', async ({ state, profile }) => {
    expect((await profile({ name: 'Asha Menon' })).status).toBe(204);
    expect((await profile({ name: 'Someone Else' })).status).toBe(204);
    expect(called(state)).toEqual([['Wants to be called Asha Menon', 'owner', 'stated', 'profile']]);
  }));
  it('refuses a name that is not one, and keeps nothing', () => owner('signup-profile-invalid', async ({ state, profile }) => {
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(81) }, { name: 'Asha\u0007' }, { name: { first: 'Asha' } }, 'Asha']) {
      expect((await profile(body)).status).toBe(400);
    }
    expect(called(state)).toEqual([]);
  }));
  it('answers only to the name that addresses this very object', () => owner('signup-profile-bound', async ({ state, profile }) => {
    expect((await profile({ name: 'Asha Menon' }, 'someone-else')).status).toBe(403);
    expect(called(state)).toEqual([]);
  }));
});
