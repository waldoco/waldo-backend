import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { toolOutputLedger } from '../src/conversation/tool-output-ledger';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// A get_health result reaches the model in the turn that asked and nowhere else: not the ledger the next turn reads,
// not the transcript, not the object's storage. Synthetic readings only; the value is a decimal no id or time holds.
const HRV = '47.5';
const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    model.requests.push(request);
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    if (asked.includes('overnight HRV') && !request.tool_turns?.length) return done('', [{ call_id: 'hrv', name: 'get_health', arguments: JSON.stringify({ signals: ['hrv'], from: '2026-10-12', to: '2026-10-12' }) }]);
    return done('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const consentRow = (purpose: string) => ({ consent_class: 'health_processing', source: 'apple', purpose, version: 2, status: 'granted', epoch: 1, granted_at: '2026-10-01T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' });
const series = { access: 'granted', read_at: '2026-10-13T06:00:00.000Z', sources: [{ source: 'apple', consent_epoch: 1, samples: [
  { signal: 'overnight_hrv', day: '2026-10-12', start_at: '2026-10-11T21:00:00Z', end_at: '2026-10-12T03:00:00Z', timezone: 'UTC', value: Number(HRV), method: 'sdnn' },
] }] };
beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_consent_list') return Response.json({ consents: [consentRow('storage_compute'), consentRow('model_processing')] });
    if (fn === 'health_series_read') return Response.json(series);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); model.requests = []; });

const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
const storedText = (state: DurableObjectState) => {
  const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
  return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
};
const replyRequests = () => model.requests.filter(request => request.response_format === undefined);

it('the model sees the value in the asking turn; the ledger, the next turn and the object\'s storage never hold it', async () => {
  const name = 'app-get-health-turn';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const originalNow = Date.now;
    Date.now = () => Date.parse('2026-10-13T06:30:00Z');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const send = async (client: string, text: string) => {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: client, text }) }));
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    };
    try {
      await send('get-health-client-01', 'QA: what was my overnight HRV yesterday?');
      // The asking turn: the second reply request carries the tool turn with the value.
      const asking = replyRequests();
      expect(asking.length).toBeGreaterThanOrEqual(2);
      const turn = (asking.at(-1)!.tool_turns ?? [])[0]!;
      expect(turn.call.name).toBe('get_health');
      const output = JSON.parse(turn.output) as { data: { signals: { method: string; days: { value: number }[] }[] } };
      expect(output.data.signals[0]!.method).toBe('sdnn');
      expect(output.data.signals[0]!.days[0]!.value).toBe(Number(HRV));
      // The ledger holds a content-free line for the call, never the result.
      const ledger = JSON.stringify(await toolOutputLedger(state.storage).recent());
      expect(ledger).toContain('get_health');
      expect(ledger).toContain('turn_only_output');
      expect(ledger).not.toContain(HRV);
      // Nothing in the object's storage holds the value after the turn.
      expect(storedText(state)).not.toContain(HRV);
      // The next turn's requests carry no copy of it either.
      model.requests = [];
      await send('get-health-client-02', 'QA: anything else for today?');
      expect(JSON.stringify(model.requests)).not.toContain(HRV);
    } finally { Date.now = originalNow; quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
