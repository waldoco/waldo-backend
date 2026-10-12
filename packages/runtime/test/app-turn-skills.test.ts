import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { CURATED_SKILLS, CuratedOwnerSkills } from '../src/skills/curated-owner';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const REPLY = 'Here is your prep for the 3pm.';
// A line only the reviewed meeting-prep procedure carries.
const PROCEDURE_LINE = 'Similar names are not interchangeable.';
const MEETING_PREP = CURATED_SKILLS.find(skill => skill.name === 'meeting-prep')!;
const model = vi.hoisted(() => ({ requests: [] as { tools: string[]; sent: string; turns: number }[], results: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const format = request.request.response_format?.name;
    const sent = JSON.stringify(request.request);
    if (format === 'claim_ops') return { ok: true, data: { model: request.request.model, text: JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null }), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    if (format) return { ok: true, data: { model: request.request.model, text: format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    const turns = request.request.tool_turns ?? [];
    model.requests.push({ tools: (request.request.tools ?? []).map(tool => tool.name), sent, turns: turns.length });
    for (const turn of turns) if (turn.call.name === 'skills_load') model.results.push(turn.output);
    if (!turns.length) return { ok: true, data: { model: request.request.model, text: '', tool_calls: [{ call_id: 'load-prep', name: 'skills_load', arguments: JSON.stringify({ name: 'meeting-prep', version: MEETING_PREP.version }) }], input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    return { ok: true, data: { model: request.request.model, text: REPLY, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '6c4d5e6f-7081-4a9b-8c0d-2e3f4a5b6c7d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { telegramSent: 0 };

beforeEach(() => {
  model.requests = []; model.results = []; wire.telegramSent = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'assert_channel_presence') return Response.json(false);
    if (url.startsWith('https://api.telegram.org/')) { wire.telegramSent += 1; return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } }); }
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const OWN_PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const OTHER_PRINCIPAL = 'prn_7d5e6f708192abacbdcedfe0f1a2b3c4';

// Telegram stamps skill activations with its verified subject; the app keeps that custody for a DO holding its own
// stored Telegram binding, and uses the owner's verified principal otherwise. Activations of anyone else never load.
it.each([
  ['a fresh app-only DO', null, null, true],
  ['activations stamped by this DO\'s own Telegram binding', '424242', 'telegram:424242', true],
  ['activations stamped by another Telegram subject', '424242', 'telegram:999', false],
  ['activations stamped by another principal', null, OTHER_PRINCIPAL, false],
] as const)('an app turn is offered the reviewed skills and loads meeting-prep only from its own custody: %s', async (_case, telegramSubject, seededCustody, loads) => {
  const name = `app-turn-skills-${telegramSubject ?? 'none'}-${seededCustody ?? 'fresh'}`;
  const headers = { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' };
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    if (telegramSubject) state.storage.kv.put('telegram_subject', telegramSubject);
    if (seededCustody) new CuratedOwnerSkills(state.storage.sql, 'earlier-owner', undefined, seededCustody);
    const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers, body: JSON.stringify({ client_message_id: 'client-prep-0001', text: 'Prep me for my 3pm.' }) }));
      expect(sent.status).toBe(202);
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      const [first, second] = model.requests;
      expect(first?.tools).toEqual(expect.arrayContaining(['skills_list', 'skills_load']));
      expect(first?.sent).toContain('meeting-prep');
      expect(first?.sent).not.toContain(PROCEDURE_LINE);
      expect(model.results).toHaveLength(1);
      expect(model.results[0]).toContain(loads ? '"ok":true' : '"ok":false');
      if (loads) expect(second?.sent).toContain(PROCEDURE_LINE);
      else expect(second?.sent).not.toContain(PROCEDURE_LINE);
      expect(state.storage.sql.exec<{ created_by: string }>("SELECT created_by FROM skills WHERE name = 'meeting-prep'").one().created_by)
        .toMatch(new RegExp(`:owner:${seededCustody ?? OWN_PRINCIPAL}$`));
      const page = await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers }))).json() as { messages: { role: string; text: string }[] };
      expect(page.messages.map(({ role, text }) => ({ role, text })).reverse()).toEqual([{ role: 'user', text: 'Prep me for my 3pm.' }, { role: 'assistant', text: REPLY }]);
    } finally { await state.storage.deleteAlarm(); }
  });
  expect(wire.telegramSent).toBe(0);
});
