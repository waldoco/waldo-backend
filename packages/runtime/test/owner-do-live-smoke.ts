// Actual-model, fictional-source smoke through the real webhook and owner DO.
// Opt-in config only. No native benchmark score, real Telegram send or Google account.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { IsolatedSourceWorld } from '../scenarios/isolated-source-world';
import { matchesSmokeMailFacts } from '../scenarios/smoke-read-facts';
import { isolatedGoogleClient } from '../scenarios/isolated-google-client';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import type { OwnerDirectory } from '../src/identity/owner-directory';

const sourceFacts = { from: 'fictional-sender@example.invalid', subject: 'Fixture status', snippet: 'Cedar launch is ready for review.' };
const owner = 'smoke-a@example.invalid';
const control = 'smoke-b@example.invalid';
const world = new IsolatedSourceWorld({ clock: '2026-10-01T10:00:00Z', owners: [{ id: owner }, { id: control }],
  sources: { mail: [
    { owner_id: owner, id: 'mail-1', thread_id: 'thread-1', ...sourceFacts, at: '2026-10-01T09:30:00Z' },
    { owner_id: control, id: 'mail-1', thread_id: 'thread-1', from: 'fictional-sender@example.invalid', subject: 'Control status', snippet: 'CONTROL_ONLY_BIRCH_SECRET', at: '2026-10-01T09:30:00Z' },
  ] } });
const sends: { method: string; body: Record<string, unknown> }[] = [];
const requests: { url: string; status: number; response_id: string | null; usage: unknown }[] = [];
const denied: string[] = [];
vi.mock('../src/seams/deps', async (load) => {
  const original = await load<typeof import('../src/seams/deps')>();
  return { ...original, productionDeps: () => ({ ...original.productionDeps(), now: () => Date.parse(world.now()) }) };
});
vi.mock('../src/connectors/google', async (load) => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, tokens: { email?: string }) => {
    if (!tokens.email) throw new Error('fictional account missing');
    return isolatedGoogleClient(world, tokens.email);
  } };
});
vi.mock('../src/channels/telegram-api', async (load) => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, body: object) => {
    sends.push({ method, body: body as Record<string, unknown> });
    return method === 'getMe' ? { username: 'fixture_bot' } : true;
  } };
});
const { handleTelegramWebhook } = await import('../src/channels/telegram-webhook');
const subject = 81201;
const doName = `live-smoke-${crypto.randomUUID()}`;
const directory: OwnerDirectory = { byPresence: async (provider, id) => provider === 'telegram' && id === String(subject)
  ? { doName, subject: String(subject), timezone: 'Asia/Kolkata' } : null, redeem: async () => null };
const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName)) as DurableObjectStub<TelegramOwnerDO>;
afterEach(() => vi.unstubAllGlobals());
it('reads only fictional owner mail with an actual model, captured tool path and zero provider mutations', async () => {
  const network = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.href !== 'https://api.openai.com/v1/responses' || method !== 'POST') {
      denied.push(url.origin + url.pathname); throw new Error('unexpected smoke network destination');
    }
    // No redirects, even to another provider path. The model SDK uses maxRetries=0.
    if (requests.length >= 8) throw new Error('smoke model request cap reached');
    const response = await network(input, { ...init, redirect: 'error' });
    const body = await response.clone().json() as { id?: string; usage?: unknown };
    requests.push({ url: url.href, status: response.status, response_id: body.id ?? null, usage: body.usage ?? null });
    return response;
  }) as typeof fetch);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('google:accounts', [{ id: `local:${owner}`, email: owner, scopes: null, refresh_token: 'fictional-not-a-token' }]);
  });
  const pending: Promise<unknown>[] = [];
  const response = await handleTelegramWebhook(new Request('https://fixture.invalid/telegram/webhook', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'fictional-smoke-secret' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' },
      text: 'Read my connected inbox now. Return only one JSON object with exactly subject, from and snippet for the latest message, copying each field verbatim from the source. No markdown or other text. Do not send anything or change any state.' } }),
  }), env, (work) => pending.push(work), directory);
  await Promise.all(pending);
  expect(response.status).toBe(200);
  const traces = await runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql.exec<{ at: number; trace: string; hop: string; ok: number; model: string | null; input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null; usd: number | null }>(
      'SELECT at, trace, hop, ok, model, input_tokens, output_tokens, cached_tokens, usd FROM trace_log ORDER BY id').toArray());
  const replies = sends.filter((send) => send.method === 'sendMessage').map((send) => String(send.body.text));
  const factMatch = matchesSmokeMailFacts(replies.at(-1), sourceFacts);
  const evidence = { kind: 'actual-model-fictional-source-smoke', native_score: null, fact_oracle: { scope: 'exact fictional latest-mail extraction', matches_source: factMatch }, fixture_clock: world.now(), requests, denied,
    sends, traces, source_accesses: world.accessLog(owner), control_accesses: world.accessLog(control),
    effects: world.outbox(owner), control_effects: world.outbox(control), provider_calendar: world.providerCalendarReadback(owner) };
  // Supervisor saves stdout separately from the JSON status report. Never log credentials/headers.
  console.log('WALDO_SMOKE_EVIDENCE ' + JSON.stringify(evidence));
  expect(denied).toEqual([]);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((request) => request.status === 200)).toBe(true);
  expect(world.accessLog(owner).length).toBeGreaterThan(0);
  expect(world.accessLog(control)).toEqual([]);
  expect(world.outbox(owner)).toEqual([]); expect(world.outbox(control)).toEqual([]);
  expect(traces.some((trace) => trace.hop === 'tool_get_communication' && trace.ok === 1)).toBe(true);
  // Grade the final reply, not any interim mention. Exact extraction only; all other
  // trace/source/effect checks remain required. A pass is not broad usefulness proof.
  expect(factMatch).toBe(true);
  expect(JSON.stringify(replies)).not.toContain('CONTROL_ONLY_BIRCH_SECRET');
  expect(sends.every((send) => send.method === 'setWebhook' || Number(send.body.chat_id) === subject)).toBe(true);
});
