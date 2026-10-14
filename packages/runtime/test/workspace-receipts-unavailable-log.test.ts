import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CURATED_SKILLS } from '../src/skills/curated-owner';
import type { LLMGatewayRequest } from '../src/llm/provider';

// The workspace receipt read fails with text that must reach no sink; the turn still answers with the unavailable notice.
const LEAK = 'workspace-fault-sentinel-7f3a';
const DAY_BRIEF = CURATED_SKILLS.find(skill => skill.name === 'day-brief')!;
const wire = vi.hoisted(() => ({ workspace: 'fails' as 'fails' | 'empty', steps: 0 }));
vi.mock('../src/channels/workspace-host', async load => ({ ...await load<typeof import('../src/channels/workspace-host')>(),
  workspaceOwnerHost: async () => { if (wire.workspace === 'fails') throw new Error(LEAK); return { recentWrites: async () => [] }; } }));
vi.mock('../src/channels/owner-turn', async load => {
  const original = await load<typeof import('../src/channels/owner-turn')>();
  // Two tool rounds, so the receipt read runs twice in one turn.
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    return wire.steps++ === 0 ? done('', [{ call_id: 'load', name: 'skills_load', arguments: JSON.stringify({ name: DAY_BRIEF.name, version: DAY_BRIEF.version }) }]) : done('Done.');
  } };
  return { ...original, createOwnerResponder: (...args: Parameters<typeof original.createOwnerResponder>) => { args[10] = gateway; return original.createOwnerResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '3d4e5f60-7182-4a93-8b4c-5d6e7f8091a2';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });

beforeEach(() => {
  wire.steps = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

// Text capture on (staging), so the trace gate passes an error field through untouched: only the producer keeps it out.
const turn = (name: string) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  state.storage.kv.put('do_name', name);
  const sinks = (['log', 'warn', 'error'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
  try {
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'true' });
    const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: 'client-receipt-0001', text: 'Update the saved draft.' }) }));
    expect(sent.status).toBe(202);
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const output = sinks.flatMap(sink => sink.mock.calls.map(call => call.map(String).join(' ')));
    return {
      lines: output.filter(line => line.includes('"hop":"workspace_receipts"')).map(line => JSON.parse(line) as Record<string, unknown>),
      rows: state.storage.sql.exec<{ ok: number; note: string }>("SELECT ok, note FROM trace_log WHERE hop = 'workspace_receipts'").toArray(),
      output: output.join('\n'),
    };
  } finally { sinks.forEach(sink => sink.mockRestore()); await state.storage.deleteAlarm(); }
});

it('an app turn whose workspace receipt read fails logs one fixed code per turn and none of the error text', async () => {
  wire.workspace = 'fails';
  const result = await turn('receipts-unavailable');
  expect(wire.steps).toBe(2);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatchObject({ trace: expect.stringMatching(/^app-\d+$/), hop: 'workspace_receipts', ms: 0, ok: false, code: 'unavailable' });
  expect(result.lines[0]).not.toHaveProperty('error');
  expect(result.lines[0]).not.toHaveProperty('detail');
  expect(result.rows).toEqual([{ ok: 0, note: '' }]);
  expect(result.output).not.toContain(LEAK);
});

it('an app turn whose workspace receipt read succeeds logs no receipt failure', async () => {
  wire.workspace = 'empty';
  const result = await turn('receipts-available');
  expect(wire.steps).toBe(2);
  expect(result.lines).toEqual([]);
  expect(result.rows).toEqual([]);
});
