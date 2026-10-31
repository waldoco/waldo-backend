import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { WORKERS_AI_BGE_M3_EMBEDDING_MODEL } from '@waldo/contracts';
import { modelCost } from '../src/llm/pricing';
import { COST_MONTH_KEY, COST_ROLLUP_KEY, type CostRollupRow } from '../src/observability/cost-rollup';
import { estimatedTokens, semanticRecall, workersAiEmbedder } from '../src/memory/semantic-recall';
import { ensureSchema } from '../src/tracer/schema';
import { fakeEmbeddings } from '../src/testing/fake-embeddings';

// An app turn carries a run scope, so the owner object builds a nested responder for it. With the flag on and Workers AI
// bound, that turn's recall must still carry the meaning leg: a question that shares no word with a claim recalls it.
// Synthetic fixtures only.
const OWNER_ID = '3b8e2f4a-7c1d-4e9a-b6f0-2d5c8a1e7f39';
const BASE = 'https://directory.fixture.invalid';
const DENTIST = 'Dr Rao does the teeth cleaning, at the clinic on 4th Cross';

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const format = request.request.response_format?.name;
    const answer = (text: string) => ({ ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (format === 'task_source_scope') return answer('{"decision":"retain","sources":[]}');
    if (format !== undefined) return answer('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    return answer('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => {
    args[11] = gateway;
    return original.createTelegramResponder(...args);
  } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); model.requests = []; });

const directory = () => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const raw = init?.body ? String(init.body) : '';
  const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
  const args = raw ? JSON.parse(raw) as Record<string, string> : {};
  if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
  if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
  if (fn === 'assert_channel_presence') return Response.json(true);
  if (fn === 'health_context_read') return Response.json(null);
  return new Response('unexpected', { status: 500 });
});

const appTurn = async (name: string, extra: Readonly<Record<string, string>> = {}) => {
  let ai = fakeEmbeddings();
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const sql = state.storage.sql, transaction = <T>(work: () => T) => state.storage.transactionSync(work);
    const memory = claimStore(sql, transaction);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    memory.add({ kind: 'fact', text: 'Gym locker has a blue door', evidence: 'gym', source: 'stated', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-26T08:00:00Z');
    memory.add({ kind: 'fact', text: DENTIST, evidence: 'teeth', source: 'stated', origin: 'owner', source_ref: 'owner, tg-2' }, '2026-10-26T08:00:00Z');
    // Only the gym claim is pinned, so the dentist claim can reach the model by recall alone.
    expect(memory.pin(1, 'facts', 1)).toBe(true);
    ai = fakeEmbeddings();
    await semanticRecall({ sql, transaction, embedder: workersAiEmbedder(ai) }).sync();
    const owner = new OwnerDO(state, { ...env, MEMORY_SEMANTIC_RECALL: '1', AI: ai, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...extra });
    const sent = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: 'client-dentist', text: 'When is my dentist appointment?' }) }));
    expect(sent.status, await sent.clone().text()).toBe(202);
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const reply = model.requests.find(request => request.response_format === undefined && JSON.stringify(request.messages).includes('When is my dentist appointment'));
    expect(reply, 'the reply call reached the model').toBeDefined();
    expect(JSON.stringify(reply!.messages)).toContain('Dr Rao does the teeth cleaning');
    expect(ai.inputs).toContain('When is my dentist appointment?');
  });
  return ai;
};

it('an app turn, which runs on a run scope, recalls a claim by meaning when the flag is on', async () => {
  directory();
  await appTurn('semantic-recall-owner-do-app');
});

it('prices the turn\'s embedding call into the cost ledger and the month the spend ceiling reads', async () => {
  directory();
  const name = 'semantic-recall-owner-do-cost';
  await appTurn(name, { WALDO_COST_LEDGER_SYNC: 'on' });
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const pending = state.storage.kv.get<{ open: CostRollupRow[]; sending?: { rows: CostRollupRow[] } }>(COST_ROLLUP_KEY);
    const rows = [...pending?.open ?? [], ...pending?.sending?.rows ?? []].filter((row) => row.model === WORKERS_AI_BGE_M3_EMBEDDING_MODEL);
    const query = modelCost({ model: WORKERS_AI_BGE_M3_EMBEDDING_MODEL, input: estimatedTokens(['When is my dentist appointment?']), output: 0, cached: 0 })!.total;
    expect(rows).toEqual([expect.objectContaining({ kind: 'turn', calls: 1, input: estimatedTokens(['When is my dentist appointment?']), usd: query })]);
    expect(state.storage.kv.get<{ usd: number }>(COST_MONTH_KEY)!.usd).toBeGreaterThanOrEqual(query);
  });
});
