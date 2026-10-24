import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const { OwnerDO } = await import('../src/channels/owner-do');

// Controls revision 2 on the app: a claim shows its pin, and the owner pins, unpins and edits it. Revision 1 reads the
// same bytes it always did and cannot act on a claim.
const OWNER_ID = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const HASH = 'b'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { revoked: false };

beforeEach(() => {
  wire.revoked = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json(wire.revoked ? null : { owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_list') return Response.json([{ session: HASH, created_at: new Date(Date.now() - 60_000).toISOString(), last_seen_at: new Date().toISOString() }]);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response> }>;
type Row = { id: number; text: string; status: string; origin: string | null; source: string; verification_status: string | null; source_ref: string | null; supersedes_id: number | null; pinned: string | null };
type Ctx = Readonly<{ owner: Owner; state: DurableObjectState; name: string }>;

const appOwner = async (name: string, check: (ctx: Ctx) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
    await owner.setup('app').ready;
    try { await check({ owner, state, name }); } finally { await state.storage.deleteAlarm(); }
  });
};
const seed = ({ state }: Ctx, kind: string, text: string) => {
  state.storage.sql.exec("INSERT INTO claims (kind, text, source, evidence, origin, status, created_at, last_seen_at, seen_count, source_ref, verification_status) VALUES (?, ?, 'stated', 'synthetic note', 'owner', 'active', '2026-10-01', '2026-10-01', 1, 'owner, app:1', 'owner-grounded')", kind, text);
  return state.storage.sql.exec<{ id: number }>('SELECT id FROM claims ORDER BY id DESC LIMIT 1').one().id;
};
const rows = ({ state }: Ctx) => state.storage.sql.exec<Row>('SELECT * FROM claims ORDER BY id').toArray();
const headers = (name: string, contract?: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, ...(contract ? { 'x-waldo-app-contract': contract } : {}) });
const read = ({ owner, name }: Ctx, query: string, contract?: string) => owner.fetch(new Request(`https://telegram-owner/app/v1/controls?view=constellation&${query}`, { headers: headers(name, contract) }));
const detail = async (ctx: Ctx, id: number) => {
  const response = await read(ctx, `memory_view=detail&id=memory:claim:${id}`, 'controls=2');
  expect(response.status).toBe(200);
  const body = appControlProjectionV1Schema.parse(await response.json());
  if (body.view !== 'constellation' || body.data.memory_view !== 'detail' || body.data.kind !== 'claim') throw Error('expected a claim detail');
  return { revision: body.revision, item: body.data.item };
};
const act = async (ctx: Ctx, fields: Record<string, string>, contract = 'controls=2') => {
  const response = await ctx.owner.fetch(new Request('https://telegram-owner/app/v1/actions', { method: 'POST', headers: { ...headers(ctx.name, contract), 'content-type': 'application/json' },
    body: JSON.stringify({ view: 'constellation', request_id: `claim-${crypto.randomUUID()}`, ...fields }) }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

it('revision 1 reads the same bytes whether or not a claim is pinned, and revision 2 shows the pin', async () => {
  await appOwner('app-claim-read', async ctx => {
    const id = seed(ctx, 'fact', 'Lives in Leeds');
    seed(ctx, 'routine', 'Walks after lunch');
    const bytes = async (query: string, contract?: string) => (await read(ctx, query, contract)).text();
    const queries = ['memory_view=claims&limit=10', `memory_view=detail&id=memory:claim:${id}`];
    const before = await Promise.all(queries.map(query => bytes(query)));
    ctx.state.storage.sql.exec("UPDATE claims SET pinned = 'profile', pin_order = 0 WHERE id = ?", id);
    for (const [index, query] of queries.entries()) {
      expect(await bytes(query)).toBe(before[index]);
      expect(await bytes(query, 'controls=1')).toBe(before[index]);
      expect(await bytes(query)).not.toContain('pinned');
    }
    const listed = appControlProjectionV1Schema.parse(await (await read(ctx, 'memory_view=claims&limit=10', 'controls=2')).json());
    if (listed.view !== 'constellation' || listed.data.memory_view !== 'claims') throw Error('expected claims');
    expect(listed.data.items.map(item => [item.text, item.pinned])).toEqual([['Lives in Leeds', 'profile'], ['Walks after lunch', null]]);
  });
});

it('pins to the block the owner picks and unpins, each on the revision of that claim\'s read', async () => {
  await appOwner('app-claim-pin', async ctx => {
    const id = seed(ctx, 'preference', 'Prefers mornings');
    const pinned = await act(ctx, { action: 'claim.pin', id: `memory:claim:${id}`, value: 'facts', revision: (await detail(ctx, id)).revision });
    expect(pinned).toMatchObject({ status: 200, body: { receipt: { state: 'recorded' } } });
    expect((await detail(ctx, id)).item.pinned).toBe('facts');
    const unpinned = await act(ctx, { action: 'claim.unpin', id: `memory:claim:${id}`, revision: (await detail(ctx, id)).revision });
    expect(unpinned.status).toBe(200);
    expect((await detail(ctx, id)).item.pinned).toBeNull();
  });
});

it('a pin from the app makes a claim Waldo inferred the owner\'s own word', async () => {
  await appOwner('app-claim-pin-ground', async ctx => {
    ctx.state.storage.sql.exec("INSERT INTO claims (kind, text, source, evidence, origin, status, created_at, last_seen_at, seen_count, verification_status) VALUES ('goal', 'Run a half marathon', 'inferred', 'synthetic note', 'agent', 'active', '2026-10-01', '2026-10-01', 1, 'provisional')");
    const id = ctx.state.storage.sql.exec<{ id: number }>('SELECT id FROM claims ORDER BY id DESC LIMIT 1').one().id;
    const pinned = await act(ctx, { action: 'claim.pin', id: `memory:claim:${id}`, value: 'profile', revision: (await detail(ctx, id)).revision });
    expect(pinned.status).toBe(200);
    expect(rows(ctx)[0]).toMatchObject({ pinned: 'profile', origin: 'owner', verification_status: 'owner-grounded', source: 'confirmed' });
  });
});

it('edits a claim in the owner\'s words: the old row is superseded and the new one names the app', async () => {
  await appOwner('app-claim-edit', async ctx => {
    const id = seed(ctx, 'fact', 'Works at Acme');
    const edited = await act(ctx, { action: 'claim.edit', id: `memory:claim:${id}`, value: '  Works at Globex  ', revision: (await detail(ctx, id)).revision });
    expect(edited).toMatchObject({ status: 200, body: { receipt: { state: 'recorded' } } });
    const [old, next] = rows(ctx);
    expect(old).toMatchObject({ id, status: 'superseded' });
    expect(next).toMatchObject({ text: 'Works at Globex', status: 'active', origin: 'owner', source: 'stated', verification_status: 'owner-grounded', source_ref: 'owner, app:claim.edit', supersedes_id: id });
  });
});

it('refuses a claim action from a revision 1 client, on a stale read, for a kind the blocks do not carry, and with a credential', async () => {
  await appOwner('app-claim-refusals', async ctx => {
    const id = seed(ctx, 'fact', 'Has two cats');
    const event = seed(ctx, 'event', 'Dentist on Tuesday');
    const { revision } = await detail(ctx, id);
    expect((await act(ctx, { action: 'claim.pin', id: `memory:claim:${id}`, value: 'profile', revision }, '')).status).toBe(400);
    expect((await act(ctx, { action: 'claim.pin', id: `memory:claim:${id}`, value: 'profile', revision }, 'controls=1')).status).toBe(400);
    ctx.state.storage.sql.exec("UPDATE claims SET pinned = 'facts', pin_order = 0 WHERE id = ?", id);
    expect(await act(ctx, { action: 'claim.unpin', id: `memory:claim:${id}`, revision })).toMatchObject({ status: 409, body: { error: 'stale_read' } });
    expect((await act(ctx, { action: 'claim.pin', id: `memory:claim:${event}`, value: 'profile', revision: (await detail(ctx, event)).revision })).status).toBe(409);
    expect((await act(ctx, { action: 'claim.edit', id: `memory:claim:${event}`, value: 'Key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij', revision: (await detail(ctx, event)).revision })).status).toBe(409);
    expect(rows(ctx).map(row => [row.text, row.status, row.pinned])).toEqual([['Has two cats', 'active', 'facts'], ['Dentist on Tuesday', 'active', null]]);
  });
});

it('a revoked app session changes nothing', async () => {
  await appOwner('app-claim-revoked', async ctx => {
    const id = seed(ctx, 'fact', 'Drives a blue car');
    const { revision } = await detail(ctx, id);
    wire.revoked = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = await act(ctx, { action: 'claim.edit', id: `memory:claim:${id}`, value: 'Drives a red car', revision });
    expect(refused.status).not.toBe(200);
    expect(rows(ctx).map(row => row.text)).toEqual(['Drives a blue car']);
  });
});
