import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appControlActionV1Schema, appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { claimStore, textFingerprint } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const { OwnerDO } = await import('../src/channels/owner-do');

// Controls revision 22: the people view (ADR_PEOPLE_MAP_2026-11-07 §7). Synthetic people only.
const OWNER_ID = '6d7e8f9a-0b1c-4d2e-9f3a-4b5c6d7e8f9a';
const HASH = 'c'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_inventory') { const signedIn = new Date(Date.now() - 60_000).toISOString(); return Response.json([{ session: HASH, created_at: signedIn, last_seen_at: new Date().toISOString(), expires_at: new Date(Date.parse(signedIn) + 30 * 24 * 3_600_000).toISOString(), rotated_to: null, signed_in_at: signedIn }]); }
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response> }>;
type Ctx = Readonly<{ owner: Owner; state: DurableObjectState; name: string }>;
const appOwner = async (name: string, flags: Record<string, string>, check: (ctx: Ctx) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    const owner = new OwnerDO(state, { ...env, ...directory, ...flags, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
    await owner.setup('app').ready;
    try { await check({ owner, state, name }); } finally { await state.storage.deleteAlarm(); }
  });
};
const headers = (name: string, contract = 'controls=22') => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'x-waldo-app-contract': contract });
const read = async ({ owner, name }: Ctx, query = '', contract?: string) => owner.fetch(new Request(`https://telegram-owner/app/v1/controls?view=people${query}`, { headers: headers(name, contract) }));
const people = async (ctx: Ctx, query = '') => {
  const response = await read(ctx, query);
  expect(response.status).toBe(200);
  const body = appControlProjectionV1Schema.parse(await response.json());
  if (body.view !== 'people') throw Error('expected the people view');
  return body;
};
const act = async (ctx: Ctx, fields: Record<string, string>, contract?: string) => {
  const response = await ctx.owner.fetch(new Request('https://telegram-owner/app/v1/actions', { method: 'POST', headers: { ...headers(ctx.name, contract), 'content-type': 'application/json' },
    body: JSON.stringify({ view: 'people', request_id: `person-${crypto.randomUUID()}`, ...fields }) }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
// A person the owner told Waldo about, and one Waldo read about in a forwarded note, each with the claims about them.
const seed = ({ state }: Ctx) => {
  const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
  const at = '2026-11-01T09:00:00Z';
  store.add({ kind: 'fact', text: 'Priya is my sister', source: 'stated', evidence: 'Priya is my sister', origin: 'owner', source_ref: 'owner, m1' }, at);
  store.add({ kind: 'event', text: 'Priya\'s birthday is 14 March', source: 'stated', evidence: 'birthday is 14 March', origin: 'owner', source_ref: 'owner, m1', on_date: '--03-14' }, at);
  const [priya] = store.people.link(1, [{ name: 'Priya', role: 'subject', relation: 'sister', ring: 'inner' }], at);
  store.people.link(2, [{ ref: priya!, role: 'subject' }], at);
  store.add({ kind: 'fact', text: 'Dana runs the book club', source: 'inferred', evidence: 'forwarded mail', origin: 'untrusted', source_ref: 'mail:1' }, at);
  const [dana] = store.people.link(3, [{ name: 'Dana', role: 'subject', relation: 'book club' }], at);
  return { store, priya: priya!, dana: dana! };
};

it('lists the people in memory and one person with their claims; a build below 22, or the switch off, is refused the view', async () => {
  await appOwner('app-people-read', { PEOPLE_MAP: '1' }, async ctx => {
    const { priya, dana } = seed(ctx);
    const list = await people(ctx);
    if (!('people' in list.data)) throw Error('expected the list');
    expect(list.data.people.map(person => [person.id, person.name, person.ring, person.held_as, person.relations, person.actions])).toEqual([
      [`memory:person:${priya}`, 'Priya', 'inner', 'yours', ['sister'], ['person.rename', 'person.ring', 'person.forget']],
      [`memory:person:${dana}`, 'Dana', null, 'waldo_thinks', ['book club'], ['person.confirm', 'person.rename', 'person.ring', 'person.forget']],
    ]);
    expect(list.data.people[0]!.next_date).toMatchObject({ claim_id: 'memory:claim:2', text: 'Priya\'s birthday is 14 March' });
    const one = await people(ctx, `&id=memory:person:${priya}`);
    if (!('person' in one.data)) throw Error('expected a person');
    expect(one.data.claims.map(claim => [claim.id, claim.text])).toEqual(expect.arrayContaining([['memory:claim:1', 'Priya is my sister'], ['memory:claim:2', 'Priya\'s birthday is 14 March']]));
    expect((await read(ctx, '&id=memory:person:999')).status).toBe(404);
    expect((await read(ctx, '&id=memory:claim:1')).status).toBe(400);
    expect((await read(ctx, '', 'controls=21')).status).toBe(400);
    expect((await act(ctx, { action: 'person.ring', id: `memory:person:${dana}`, value: 'close', revision: one.revision }, 'controls=21')).status).toBe(400);
  });
  await appOwner('app-people-off', {}, async ctx => {
    seed(ctx);
    expect((await read(ctx)).status).toBe(400);
  });
});

it('takes the owner\'s word on a person: confirm, rename and ring stand over Waldo\'s, and forget takes them and what memory held about them', async () => {
  await appOwner('app-people-act', { PEOPLE_MAP: '1' }, async ctx => {
    const { store, priya, dana } = seed(ctx);
    const revisionOf = async (id: number) => (await people(ctx, `&id=memory:person:${id}`)).revision;
    expect((await act(ctx, { action: 'person.confirm', id: `memory:person:${dana}`, revision: await revisionOf(dana) })).body).toMatchObject({ receipt: { state: 'recorded' } });
    expect(store.people.claimsOf(dana).some(claim => claim.origin === 'owner')).toBe(true);
    expect((await act(ctx, { action: 'person.rename', id: `memory:person:${dana}`, value: ' Dana Okoye ', revision: await revisionOf(dana) })).body).toMatchObject({ receipt: { state: 'recorded' } });
    expect((await act(ctx, { action: 'person.ring', id: `memory:person:${dana}`, value: 'close', revision: await revisionOf(dana) })).body).toMatchObject({ receipt: { state: 'recorded' } });
    expect(store.people.person(dana)).toMatchObject({ name: 'Dana Okoye', name_by: 'owner', ring: 'close', ring_by: 'owner' });
    // A model write naming Dana with another ring leaves the owner's.
    store.add({ kind: 'fact', text: 'Dana hosts in June', source: 'inferred', evidence: 'note', origin: 'agent', source_ref: 'owner, m3' }, '2026-11-02T09:00:00Z');
    store.people.link(store.allClaims().at(-1)!.id, [{ ref: dana, role: 'subject', ring: 'wider' }], '2026-11-02T09:00:00Z');
    expect(store.people.person(dana)).toMatchObject({ ring: 'close', ring_by: 'owner' });
    // A stale revision changes nothing.
    expect((await act(ctx, { action: 'person.forget', id: `memory:person:${priya}`, revision: 'f'.repeat(64) })).status).toBe(409);
    expect(store.people.person(priya)).toBeDefined();
    expect((await act(ctx, { action: 'person.forget', id: `memory:person:${priya}`, revision: await revisionOf(priya) })).body).toMatchObject({ receipt: { state: 'recorded' } });
    expect(store.people.person(priya)).toBeUndefined();
    expect(store.claims().map(claim => claim.text)).not.toEqual(expect.arrayContaining(['Priya is my sister']));
    expect(store.barriers().length).toBeGreaterThan(0);
  });
});

it('takes a person action only in the people view, naming one person, with the value it needs and nothing else', () => {
  const base = { view: 'people', id: 'memory:person:3', revision: 'a'.repeat(64), request_id: 'person-0001' };
  for (const good of [{ action: 'person.confirm' }, { action: 'person.forget' }, { action: 'person.rename', value: 'Dana' }, { action: 'person.ring', value: 'inner' }])
    expect(appControlActionV1Schema.safeParse({ ...base, ...good }).success, JSON.stringify(good)).toBe(true);
  for (const bad of [{ action: 'person.confirm', value: 'x' }, { action: 'person.rename' }, { action: 'person.rename', value: 'x'.repeat(121) }, { action: 'person.ring', value: 'family' },
    { action: 'person.forget', id: 'memory:claim:3' }, { action: 'person.forget', view: 'constellation' }, { action: 'claim.forget', id: 'memory:claim:3' }, { action: 'person.forget', volume: 'low' }])
    expect(appControlActionV1Schema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
});

it('confirms only that the owner knows someone, once; renames keep the old name; forget takes the person, their claims and every name', async () => {
  await appOwner('app-people-owner-word', { PEOPLE_MAP: '1' }, async ctx => {
    const { store, priya, dana } = seed(ctx);
    const detail = async (id: number) => people(ctx, `&id=memory:person:${id}`);
    // A list revision is not a person's read.
    const listed = await people(ctx);
    expect((await act(ctx, { action: 'person.ring', id: `memory:person:${dana}`, value: 'close', revision: listed.revision })).status).toBe(409);
    expect((await act(ctx, { action: 'person.confirm', id: `memory:person:${dana}`, revision: (await detail(dana)).revision })).body).toMatchObject({ receipt: { state: 'recorded' } });
    const said = store.people.claimsOf(dana).find(claim => claim.origin === 'owner')!;
    expect(said.text).toBe('Dana is someone the owner knows');
    expect(store.people.claimsOf(dana).find(claim => claim.text === 'Dana runs the book club')).toMatchObject({ origin: 'untrusted' });
    // Confirmed once, confirm is no longer offered and a second one is refused.
    const after = await detail(dana);
    if (!('person' in after.data)) throw Error('expected a person');
    expect(after.data.person).toMatchObject({ held_as: 'yours', actions: ['person.rename', 'person.ring', 'person.forget'] });
    expect((await act(ctx, { action: 'person.confirm', id: `memory:person:${dana}`, revision: after.revision })).status).toBe(409);
    expect(store.people.claimsOf(dana).filter(claim => claim.origin === 'owner')).toHaveLength(1);
    // A rename keeps the old name, so the forget bars it too.
    await act(ctx, { action: 'person.rename', id: `memory:person:${dana}`, value: 'Dana Okoye', revision: (await detail(dana)).revision });
    expect(store.people.person(dana)).toMatchObject({ name: 'Dana Okoye', aliases: '["Dana"]' });
    expect((await act(ctx, { action: 'person.forget', id: `memory:person:${dana}`, revision: (await detail(dana)).revision })).body).toMatchObject({ receipt: { state: 'recorded', message: expect.stringContaining('Gmail') } });
    const hashes = store.barriers().map(barrier => barrier.topic_hash);
    for (const name of ['Dana Okoye', 'Dana']) expect(hashes).toContain(textFingerprint(name));
    expect(ctx.state.storage.sql.exec('SELECT * FROM entities WHERE id = ?', dana).toArray()).toEqual([]);
    expect(ctx.state.storage.sql.exec('SELECT * FROM claim_links WHERE entity_id = ?', dana).toArray()).toEqual([]);
    expect(store.people.person(priya)).toBeDefined();
    expect((await act(ctx, { action: 'person.forget', id: `memory:person:${dana}`, revision: listed.revision })).status).toBe(409);
  });
  await appOwner('app-people-act-off', {}, async ctx => {
    const { dana } = seed(ctx);
    expect((await act(ctx, { action: 'person.forget', id: `memory:person:${dana}`, revision: 'a'.repeat(64) })).status).toBe(400);
  });
});
