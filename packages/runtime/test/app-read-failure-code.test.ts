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
const read = (name: string, stored: Stored, path = '/app/v1/chat/main') => runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
  state.storage.kv.put('do_name', name);
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
  ['a row missing required fields', 'read-fault-invalid', { [`${PREFIX}conv:0000000000`]: { ...entry, role: undefined } }, 'history_invalid'],
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
