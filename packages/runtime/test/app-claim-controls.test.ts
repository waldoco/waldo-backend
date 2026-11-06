import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { claimStore, profileClaims, turnMemoryPrompt, withoutBringUpLess } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const { OwnerDO } = await import('../src/channels/owner-do');

// Controls revision 15 on the app: the constellation is the page of what Waldo knows. A claim says who said it and where it
// came from, and the owner confirms, forgets, dismisses or asks Waldo to bring it up less. Older builds read what they did.
const OWNER_ID = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const HASH = 'b'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { revoked: false, signedInAgo: 60_000 };

beforeEach(() => {
  wire.revoked = false;
  wire.signedInAgo = 60_000;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json(wire.revoked ? null : { owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_inventory') { const signedIn = new Date(Date.now() - wire.signedInAgo).toISOString(); return Response.json([{ session: HASH, created_at: signedIn, last_seen_at: new Date().toISOString(), expires_at: new Date(Date.parse(signedIn) + 30 * 24 * 3_600_000).toISOString(), rotated_to: null, signed_in_at: signedIn }]); }
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response> }>;
type Ctx = Readonly<{ owner: Owner; state: DurableObjectState; name: string }>;

const appOwner = async (name: string, check: (ctx: Ctx) => Promise<void>, on = true) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', ...(on ? { MEMORY_CLAIM_CONTROLS: '1' } : {}), OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
    await owner.setup('app').ready;
    try { await check({ owner, state, name }); } finally { await state.storage.deleteAlarm(); }
  });
};

type Row = { id: number; text: string; status: string; origin: string | null; source: string; verification_status: string | null; source_ref: string | null; supersedes_id: number | null; pinned: string | null; bring_up_less_at: string | null };
const insert = ({ state }: Ctx, text: string, fields: { source: string; origin: string; verification?: string } = { source: 'stated', origin: 'owner' }) => {
  state.storage.sql.exec("INSERT INTO claims (kind, text, source, evidence, origin, status, created_at, last_seen_at, seen_count, source_ref, verification_status) VALUES ('fact', ?, ?, 'synthetic note', ?, 'active', '2026-10-01', '2026-10-01', 1, ?, ?)", text, fields.source, fields.origin, fields.origin === 'owner' ? 'owner, chat' : null, fields.verification ?? (fields.origin === 'owner' ? 'owner-grounded' : 'provisional'));
  return state.storage.sql.exec<{ id: number }>('SELECT id FROM claims ORDER BY id DESC LIMIT 1').one().id;
};
const claimRows = ({ state }: Ctx) => state.storage.sql.exec<Row>('SELECT * FROM claims ORDER BY id').toArray();
const headers = (name: string, contract?: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, ...(contract ? { 'x-waldo-app-contract': contract } : {}) });
const read = ({ owner, name }: Ctx, query: string, contract?: string) => owner.fetch(new Request(`https://telegram-owner/app/v1/controls?view=constellation&${query}`, { headers: headers(name, contract) }));
const detail = async (ctx: Ctx, id: number, contract = 'controls=15') => {
  const response = await read(ctx, `memory_view=detail&id=memory:claim:${id}`, contract);
  expect(response.status).toBe(200);
  const body = appControlProjectionV1Schema.parse(await response.json());
  if (body.view !== 'constellation' || body.data.memory_view !== 'detail' || body.data.kind !== 'claim') throw Error('expected a claim detail');
  return { revision: body.revision, item: body.data.item };
};
const act = async (ctx: Ctx, fields: Record<string, string>, contract = 'controls=15') => {
  const response = await ctx.owner.fetch(new Request('https://telegram-owner/app/v1/actions', { method: 'POST', headers: { ...headers(ctx.name, contract), 'content-type': 'application/json' },
    body: JSON.stringify({ view: 'constellation', request_id: `claim-${crypto.randomUUID()}`, ...fields }) }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const send = async (ctx: Ctx, action: string, id: number, contract = 'controls=15') => act(ctx, { action, id: `memory:claim:${id}`, revision: (await detail(ctx, id, contract)).revision }, contract);

it('shows who said each claim, where a kept look-up claim came from, and what can be sent, only to revision 15', async () => {
  await appOwner('app-claim-fields', async ctx => {
    const said = insert(ctx, 'Lives in Leeds');
    const guess = insert(ctx, 'Probably prefers mornings', { source: 'inferred', origin: 'agent' });
    const kept = insert(ctx, 'Product manager at Acme');
    ctx.state.storage.sql.exec("INSERT INTO owner_findings (id, category, text, evidence, source_url, source_title, state, claim_id, found_at, decided_at) VALUES ('fnd_1', 'work', 'Product manager at Acme', 'q', 'https://samrivera.dev/about', 't', 'kept', ?, 1, 2)", kept);
    expect((await detail(ctx, said)).item).toMatchObject({ held_as: 'owner_said', bring_up: 'normal', source_url: null });
    expect((await detail(ctx, said)).item.actions).toEqual(expect.arrayContaining(['claim.forget', 'claim.dismiss', 'claim.quiet']));
    expect((await detail(ctx, said)).item.actions).not.toContain('claim.confirm');
    expect((await detail(ctx, guess)).item).toMatchObject({ held_as: 'waldo_thinks' });
    expect((await detail(ctx, guess)).item.actions).toContain('claim.confirm');
    expect((await detail(ctx, kept)).item).toMatchObject({ source_url: 'https://samrivera.dev/about' });
    for (const contract of ['controls=14', 'controls=2']) expect(await (await read(ctx, `memory_view=detail&id=memory:claim:${said}`, contract)).text()).not.toMatch(/held_as|bring_up|source_url|"actions"/);
  });
});

it('serves none of it, and refuses the actions, while the switch is off', async () => {
  await appOwner('app-claim-switch-off', async ctx => {
    const id = insert(ctx, 'Probably prefers mornings', { source: 'inferred', origin: 'agent' });
    expect(await (await read(ctx, `memory_view=detail&id=memory:claim:${id}`, 'controls=15')).text()).not.toMatch(/held_as|bring_up|"actions"/);
    expect((await send(ctx, 'claim.confirm', id)).status).toBe(400);
    expect(claimRows(ctx)[0]).toMatchObject({ source: 'inferred' });
  }, false);
});

it('refuses the new actions to a build below revision 15', async () => {
  await appOwner('app-claim-rev14', async ctx => {
    const id = insert(ctx, 'Lives in Leeds');
    for (const action of ['claim.forget', 'claim.dismiss', 'claim.quiet', 'claim.confirm']) expect((await send(ctx, action, id, 'controls=14')).status).toBe(400);
    expect(claimRows(ctx)[0]).toMatchObject({ status: 'active', bring_up_less_at: null });
  });
});

it('confirms a claim Waldo inferred as the owner\'s word, but not one the owner already said, and keeps its provenance', async () => {
  await appOwner('app-claim-confirm', async ctx => {
    const guess = insert(ctx, 'Probably prefers mornings', { source: 'inferred', origin: 'agent' });
    const said = insert(ctx, 'Lives in Leeds');
    expect((await send(ctx, 'claim.confirm', said)).status).toBe(409);
    expect(await send(ctx, 'claim.confirm', guess)).toMatchObject({ status: 200, body: { receipt: { state: 'recorded' } } });
    expect(claimRows(ctx).find(row => row.id === guess)).toMatchObject({ origin: 'owner', source: 'confirmed', verification_status: 'owner-grounded', source_ref: 'owner, app:claim.confirm' });
    expect((await detail(ctx, guess)).item.held_as).toBe('owner_said');
  });
});

it('forgets a claim: it leaves the constellation and the next turn\'s memory, and a node id cannot be forgotten as a claim', async () => {
  await appOwner('app-claim-forget', async ctx => {
    const id = insert(ctx, 'Allergic to cobalt-11 resin');
    insert(ctx, 'Lives in Leeds');
    const before = await detail(ctx, id);
    expect(turnMemoryPrompt(claimStore(ctx.state.storage.sql), '')).toContain('cobalt-11');
    expect(await act(ctx, { action: 'claim.forget', id: `memory:claim:${id}`, revision: before.revision })).toMatchObject({ status: 200 });
    const listed = appControlProjectionV1Schema.parse(await (await read(ctx, 'memory_view=claims&limit=10', 'controls=15')).json());
    if (listed.view !== 'constellation' || listed.data.memory_view !== 'claims') throw Error('expected claims');
    expect(listed.data.items.map(item => item.text)).toEqual(['Lives in Leeds']);
    expect(turnMemoryPrompt(claimStore(ctx.state.storage.sql), '')).not.toContain('cobalt-11');
    expect(claimRows(ctx).some(row => row.text.includes('cobalt-11') && row.status === 'active')).toBe(false);
    const node = await ctx.owner.fetch(new Request('https://telegram-owner/app/v1/actions', { method: 'POST', headers: { ...headers(ctx.name, 'controls=15'), 'content-type': 'application/json' },
      body: JSON.stringify({ view: 'constellation', request_id: 'claim-node-0001', action: 'claim.forget', id: 'memory:node:1', revision: 'a'.repeat(64) }) }));
    expect(node.status).toBe(400);
  });
});

it('refuses a stale read, and dismisses a claim so Waldo stops using it', async () => {
  await appOwner('app-claim-dismiss', async ctx => {
    const id = insert(ctx, 'Lives in Leeds');
    expect(await act(ctx, { action: 'claim.dismiss', id: `memory:claim:${id}`, revision: 'f'.repeat(64) })).toMatchObject({ status: 409 });
    expect(claimRows(ctx)[0]!.status).toBe('active');
    expect((await send(ctx, 'claim.dismiss', id)).status).toBe(200);
    expect(claimRows(ctx)[0]!.status).toBe('dismissed');
  });
});

it('brings a claim up less without deleting it: marked for the owner\'s turns, hidden from unprompted ones, and undone by unquiet', async () => {
  await appOwner('app-claim-quiet', async ctx => {
    const id = insert(ctx, 'Has a sore knee from running');
    expect((await send(ctx, 'claim.quiet', id)).status).toBe(200);
    const store = claimStore(ctx.state.storage.sql);
    expect(claimRows(ctx)[0]).toMatchObject({ status: 'active' });
    expect(claimRows(ctx)[0]!.bring_up_less_at).not.toBeNull();
    expect(turnMemoryPrompt(store, '')).toMatch(/sore knee/);
    expect(turnMemoryPrompt(store, '')).toContain('bring up less');
    expect(turnMemoryPrompt(withoutBringUpLess(store), '')).not.toContain('sore knee');
    expect(withoutBringUpLess(store).recall('knee', 5)).toEqual([]);
    expect((await detail(ctx, id)).item).toMatchObject({ bring_up: 'less' });
    expect((await detail(ctx, id)).item.actions).toContain('claim.unquiet');
    expect((await send(ctx, 'claim.quiet', id)).status).toBe(409);
    expect((await send(ctx, 'claim.unquiet', id)).status).toBe(200);
    expect(claimRows(ctx)[0]!.bring_up_less_at).toBeNull();
  });
});

it('the wish to hear less follows a claim into its corrected wording', async () => {
  await appOwner('app-claim-quiet-corrected', async ctx => {
    const id = insert(ctx, 'Has a sore knee from running');
    await send(ctx, 'claim.quiet', id);
    expect((await act(ctx, { action: 'claim.edit', id: `memory:claim:${id}`, value: 'Has a sore left knee from running', revision: (await detail(ctx, id)).revision })).status).toBe(200);
    expect(claimRows(ctx).filter(row => row.status === 'active')).toMatchObject([{ text: 'Has a sore left knee from running' }]);
    expect(claimRows(ctx).find(row => row.status === 'active')!.bring_up_less_at).not.toBeNull();
  });
});

it('forgets a promoted claim the same way: it leaves the constellation, the pinned block and the next turn, whatever its pin', async () => {
  await appOwner('app-claim-forget-promoted', async ctx => {
    const id = insert(ctx, 'Allergic to cobalt-11 resin');
    insert(ctx, 'Lives in Leeds');
    ctx.state.storage.sql.exec("UPDATE claims SET status = 'promoted', pinned = 'facts', pin_order = 0 WHERE id = ?", id);
    const before = await detail(ctx, id);
    expect(before.item.actions).toContain('claim.forget');
    expect(turnMemoryPrompt(claimStore(ctx.state.storage.sql), '')).toContain('cobalt-11');
    expect(await act(ctx, { action: 'claim.forget', id: `memory:claim:${id}`, revision: before.revision })).toMatchObject({ status: 200 });
    expect(claimRows(ctx).some(row => row.text.includes('cobalt-11') && (row.status === 'active' || row.status === 'promoted'))).toBe(false);
    expect(turnMemoryPrompt(claimStore(ctx.state.storage.sql), '')).not.toContain('cobalt-11');
    expect(profileClaims(claimStore(ctx.state.storage.sql)).map(row => row.text)).not.toContain('Allergic to cobalt-11 resin');
  });
});

it('offers confirm on every claim Waldo only thinks, whoever wrote it, and the owner\'s yes makes it theirs', async () => {
  await appOwner('app-claim-confirm-untrusted', async ctx => {
    const web = insert(ctx, 'Speaks at Acme Summit', { source: 'stated', origin: 'untrusted' });
    const shared = insert(ctx, 'Has a sister in Pune', { source: 'stated', origin: 'shared' });
    for (const id of [web, shared]) {
      const shown = (await detail(ctx, id)).item;
      expect(shown.held_as).toBe('waldo_thinks');
      expect(shown.actions).toContain('claim.confirm');
    }
    expect(await send(ctx, 'claim.confirm', web)).toMatchObject({ status: 200 });
    expect(claimRows(ctx).find(row => row.id === web)).toMatchObject({ origin: 'owner', verification_status: 'owner-grounded' });
    const after = (await detail(ctx, web)).item;
    expect(after.held_as).toBe('owner_said');
    expect(after.actions).not.toContain('claim.confirm');
  });
});

it('shows a kept finding with a page address over the cap as having none, rather than failing the read', async () => {
  await appOwner('app-claim-long-url', async ctx => {
    const id = insert(ctx, 'Product manager at Acme');
    ctx.state.storage.sql.exec("INSERT INTO owner_findings (id, category, text, evidence, source_url, source_title, state, claim_id, found_at, decided_at) VALUES ('fnd_long', 'work', 'Product manager at Acme', 'q', ?, 't', 'kept', ?, 1, 2)", `https://samrivera.dev/${'a'.repeat(2100)}`, id);
    expect((await detail(ctx, id)).item).toMatchObject({ source_url: null });
    const listed = await read(ctx, 'memory_view=claims&limit=10', 'controls=15');
    expect(listed.status).toBe(200);
  });
});
