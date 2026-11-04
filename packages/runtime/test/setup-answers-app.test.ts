import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// The answers the app's setup conversation saves reach the owner's next app turn as owner facts in the system prompt,
// without the owner sending them as a chat message: the first four in the profile with how Waldo should bring things up,
// the rest of the conversation in the facts block.
const model = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    if (request.response_format) return { ok: true as const, data: { model: request.model, text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    model.requests.push(JSON.stringify(request));
    return { ok: true as const, data: { model: request.model, text: 'Noted.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '3b7e1c52-9d4a-4e0f-a1b6-7c2d8e5f0a14';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  model.requests = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('setup answers saved from the app are owner facts in the next app turn\'s system prompt', async () => {
  const name = 'setup-answers-app-owner';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const app = (path: string, body: unknown) => owner.fetch(new Request(`https://telegram-owner${path}`, { method: 'POST',
      headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'b'.repeat(64), 'content-type': 'application/json', 'x-waldo-app-contract': 'onboarding=2' }, body: JSON.stringify(body) }));
    try {
      const saved = await app('/app/v1/onboarding/answers', { request_id: 'setup-answers-app-1', name: 'Asha',
        day: { shape: 'focus', own_words: 'Mornings are for writing' }, slips: { picked: ['promises'], own_words: '' }, wearable: 'samsung',
        matters: { picked: ['energy'], own_words: '' }, spots: ['energy-lunch'], protect: { picked: ['mornings'], own_words: '' }, rope: 'draft',
        season: { choice: 'busy', own_words: '' }, low: { picked: ['push'], own_words: '' } });
      expect([saved.status, await saved.json()]).toEqual([200, { request_id: 'setup-answers-app-1', replayed: false,
        held: { name: true, day: true, slips: true, wearable: true, matters: true, spots: true, protect: true, rope: true, season: true, low: true } }]);

      const sent = await app('/app/v1/chat/main/messages', { client_message_id: 'setup-client-01', text: 'What should I do first today?' });
      expect(sent.status).toBe(202);
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      const turn = model.requests.join('\n').replaceAll('\\"', '"');
      const profile = turn.slice(turn.indexOf('<owner_profile>'), turn.indexOf('</owner_profile>'));
      for (const fact of ['Wants to be called Asha', 'Needs long stretches of focus at work, and they are easy to break. In their own words: "Mornings are for writing"',
        "Things that tend to slip, for Waldo to watch first: things they said they'd do.", 'Wears a Samsung Galaxy Watch.',
        'When Waldo spots something, wants it ready to approve; nothing goes anywhere until they say so.']) expect(profile).toContain(fact);
      const later = ["Wants Waldo's help most with: their energy.", 'Where it is hardest for them: energy dips after lunch.', 'Never to be moved or booked over: their mornings before work.',
        'When running low: they push through anyway.'];
      const known = turn.slice(turn.indexOf('<owner_facts>'), turn.indexOf('</owner_facts>'));
      for (const fact of later) expect(known).toContain(fact);
      // The date is the day the answers were saved, which a run across midnight cannot pin in advance.
      expect(known).toMatch(/At setup on \d{4}-\d{2}-\d{2}: a busy stretch at work\./);

      // A later, ordinary turn on another subject reads them too: they are standing owner facts, not part of the first exchange.
      const before = model.requests.length;
      const next = await app('/app/v1/chat/main/messages', { client_message_id: 'setup-client-02', text: 'Can you move my Thursday call?' });
      expect(next.status).toBe(202);
      const { message_id: nextId } = await next.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${nextId}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      // The model request that carries the Thursday call, read block by block as on the first turn.
      const laterTurn = model.requests.slice(before).find(request => request.includes('Can you move my Thursday call?'))!.replaceAll('\\"', '"');
      const laterProfile = laterTurn.slice(laterTurn.indexOf('<owner_profile>'), laterTurn.indexOf('</owner_profile>'));
      const laterFacts = laterTurn.slice(laterTurn.indexOf('<owner_facts>'), laterTurn.indexOf('</owner_facts>'));
      expect(laterProfile).toContain('When Waldo spots something, wants it ready to approve; nothing goes anywhere until they say so.');
      for (const fact of later) expect(laterFacts).toContain(fact);
      expect(laterFacts).toMatch(/At setup on \d{4}-\d{2}-\d{2}: a busy stretch at work\./);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
