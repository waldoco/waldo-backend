import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { CURATED_SKILLS, CuratedOwnerSkills, seededSkillCustody } from '../src/skills/curated-owner';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { persistInboxWake } from '../src/scheduler/alarm-slot';

// An app turn runs the same reviewed skill book as a Telegram turn: the catalog is in the system prompt, skills_load
// works, and the owner's lifecycle state (one custody key) is shared across surfaces.
const DAY_BRIEF = CURATED_SKILLS.find(skill => skill.name === 'day-brief')!;
const CATALOG_LINE = 'Reviewed skill catalog (metadata only)';
const REPLY = 'Prepared with the day brief.';
const model = vi.hoisted(() => ({ systems: [] as string[], tools: [] as string[][], step: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  // Scripted model: the first reply loads day-brief; the second answers. Memory and other structured calls get empty JSON.
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    model.systems.push(request.system ?? '');
    model.tools.push((request.tools ?? []).map(tool => tool.name));
    return model.step++ === 0 ? done('', [{ call_id: 'load', name: 'skills_load', arguments: JSON.stringify({ name: DAY_BRIEF.name, version: DAY_BRIEF.version }) }]) : done(REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
// The Telegram test below sends through the bot API; nothing leaves the fixture.
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string) => method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: 1 } : true }));
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7c2e9a14-3b5d-4f60-8a71-92b3c4d5e6f7';
const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const TELEGRAM_CUSTODY = 'telegram:42';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  model.systems = []; model.tools = []; model.step = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = InstanceType<typeof OwnerDO>;
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
const withOwner = <T>(name: string, seed: (state: DurableObjectState) => void, work: (owner: Owner, state: DurableObjectState) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    seed(state);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try { return await work(owner, state); } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
const send = async (owner: Owner, state: DurableObjectState, name: string, text: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: 'client-skill-0001', text }) }));
  expect(sent.status).toBe(202);
  const { message_id: id } = await sent.json() as { message_id: string };
  const settled = () => state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state;
  await vi.waitFor(() => expect(['completed', 'interrupted']).toContain(settled()), { timeout: 10_000, interval: 20 });
  return settled();
};
const shownReplies = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }));
  expect(response.status).toBe(200);
  return (await response.json() as { messages: readonly { role: string; text: string }[] }).messages.filter(message => message.role === 'assistant').map(message => message.text);
};
const custodies = (state: DurableObjectState) => [...new Set(state.storage.sql.exec<{ created_by: string }>('SELECT created_by FROM skills').toArray().map(row => row.created_by.slice(row.created_by.indexOf(':owner:') + ':owner:'.length)))];
// Seeds the book the way a Telegram turn does today, under the chat-id custody key.
const telegramBook = (state: DurableObjectState) => new CuratedOwnerSkills(state.storage.sql, PRINCIPAL, undefined, TELEGRAM_CUSTODY);

it('an app-first owner gets the reviewed catalog in the prompt and can load a skill, keyed by the owner principal', async () => {
  const name = 'app-skills-first';
  await withOwner(name, () => undefined, async (owner, state) => {
    expect(await send(owner, state, name, 'What does my day look like?')).toBe('completed');
    expect(model.systems).toHaveLength(2);
    expect(model.systems[0]).toContain(CATALOG_LINE);
    expect(model.systems[0]).not.toContain(DAY_BRIEF.body_markdown);
    expect(model.systems[1]).toContain(DAY_BRIEF.body_markdown);
    expect((await shownReplies(owner, name)).at(-1)).toContain(REPLY);
    expect(custodies(state)).toEqual([PRINCIPAL]);
    expect(seededSkillCustody(state.storage.sql)).toBe(PRINCIPAL);
  });
});

// The catalog is one line per reviewed skill, exact enough for skills_load; skills_list keeps the full metadata.
it('the catalog names every reviewed skill by its exact version and purpose, and skills_load is a callable tool', async () => {
  const name = 'app-skills-catalog-lines';
  await withOwner(name, () => undefined, async (owner, state) => {
    expect(await send(owner, state, name, 'What does my day look like?')).toBe('completed');
    const system = model.systems[0]!;
    for (const skill of CURATED_SKILLS) expect(system).toContain(`\n- ${skill.name}@${skill.version}: ${skill.trigger_condition}\n`.slice(0, -1));
    expect(system).not.toContain('conservative_utf8_byte_upper_bound');
    expect(system).not.toContain('Tools available in this chat');
    expect(model.tools[0]).toEqual(expect.arrayContaining(['skills_load', 'skills_list']));
  });
});

it('a Telegram-first owner keeps the same skill book on the app: no second custody, the skill still loads', async () => {
  const name = 'app-skills-after-telegram';
  await withOwner(name, state => { telegramBook(state); }, async (owner, state) => {
    expect(custodies(state)).toEqual([TELEGRAM_CUSTODY]);
    expect(await send(owner, state, name, 'What does my day look like?')).toBe('completed');
    expect(model.systems[0]).toContain(CATALOG_LINE);
    expect(model.systems[1]).toContain(DAY_BRIEF.body_markdown);
    expect(custodies(state)).toEqual([TELEGRAM_CUSTODY]);
    expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM skills').toArray()[0]?.n).toBe(CURATED_SKILLS.length);
  });
});

it('a skill the owner disabled on Telegram stays disabled on the app', async () => {
  const name = 'app-skills-disabled';
  await withOwner(name, state => {
    const turn = { owner: PRINCIPAL, turnId: 'tg-1', trigger: 'user_message' as const, ownerText: `/skills disable ${DAY_BRIEF.name}`, assertCurrent: async () => undefined };
    expect(telegramBook(state).disable(DAY_BRIEF.name, DAY_BRIEF.version, turn).ok).toBe(true);
  }, async (owner, state) => {
    expect(await send(owner, state, name, 'What does my day look like?')).toBe('completed');
    expect(model.systems[0]).toContain(CATALOG_LINE);
    expect(model.systems[1]).not.toContain(DAY_BRIEF.body_markdown);
    expect(custodies(state)).toEqual([TELEGRAM_CUSTODY]);
    expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM skills WHERE name=?', DAY_BRIEF.name).toArray()[0]?.status).toBe('archived');
  });
});

it('no reviewed rows yet means no seeded custody', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('app-skills-empty')), async (_instance, state) => {
    expect(seededSkillCustody(state.storage.sql)).toBeUndefined();
  });
});

it('an app-first owner keeps the principal key when Telegram links later: no second custody, the skill loads on Telegram', async () => {
  const name = 'telegram-after-app-skills';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    // The app seeded the book under the owner principal; then the owner linked Telegram chat 42.
    new CuratedOwnerSkills(state.storage.sql, PRINCIPAL);
    expect(custodies(state)).toEqual([PRINCIPAL]);
    await state.storage.put({ telegram_subject: '42', do_name: name });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7.fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    const update = 910001;
    try {
      await inbox.admit({ bot: '7.fixture', subject: '42', doName: name }, update, JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text: 'What does my day look like?' } }));
      await (owner as unknown as { drainInbox(): Promise<void> }).drainInbox();
      expect((await inbox.records()).find(row => row.updateId === update)?.state).toBe('awaiting_delivery');
      expect(model.systems[0]).toContain(CATALOG_LINE);
      expect(model.systems[1]).toContain(DAY_BRIEF.body_markdown);
      expect(custodies(state)).toEqual([PRINCIPAL]);
      expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM skills').toArray()[0]?.n).toBe(CURATED_SKILLS.length);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('rows the book would not admit never vote on the custody: foreign names, an over-long source, a provisional row', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('skills-custody-vote')), async (_instance, state) => {
    const sql = state.storage.sql;
    telegramBook(state);
    expect(seededSkillCustody(sql)).toBe(TELEGRAM_CUSTODY);
    // More system rows than the catalog has, under another custody, but with names outside the catalog.
    const junk = Array.from({ length: CURATED_SKILLS.length + 1 }, (_, i) => ({ ...DAY_BRIEF, name: `junk-${i}` }));
    new CuratedOwnerSkills(sql, PRINCIPAL, undefined, 'evil', junk);
    expect(custodies(state)).toEqual(expect.arrayContaining([TELEGRAM_CUSTODY, 'evil']));
    expect(seededSkillCustody(sql)).toBe(TELEGRAM_CUSTODY);
    // A catalog row whose source is over the 256-byte bound, and one marked provisional, carry a third custody.
    sql.exec('UPDATE skills SET created_by=? WHERE name=?', `reviewed-builtin:${DAY_BRIEF.name}@${DAY_BRIEF.version}:owner:${'x'.repeat(300)}`, DAY_BRIEF.name);
    sql.exec('UPDATE skills SET provisional=1, created_by=? WHERE name=?', `reviewed-builtin:${CURATED_SKILLS[1]!.name}@${CURATED_SKILLS[1]!.version}:owner:prov`, CURATED_SKILLS[1]!.name);
    expect(seededSkillCustody(sql)).toBe(TELEGRAM_CUSTODY);
    // Only the catalog's own admitted rows count: with them all gone, no custody is seeded.
    sql.exec('DELETE FROM skills WHERE created_by LIKE ?', `%:owner:${TELEGRAM_CUSTODY}`);
    expect(seededSkillCustody(sql)).toBeUndefined();
  });
});
