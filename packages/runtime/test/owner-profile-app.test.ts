import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import { applyClaimOps, claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// OWNER_PROFILE=1: the owner's next app turn reads the owner profile view, setup answers and their other words grouped by
// source, with no stated health reading. Unset, the turn reads the pinned blocks as before. Synthetic owner and values.
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

const OWNER_ID = '5c1d7a40-2e9b-4f3a-8d61-0b7e4c9a2f15';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const ops = (add: unknown[]) => JSON.stringify({ add, seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });

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

const turnProfile = async (name: string, flag: string | undefined) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  const claims = claimStore(state.storage.sql);
  ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  state.storage.kv.put('app_subject', String(appSubjectFor(name)));
  for (const [i, [kind, text]] of [['preference', 'Likes plans written as a short list'], ['health', 'On 22 Oct said resting HR was 52']].entries())
    applyClaimOps(claims, ops([{ kind, text, source: 'stated', evidence: `owner, tg-${i}: "${text}"`, touches_forgotten: false }]), '2026-10-26T04:00:00.000Z', `owner, tg-${i}`, undefined, { owner: text });
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, OWNER_PROFILE: flag });
  const app = (path: string, body: unknown) => owner.fetch(new Request(`https://telegram-owner${path}`, { method: 'POST',
    headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json', 'x-waldo-app-contract': 'onboarding=2' }, body: JSON.stringify(body) }));
  try {
    expect((await app('/app/v1/onboarding/answers', { request_id: `${name}-answers`, name: 'Asha', wearable: 'samsung', rope: 'tell', protect: { picked: ['family'], own_words: '' }, spots: ['mail-chasing'] })).status).toBe(200);
    const sent = await app('/app/v1/chat/main/messages', { client_message_id: `${name}-client-01`, text: 'What should I do first today?' });
    expect(sent.status).toBe(202);
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const turn = model.requests.join('\n').replaceAll('\\"', '"').replaceAll('\\n', '\n');
    return turn.slice(turn.indexOf('<owner_profile>'), turn.indexOf('</owner_profile>'));
  } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
});

it('with OWNER_PROFILE=1 an app turn reads the profile view: setup answers, the owner\'s other words, no health reading', async () => {
  const profile = await turnProfile('owner-profile-app-on', '1');
  expect(profile).toContain('In their own words:');
  for (const fact of ['Wants to be called Asha', 'Wears a Samsung Galaxy Watch.', 'Likes plans written as a short list', 'When Waldo spots something, wants simply to be told.',
    'Never to be moved or booked over: family time.', 'Where it is hardest for them: chasing others on mail.']) expect(profile).toContain(fact);
  expect(profile).not.toContain('resting HR');
  expect(profile).toContain('1 health readings the owner stated are left out here');
});

it('unset, an app turn reads the pinned blocks as before', async () => {
  const profile = await turnProfile('owner-profile-app-off', undefined);
  expect(profile).toContain('Wants to be called Asha');
  expect(profile).not.toContain('In their own words:');
  expect(profile).not.toContain('Likes plans written as a short list');
});
