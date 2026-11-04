import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// "Plan tomorrow around my energy, given my calendar": the turn reads the owner's own readings and his calendar. The
// calendar is outside content, so the readings are withheld from the model for the rest of that turn and the turn
// still answers. Synthetic readings only; the value has one decimal so no timestamp the turn writes can hold it.
const HRV = '67.4';
const EVENT = 'Quarterly board call';
const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], order: 'together' as 'together' | 'calendar_first' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    model.requests.push(request);
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}');
    const asked = String(request.messages.at(-1)?.content ?? '').split('\n\n[memory recalled for this message')[0]!;
    if (!asked.includes('Plan tomorrow around my energy')) return done('Noted.');
    const health = { call_id: 'health-1', name: 'get_health', arguments: JSON.stringify({ signals: ['hrv'], from: '2026-10-12', to: '2026-10-12' }) };
    const calendar = { call_id: 'calendar-1', name: 'query_calendar', arguments: JSON.stringify({ date_range: { from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z' } }) };
    const rounds = request.tool_turns?.length ?? 0;
    if (model.order === 'together') return rounds === 0 ? done('', [health, calendar]) : done('Light morning, board call at nine.');
    return rounds === 0 ? done('', [calendar]) : rounds === 1 ? done('', [health]) : done('Light morning, board call at nine.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: { connection_id: string | null; email: string | null }) => ({
    account, events: async () => [],
    calendarPage: async () => ({ events: [{ id: 'event-1', title: EVENT, start: '2026-10-14T09:00:00Z', end: '2026-10-14T10:00:00Z', all_day: false }], next_page_token: null, fetched_count: 1, account, observed_at: '2026-10-13T06:30:00Z' }),
  }) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const google = { GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_OAUTH_STATE_SECRET: 'synthetic-state-secret' };
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
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_consent_list') return Response.json({ consents: [consentRow('storage_compute'), consentRow('model_processing')] });
    if (fn === 'health_series_read') return Response.json(series);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); model.requests = []; model.order = 'together'; });

const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
const replyRequests = () => model.requests.filter(request => request.response_format === undefined);

for (const order of ['together', 'calendar_first'] as const) {
  it(`a plan that reads the calendar and the owner's readings (${order}) finishes, and the model never sees a reading after the calendar`, async () => {
    const name = `health-plan-external-${order}`;
    model.order = order;
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
      claimStore(state.storage.sql); ensureSchema(state.storage);
      state.storage.kv.put('do_name', name);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      vi.setSystemTime('2026-10-13T06:30:00Z');
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const owner = new OwnerDO(state, { ...env, ...directory, ...google, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
      try {
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: `plan-${order}-client-01`, text: 'Plan tomorrow around my energy: what should I do when, given my calendar?' }) }));
        const { message_id: id } = await sent.json() as { message_id: string };
        const settled = () => state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state;
        await vi.waitFor(() => expect(['completed', 'interrupted']).toContain(settled()), { timeout: 10_000, interval: 20 });
        expect(settled()).toBe('completed');
        const last = replyRequests().at(-1)!;
        const turns = last.tool_turns ?? [];
        expect(turns.map(turn => turn.call.name).sort()).toEqual(['get_health', 'query_calendar']);
        expect(turns.find(turn => turn.call.name === 'query_calendar')!.output).toContain(EVENT);
        expect(turns.find(turn => turn.call.name === 'get_health')!.output).toContain('hidden because outside content was read');
        expect(JSON.stringify(last)).not.toContain(HRV);
      } finally { vi.useRealTimers(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
    });
  });
}
