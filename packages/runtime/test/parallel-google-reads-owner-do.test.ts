import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMToolCall } from '@waldo/contracts';
import { FINAL_OUTBOX_KEY } from '../src/channels/telegram-final-outbox';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// Google reads one model response asks for run at once through the real owner object: its Vault-backed connector-proxy
// rail, its grant health and circuit bookkeeping, its reauth notice and its legacy-grant migration.
const READ = 'what in my inbox needs a reply, and what is on my calendar this week';
const model = vi.hoisted(() => ({ calls: [] as LLMToolCall[], requests: [] as { tool_turns?: { call: LLMToolCall; output: string }[] }[], onCalls: () => {} }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    model.requests.push(request.request as never);
    const writer = request.request.response_format !== undefined;
    const reads = !writer && !request.request.tool_turns?.length && (request.request.messages.at(-1)?.content ?? '').includes(READ);
    if (reads) model.onCalls();
    const text = request.request.response_format?.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : reads ? '' : 'Done.';
    return { ok: true as const, data: { model: request.request.model, text, ...(reads ? { tool_calls: model.calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

// The connector-proxy edge: every call waits DELAY_MS, and each connection answers ok, 401 or 429 per method.
const DELAY_MS = 200;
type Answer = 'ok' | 401 | 429;
const edge = { answers: {} as Record<string, Answer | Partial<Record<string, Answer>>>, now: 0, max: 0, calls: [] as string[], adopts: 0, adoptReady: false };
const answerFor = (connection: string, method: string): Answer => {
  const answer = edge.answers[connection] ?? 'ok';
  return typeof answer === 'object' ? answer[method] ?? 'ok' : answer;
};
const DATA: Record<string, (connection: string) => unknown> = {
  calendarPage: (connection) => ({ events: [], next_page_token: null, fetched_count: 0, account: { connection_id: connection, email: null }, observed_at: new Date().toISOString() }),
  mailPage: () => ({ messages: [], next_page_token: null, result_size_estimate: 0 }),
  threadPage: () => ({ messages: [], cursor: null }),
  searchContacts: () => [],
};
const MAIL_AND_CALENDAR = ['calendar.events', 'gmail.readonly', 'gmail.send', 'gmail.compose', 'contacts.readonly', 'contacts.other.readonly'].map(scope => `https://www.googleapis.com/auth/${scope}`);
const account = (id: string, email: string) => ({ id, email, scopes: MAIL_AND_CALENDAR });
const call = (name: string, args: Record<string, unknown>, id: string): LLMToolCall => ({ call_id: id, name, arguments: JSON.stringify(args) });

const OWNER_ID = '6b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
const google = { GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', TELEGRAM_WEBHOOK_SECRET: 'synthetic-webhook-secret', WALDO_OAUTH_STATE_SECRET: 'synthetic-state-secret' };
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
beforeEach(() => {
  model.calls = []; model.requests = []; model.onCalls = () => {};
  Object.assign(edge, { answers: {}, now: 0, max: 0, calls: [], adopts: 0, adoptReady: false });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith('/functions/v1/connector-proxy')) {
      if (asked.op === 'adopt') {
        if (!edge.adoptReady) return Response.json({ error: { status: 503, message: 'vault unavailable' } }, { status: 503 });
        edge.adopts += 1;
        await sleep(DELAY_MS);
        return Response.json({ id: 'conn-a', email: 'a@example.test', scopes: MAIL_AND_CALENDAR });
      }
      const connection = String(asked.connection), method = String(asked.method);
      edge.calls.push(`${connection}:${method}`);
      edge.now += 1; edge.max = Math.max(edge.max, edge.now);
      await sleep(DELAY_MS);
      edge.now -= 1;
      const answer = answerFor(connection, method);
      if (answer !== 'ok') return Response.json({ error: { status: answer, message: answer === 401 ? 'invalid_grant' : 'Quota exceeded' } }, { status: answer });
      return Response.json({ data: DATA[method]!(connection) });
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const traceHops = (state: DurableObjectState) => state.storage.sql.exec<{ hop: string; ok: number }>('SELECT hop, ok FROM trace_log').toArray().map(row => `${row.hop}:${row.ok}`);
// One app turn whose first model response is `calls`; resolves once the turn completed, with what the model read back.
const appTurn = async (name: string, setup: (state: DurableObjectState) => Promise<void>, check: (state: DurableObjectState, results: readonly { name: string; output: Record<string, unknown> }[]) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (pooled, state) => {
    // The pool's own instance shares this storage. Its alarm would drain the app inbox and close, as interrupted, a turn
    // only this test's instance knows is running, once the turn outlasts the inbox wake. It takes no alarm here.
    vi.spyOn(pooled as InstanceType<typeof OwnerDO>, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    await setup(state);
    const owner = new OwnerDO(state, { ...env, ...directory, ...google, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`.slice(0, 40), text: READ }) }));
      expect(sent.status).toBe(202);
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 15_000, interval: 20 });
      const answered = model.requests.find(request => request.tool_turns?.length)!;
      // The model reads each result inside the external-content frame, with any loop note after it.
      await check(state, answered.tool_turns!.map(turn => ({ name: turn.call.name, output: JSON.parse(turn.output.slice(turn.output.indexOf('{'), turn.output.lastIndexOf('}') + 1)) as Record<string, unknown> })));
    } finally { await state.storage.deleteAlarm(); }
  });
};

describe('Google reads in one response on the owner object', () => {
  it('three reads overlap at the connector-proxy and come back in call order', async () => {
    model.calls = [call('query_calendar', {}, 'c1'), call('search_communication', { query: 'invoice' }, 'c2'), call('read_thread', { thread_id: 't1' }, 'c3')];
    await appTurn('parallel-google-overlap', async (state) => {
      await state.storage.put('google:accounts', [account('conn-a', 'a@example.test')]);
    }, async (state, results) => {
      expect(edge.max).toBe(3);
      expect(edge.calls.sort()).toEqual(['conn-a:calendarPage', 'conn-a:mailPage', 'conn-a:threadPage']);
      expect(results.map(result => [result.name, result.output.ok])).toEqual([['query_calendar', true], ['search_communication', true], ['read_thread', true]]);
      expect(await state.storage.get('google:health')).toEqual({});
    });
  });

  it('a dead grant, a rate limit and a good read at once: honest results, only the dead grant is failing, one notice', async () => {
    edge.answers = { 'conn-a': 401, 'conn-b': { mailPage: 429 } };
    model.calls = [
      call('query_calendar', { account: 'a@example.test' }, 'c1'),
      call('search_communication', { account: 'b@example.test', query: 'invoice' }, 'c2'),
      call('read_thread', { account: 'b@example.test', thread_id: 't1' }, 'c3'),
    ];
    await appTurn('parallel-google-mixed', async (state) => {
      await state.storage.put('google:accounts', [account('conn-a', 'a@example.test'), account('conn-b', 'b@example.test')]);
    }, async (state, results) => {
      expect(edge.max).toBe(3);
      expect(results.map(result => [result.name, result.output.ok, result.output.code])).toEqual([
        ['query_calendar', false, 'auth_failed'], ['search_communication', false, 'transient'], ['read_thread', true, undefined],
      ]);
      expect(results[1]!.output.retryable).toBe(true);
      await vi.waitFor(() => expect(traceHops(state)).toContain('google_reauth_notice:1'), { timeout: 5_000, interval: 20 });
      expect(await state.storage.get('google:health')).toEqual({ 'conn-a': 'invalid_grant' });
      expect(Object.keys(await state.storage.get<Record<string, number>>('google:reauth-noticed') ?? {})).toEqual(['conn-a']);
      expect((state.storage.kv.get<{ id: string }[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => record.id.startsWith('google-reauth:'))).toHaveLength(1);
    });
  });

  it('two reads that fail at once on one grant notice the owner once', async () => {
    edge.answers = { 'conn-a': 401 };
    model.calls = [call('query_calendar', {}, 'c1'), call('search_communication', { query: 'invoice' }, 'c2')];
    await appTurn('parallel-google-dead-twice', async (state) => {
      await state.storage.put('google:accounts', [account('conn-a', 'a@example.test')]);
    }, async (state, results) => {
      expect(edge.max).toBe(2);
      expect(results.map(result => result.output.code)).toEqual(['auth_failed', 'auth_failed']);
      await vi.waitFor(() => expect(traceHops(state)).toContain('google_reauth_notice:1'), { timeout: 5_000, interval: 20 });
      await sleep(100);
      expect(traceHops(state).filter(hop => hop === 'google_reauth_notice:1')).toHaveLength(1);
      expect((state.storage.kv.get<{ id: string }[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => record.id.startsWith('google-reauth:'))).toHaveLength(1);
    });
  });

  // A failing grant whose probe window has passed is tried by one call only. A sibling read in the same round finds the
  // probe taken and answers from the recorded failure (reconnect needed), as a call in the circuit window does.
  it('a failing grant in its probe window is probed by exactly one of two reads at once', async () => {
    model.calls = [call('query_calendar', {}, 'c1'), call('search_communication', { query: 'invoice' }, 'c2')];
    await appTurn('parallel-google-probe', async (state) => {
      await state.storage.put('google:accounts', [account('conn-a', 'a@example.test')]);
      await state.storage.put('google:health', { 'conn-a': 'invalid_grant' });
    }, async (state, results) => {
      expect(edge.calls).toHaveLength(1);
      expect(results.filter(result => result.output.ok === true)).toHaveLength(1);
      expect(results.filter(result => result.output.code === 'auth_failed').map(result => (result.output.error as string))).toHaveLength(1);
      expect(Object.keys(await state.storage.get<Record<string, number>>('google:probes') ?? {})).toEqual(['conn-a']);
      // The probe succeeded, so the grant is healthy again.
      await vi.waitFor(async () => expect(await state.storage.get('google:health')).toEqual({}), { timeout: 5_000, interval: 20 });
    });
  });

  // search_contacts is offered without a scope check, so it reaches the migration while the legacy grant is still waiting
  // for Vault. Reads at once share one migration: the grant is adopted once.
  it('reads at once share one legacy-grant migration: Vault adopts the grant once', async () => {
    model.calls = ['ann', 'bob', 'cat'].map((query, index) => call('search_contacts', { query }, `c${index}`));
    model.onCalls = () => { edge.adoptReady = true; };
    await appTurn('parallel-google-migrate', async (state) => {
      await state.storage.put('google:tokens', { refresh_token: 'legacy-only', email: 'a@example.test', scopes: MAIL_AND_CALENDAR });
    }, async (state, results) => {
      expect(edge.adopts).toBe(1);
      expect(results.map(result => result.output.ok)).toEqual([true, true, true]);
      expect(await state.storage.get('google:tokens')).toBeUndefined();
      expect(await state.storage.get('google:accounts')).toEqual([{ id: 'conn-a', email: 'a@example.test', scopes: MAIL_AND_CALENDAR }]);
    });
  });
});
