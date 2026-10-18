// Real owner DO admission, turn, dispatcher and workspace host on WhatsApp. Graph, the signed directory RPC and R2 are local.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceState } from '@waldo/workspace';
import { OwnerDO } from '../src/channels/owner-do';
import { WHATSAPP_PARTIAL_NOTICE } from '../src/channels/whatsapp-api';
import { TURN_TIMEOUT_MS } from '../src/channels/telegram-listener';
import { toolOutput } from './fixtures/tool-output';

type RequestBody = { input: string | { type?: string; call_id?: string; output?: string }[]; text?: { format?: { name?: string } } };
type Call = { type: 'function_call'; call_id: string; name: string; arguments: string };
const model = vi.hoisted(() => ({ requests: [] as RequestBody[], reply: undefined as undefined | ((request: RequestBody) => Call[] | string) }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const result = format ? format === 'claim_ops'
      ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
      : format === 'reaction' ? '{"reaction":"👌"}' : format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}'
      : model.reply?.(body) ?? 'Fixture reply.';
    return { id: 'fixture', output_text: typeof result === 'string' ? result : '', output: Array.isArray(result) ? result : [], usage: { input_tokens: 1, output_tokens: 1 } };
  } };
} }));

const SUBJECT = '15550001111';
const OTHER = '15550002222';
const OWNER = '10000000-0000-0000-0000-000000000001';
const writeArgs = { path: 'notes/wa.txt', text: 'Saved from WhatsApp\n', mime: 'text/plain', expected_revision: 0 };
const write: Call = { type: 'function_call', call_id: 'write', name: 'workspace_write', arguments: JSON.stringify(writeArgs) };
const outputOf = (id: string) => model.requests.flatMap(r => Array.isArray(r.input) ? r.input : [])
  .filter(item => item.type === 'function_call_output' && item.call_id === id).map(item => toolOutput<{ ok: boolean; code?: string }>(item.output!))[0];
let sequence = 0;
beforeEach(() => { model.requests = []; model.reply = request => Array.isArray(request.input) && request.input.some(item => item.type === 'function_call_output') ? 'Saved it.' : [write]; });

type Harness = { state: DurableObjectState; instance: OwnerDO; name: string; sent: { to: string; text?: string }[]; bytes: Map<string, Uint8Array>;
  admit(ids: string[], doNameHeader?: boolean): Promise<Response>; settle(): Promise<void>; manifest(): WorkspaceState | null;
  pausePut(): { reached: Promise<void>; release(): void }; restart(): OwnerDO };
async function harness(work: (h: Harness) => Promise<void>) {
  const name = `whatsapp-run-scope-${++sequence}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const bytes = new Map<string, Uint8Array>(); const sent: { to: string; text?: string }[] = [];
    let pause: { wait: Promise<void>; entered(): void } | undefined;
    const mapping = { owner_id: OWNER, environment: 'fixture', namespace: 'fixture-owner-namespace', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const fixtureEnv = { ...env, OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      WALDO_ENVIRONMENT: mapping.environment, WALDO_OWNER_DO_NAMESPACE: mapping.namespace,
      SUPABASE_PROJECT_URL: 'https://signed-metadata.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret',
      ARTIFACTS: {
        put: async (key: string, value: Uint8Array) => { if (pause) { const slot = pause; pause = undefined; slot.entered(); await slot.wait; } bytes.set(key, value.slice()); return null; },
        get: async (key: string) => { const value = bytes.get(key); return value ? { arrayBuffer: async () => value.slice().buffer } : null; },
        delete: async (key: string) => { bytes.delete(key); },
      } as unknown as R2Bucket,
    };
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://graph.facebook.com/v21.0/fictional-phone-id/messages') {
        const body = JSON.parse(String(init?.body)) as { to: string; text?: { body?: string } };
        sent.push({ to: body.to, ...(body.text?.body === undefined ? {} : { text: body.text.body }) });
        return Response.json({ messages: [{ id: `wamid.out.${sent.length}` }] });
      }
      if (url === `${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/workspace_owner_binding`) return Response.json({ ...mapping });
      if (url.startsWith(`${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/`)) return Response.json(url.endsWith('health_log_recent') ? [] : url.endsWith('assert_channel_presence') ? true : null);
      throw new Error(`local fixture denies unexpected network: ${url}`);
    });
    let instance = new OwnerDO(state, fixtureEnv);
    const settle = async () => { await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]); };
    const admit = (ids: string[], doNameHeader = true) => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
      method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT, ...(doNameHeader ? { 'x-waldo-do-name': name } : {}) },
      body: JSON.stringify({ messages: ids.map(id => ({ from: SUBJECT, id, type: 'text', text: { body: 'Save a note to my workspace.' } })) }),
    }));
    const manifest = () => {
      if (!state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_manifest'").toArray().length) return null;
      const row = state.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM workspace_manifest WHERE singleton=1').toArray()[0];
      return row ? JSON.parse(row.state_json) as WorkspaceState : null;
    };
    const pausePut = () => {
      let release!: () => void; let entered!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const reached = new Promise<void>(resolve => { entered = resolve; });
      pause = { wait, entered };
      return { reached, release };
    };
    try { await work({ state, instance, name, sent, bytes, admit, settle, manifest, pausePut, restart: () => (instance = new OwnerDO(state, fixtureEnv)) }); }
    finally { await state.storage.deleteAlarm(); network.mockRestore(); }
  });
}

it.each([['bound through the WhatsApp admission', false], ['already bound by another surface', true]] as const)('a WhatsApp turn writes a workspace file when the owner name is %s', async (_label, prebound) => {
  await harness(async h => {
    if (prebound) h.state.storage.kv.put('do_name', h.name);
    expect((await h.admit(['wamid.write.1'], !prebound)).status).toBe(200);
    await h.settle();
    expect(h.state.storage.kv.get('do_name')).toBe(h.name);
    expect(outputOf('write')).toMatchObject({ ok: true });
    expect(h.manifest()?.files.map(file => file.path)).toEqual(['notes/wa.txt']);
    expect(new TextDecoder().decode([...h.bytes.values()][0])).toBe(writeArgs.text);
    expect(h.sent.map(s => s.to)).toContain(SUBJECT);
    expect(h.sent.some(s => s.text === WHATSAPP_PARTIAL_NOTICE)).toBe(false);
  });
});

it('the WhatsApp admission refuses an owner name that is not this object, and one that differs from the bound name', async () => {
  await harness(async h => {
    const foreign = await h.instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
      method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT, 'x-waldo-do-name': `${h.name}-foreign` }, body: JSON.stringify({ messages: [] }) }));
    expect(foreign.status).toBe(403);
    expect(h.state.storage.kv.get('do_name')).toBeUndefined();
    expect(h.state.storage.kv.get('whatsapp_subject')).toBeUndefined();
    h.state.storage.kv.put('do_name', `${h.name}-other`);
    expect((await h.admit([])).status).toBe(403);
    expect(h.state.storage.kv.get('do_name')).toBe(`${h.name}-other`);
  });
});

// The sender is still the bound, linked subject only when the owner name changes, so only that case is told.
it.each([
  ['the sender is rebound', (state: DurableObjectState) => state.storage.kv.put('whatsapp_subject', OTHER), 0],
  ['the sender is unlinked', (state: DurableObjectState) => state.storage.kv.put('whatsapp_unlinked', true), 0],
  ['the binding is removed', (state: DurableObjectState) => state.storage.kv.delete('whatsapp_subject'), 0],
  ['the owner name changes', (state: DurableObjectState) => state.storage.kv.put('do_name', 'another-owner'), 1],
] as const)('a running WhatsApp turn cannot publish a workspace revision after %s', async (_label, change, notices) => {
  await harness(async h => {
    const paused = h.pausePut();
    expect((await h.admit(['wamid.fence.1'])).status).toBe(200);
    await paused.reached;
    change(h.state);
    paused.release();
    await h.settle();
    expect(h.manifest()?.files ?? []).toEqual([]);
    expect(h.sent.filter(s => s.to === OTHER)).toEqual([]);
    expect(h.sent.filter(s => s.text === WHATSAPP_PARTIAL_NOTICE)).toEqual(Array(notices).fill({ to: SUBJECT, text: WHATSAPP_PARTIAL_NOTICE }));
    expect(h.sent.filter(s => s.text === 'Saved it.')).toEqual([]);
    expect([...h.state.storage.kv.list({ prefix: 'wa_pending:' })]).toEqual([]);
  });
});

it.each([
  ['past its deadline', (h: Harness, release: () => Promise<void>) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TURN_TIMEOUT_MS);
    return release().finally(() => clock.mockRestore());
  }],
  ['stopped', (h: Harness, release: () => Promise<void>) => {
    (h.instance as unknown as { activeAbort?: AbortController }).activeAbort!.abort();
    return release();
  }],
] as const)('a WhatsApp turn %s cannot publish, and the owner gets the one fixed notice', async (_label, close) => {
  await harness(async h => {
    const paused = h.pausePut();
    expect((await h.admit(['wamid.late.1'])).status).toBe(200);
    await paused.reached;
    await close(h, async () => { paused.release(); await h.settle(); });
    expect(h.manifest()?.files ?? []).toEqual([]);
    expect(h.sent.filter(s => s.text === WHATSAPP_PARTIAL_NOTICE)).toEqual([{ to: SUBJECT, text: WHATSAPP_PARTIAL_NOTICE }]);
    expect(h.sent.filter(s => s.text === 'Saved it.')).toEqual([]);
  });
});

it('a WhatsApp turn cut off by eviction yields one notice and is never replayed', async () => {
  await harness(async h => {
    const paused = h.pausePut();
    expect((await h.admit(['wamid.evict.1'])).status).toBe(200);
    await paused.reached;
    const pending = [...h.state.storage.kv.list({ prefix: 'wa_pending:' })].map(([, record]) => record);
    expect(pending).toEqual([{ subject: SUBJECT, admittedAt: expect.any(Number), ids: ['wamid.evict.1'] }]);
    // A cold instance owns none of the live runs: the first one's record is now an evicted run's.
    const warm = h.instance;
    const cold = h.restart();
    const turns = vi.spyOn(cold as unknown as { turn(): Promise<void> }, 'turn');
    await cold.alarm();
    expect(h.sent.filter(s => s.text === WHATSAPP_PARTIAL_NOTICE)).toEqual([{ to: SUBJECT, text: WHATSAPP_PARTIAL_NOTICE }]);
    expect([...h.state.storage.kv.list({ prefix: 'wa_pending:' })]).toEqual([]);
    expect((await h.admit(['wamid.evict.1'])).status).toBe(200);
    await h.settle();
    expect(turns).not.toHaveBeenCalled();
    // The cut-off run resumes on the old instance: it is fenced, and recovery's notice stays the only one.
    paused.release();
    await Promise.all([...(warm as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
    expect(h.manifest()?.files ?? []).toEqual([]);
    expect(h.sent.filter(s => s.text === WHATSAPP_PARTIAL_NOTICE)).toHaveLength(1);
    expect(h.sent.filter(s => s.text === 'Saved it.')).toEqual([]);
  });
});
