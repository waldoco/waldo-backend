import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';

const OWNER_ID = '5b3c4d5e-6f70-4a8b-9cad-1e2f3a4b5c6d';
const ownerHex = OWNER_ID.replaceAll('-', '');
const PREFIX = `canonical-owner-v1:prn_${ownerHex}:ten_${ownerHex}:`;
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { sessions: 'listed' as 'listed' | 'outage', authorityReads: 0, authorityLimit: Infinity };

beforeEach(() => {
  wire.sessions = 'listed'; wire.authorityReads = 0; wire.authorityLimit = Infinity;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority' && ++wire.authorityReads > wire.authorityLimit) throw new Error('directory unavailable');
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_list') { if (wire.sessions === 'outage') throw new Error('directory unavailable'); return Response.json([]); }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const entry = { id: 'stored-reply-1', ownerId: `prn_${ownerHex}`, chatId: 'main', parentId: null, threadAnchorId: null, surface: 'app', modelPayload: 'Stored reply.', appPayload: 'Stored reply.', modelProjection: { mode: 'include' }, role: 'assistant' };
type Stored = Readonly<Record<string, unknown>>;
// Reads the app route once and returns its status with the failure lines it logged.
const read = (name: string, stored: Stored, path = '/app/v1/chat/main', before: (state: DurableObjectState) => void = () => undefined) => runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
  state.storage.kv.put('do_name', name);
  before(state);
  for (const [key, value] of Object.entries(stored)) state.storage.kv.put(key, value);
  const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: undefined });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const response = await owner.fetch(new Request(`https://telegram-owner${path}`, { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
    const lines = logged.mock.calls.map(([line]) => String(line)).filter(line => line.includes('"hop":"app_'));
    return { status: response.status, body: await response.json(), failures: lines.map(line => JSON.parse(line) as Record<string, unknown>), raw: lines.join('\n') };
  } finally { logged.mockRestore(); }
});

it.each([
  ['a row with no witness', 'read-fault-witness', { [`${PREFIX}conv:0000000000`]: entry }, 'history_witness'],
  ['a leaf that names no row', 'read-fault-leaf', { [`${PREFIX}leaf`]: 'missing-row' }, 'history_leaf'],
  ['a row for another owner', 'read-fault-owner', { [`${PREFIX}conv:0000000000`]: { ...entry, ownerId: 'prn_someone_else' } }, 'history_owner'],
] as const)('a main-chat read that fails on %s still answers a generic 503 and logs one fixed failure code with no ids or text', async (_case, name, stored, code) => {
  const result = await read(name, stored);
  expect(result.status).toBe(503);
  expect(result.body).toEqual({ error: 'unavailable' });
  expect(result.failures).toEqual([{ hop: 'app_history_read', ok: false, code }]);
  expect(result.raw).not.toContain(name);
  expect(result.raw).not.toContain('Stored reply');
  expect(result.raw).not.toContain(ownerHex);
});

it.each(['constructor', 'toString', '__proto__'])('a history error whose message is the object key %s still logs the plain history step', async message => {
  const result = await read(`read-fault-proto-${message.replaceAll('_', '')}`, {}, '/app/v1/chat/main', state => {
    const list = state.storage.list.bind(state.storage);
    vi.spyOn(state.storage, 'list').mockImplementation((async (options?: DurableObjectListOptions) => {
      if (options?.prefix?.startsWith('canonical-owner-v1:')) throw new Error(message);
      return list(options);
    }) as typeof state.storage.list);
  });
  expect(result.status).toBe(503);
  expect(result.failures).toEqual([{ hop: 'app_history_read', ok: false, code: 'history' }]);
});

it('a main-chat read whose owner context fails after routing logs the context step', async () => {
  wire.authorityLimit = 1;
  const result = await read('read-fault-context', {});
  expect(result.status).toBe(503);
  expect(result.failures).toEqual([{ hop: 'app_history_read', ok: false, code: 'context' }]);
});

it('a controls read whose session list fails logs a fixed failure code too', async () => {
  wire.sessions = 'outage';
  const result = await read('read-fault-controls', {}, '/app/v1/controls?view=day');
  expect(result.status).toBe(503);
  expect(result.body).toEqual({ error: 'unavailable' });
  expect(result.failures).toEqual([{ hop: 'app_controls_read', ok: false, code: 'sessions' }]);
  expect(result.raw).not.toContain('read-fault-controls');
});

const witnessed = (row: Record<string, unknown>) => ({ [`${PREFIX}conv:${String(witnessed.n).padStart(10, '0')}`]: row, [`${PREFIX}witness:${row.id}`]: { lineage: 'canonical_v1', principal_ref: `prn_${ownerHex}`, tenant_ref: `ten_${ownerHex}`, entry: row }, [`${PREFIX}count`]: ++witnessed.n });
witnessed.n = 0;

it('a stored row that matches its witness but fails the entry shape is left out of the main-chat history, which still answers, and the log names the failed check', async () => {
  witnessed.n = 0;
  const good = { ...entry, id: 'stored-reply-good' }, bad = { ...entry, id: 'stored-reply-bad', parentId: 'stored-reply-good', role: undefined };
  const result = await read('read-skip-invalid', { ...witnessed(good), ...witnessed(bad), [`${PREFIX}leaf`]: bad.id });
  expect(result.status).toBe(200);
  expect((result.body as { messages: { id: string }[] }).messages.map(message => message.id)).toEqual(['stored-reply-good']);
  expect(result.failures).toEqual([{ hop: 'app_history_read', ok: true, code: 'history_rows_skipped', check: 'role', count: 1, unwitnessed: 0 }]);
  expect(result.raw).not.toContain('stored-reply');
  expect(result.raw).not.toContain(ownerHex);
});

it('a stored row whose witness does not match still fails the whole main-chat read', async () => {
  witnessed.n = 0;
  const rows = witnessed({ ...entry, role: undefined });
  rows[`${PREFIX}witness:${entry.id}`] = { lineage: 'canonical_v1', principal_ref: `prn_${ownerHex}`, tenant_ref: `ten_${ownerHex}`, entry: { ...entry, appPayload: 'different' } };
  const result = await read('read-skip-witness', rows);
  expect(result.status).toBe(503);
  expect(result.failures).toEqual([{ hop: 'app_history_read', ok: false, code: 'history_witness' }]);
});

it('a stored row with no witness that fails the entry shape, with its key left out entirely, is left out too and counted as unwitnessed', async () => {
  witnessed.n = 0;
  const { role: _role, ...noRole } = { ...entry, id: 'stored-reply-orphan' };
  const result = await read('read-skip-unwitnessed', { ...witnessed({ ...entry, id: 'stored-reply-good' }), [`${PREFIX}conv:0000000009`]: noRole, [`${PREFIX}leaf`]: 'stored-reply-orphan' });
  expect(result.status).toBe(200);
  expect((result.body as { messages: { id: string }[] }).messages.map(message => message.id)).toEqual(['stored-reply-good']);
  expect(result.failures).toEqual([{ hop: 'app_history_read', ok: true, code: 'history_rows_skipped', check: 'role', count: 1, unwitnessed: 1 }]);
});

it('a row that passes the entry shape but has no witness still fails the main-chat read', async () => {
  const result = await read('read-valid-unwitnessed', { [`${PREFIX}conv:0000000000`]: entry });
  expect(result.status).toBe(503);
  expect(result.failures).toEqual([{ hop: 'app_history_read', ok: false, code: 'history_witness' }]);
});

it('a shape-invalid row between two good rows is left out, and the later good row still shows with its stored parent', async () => {
  witnessed.n = 0;
  const first = { ...entry, id: 'stored-reply-first' }, middle = { ...entry, id: 'stored-reply-middle', parentId: first.id, role: undefined }, last = { ...entry, id: 'stored-reply-last', parentId: middle.id };
  const result = await read('read-skip-middle', { ...witnessed(first), ...witnessed(middle), ...witnessed(last), [`${PREFIX}leaf`]: last.id });
  expect(result.status).toBe(200);
  expect((result.body as { messages: { id: string; parent_id: string | null }[] }).messages.map(({ id, parent_id }) => ({ id, parent_id }))).toEqual([{ id: last.id, parent_id: middle.id }, { id: first.id, parent_id: null }]);
  expect(result.failures).toEqual([{ hop: 'app_history_read', ok: true, code: 'history_rows_skipped', check: 'role', count: 1, unwitnessed: 0 }]);
});
