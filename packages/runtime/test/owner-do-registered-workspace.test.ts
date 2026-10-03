// Actual deployed constructor, authenticated inbox and alarm, dispatcher, workspace host,
// SQLite manifest and R2-shaped byte fixture. No private owner host or live provider exists.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import type { WorkspaceState } from '@waldo/workspace';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { routerSignature } from '../src/identity/owner-directory';
import * as dispatcher from '../src/tools/dispatcher';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { handleConsole } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';

type InputItem = { type?: string; call_id?: string; name?: string; output?: string };
type RequestBody = { tools?: { name: string }[]; input: string | InputItem[]; text?: { format?: { name?: string } }; instructions?: string };
type Call = { type: 'function_call'; call_id: string; name: string; arguments: string };
type Result = { ok: boolean; data?: any; source_taint?: string; error?: string; code?: string; reason?: string };
const model = vi.hoisted(() => ({ requests: [] as RequestBody[], reply: undefined as undefined | ((request: RequestBody) => Promise<Call[] | string> | Call[] | string), telegram: [] as { method: string; body: any }[] }));
vi.mock('../src/channels/telegram-api', async load => ({
  ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, body: unknown) => { model.telegram.push({ method, body }); return method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: 1 } : true; },
}));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const result = format ? format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : format === 'claim_ops'
      ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
      : format === 'reaction' ? '{"reaction":"👌"}' : 'Local structured fixture.'
      : await model.reply?.(body) ?? 'Workspace fixture reply.';
    return { id: 'fixture', output_text: typeof result === 'string' ? result : '', output: Array.isArray(result) ? result : [], usage: { input_tokens: 1, output_tokens: 1 } };
  } };
} }));
const OWNER = '10000000-0000-0000-0000-000000000001';
const OTHER = '10000000-0000-0000-0000-000000000002';
const BYTES = 'Exact owner workspace bytes\nहैलो 🌿\n';
const writeArgs = { path: 'notes/fixture.txt', text: BYTES, mime: 'text/plain', expected_revision: 0 };
const call = (name: string, args: unknown, id = name): Call => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const outputs = (request: RequestBody): Record<string, Result> => Object.fromEntries((Array.isArray(request.input) ? request.input : []).filter(item => item.type === 'function_call_output').map(item => [item.call_id!, JSON.parse(item.output!)]));
const allOutputs = (): Record<string, Result> => Object.assign({}, ...model.requests.filter(request => !request.text?.format).map(outputs));
const replies = () => model.requests.filter(request => !request.text?.format);
const deferred = () => {
  let release!: () => void; let entered!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  return { wait, reached, release, entered };
};
let sequence = 940000;
beforeEach(() => { model.requests = []; model.reply = undefined; model.telegram = []; });

async function proof(work: (h: {
  state: DurableObjectState; name: string; bytes: Map<string, Uint8Array>; puts: string[]; gets: string[]; rpc: string[];
  enqueue(text: string, id?: number, subject?: string, doName?: string): Promise<{ response: Response; id: number }>;
  send(text: string, id?: number): Promise<number>; alarm(): Promise<void>; restart(): void; manifest(): WorkspaceState | null; request(request: Request): Promise<Response>;
  mapping: { owner_id: string; environment: string; namespace: string; do_name: string; do_id: string; state_version: number; mapping_version: number };
  absent(): void; unlinked(): void; pauseMapping(afterReservation?: boolean): ReturnType<typeof deferred>; pausePut(): ReturnType<typeof deferred>;
  onPut(fn: () => void): void; dispatches: MockInstance<typeof dispatcher.dispatchTool>;
}) => Promise<void>) {
  const name = `registered-workspace-${++sequence}`;
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const mapping = { owner_id: OWNER, environment: 'fixture', namespace: 'fixture-owner-namespace', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const bytes = new Map<string, Uint8Array>(); const puts: string[] = []; const gets: string[] = []; const rpc: string[] = []; const unexpected: string[] = []; const pauses: ReturnType<typeof deferred>[] = [];
    let pauseAfterReservation = false; let missing = false; let mappingPause: ReturnType<typeof deferred> | undefined; let putPause: ReturnType<typeof deferred> | undefined; let afterPut: (() => void) | undefined;
    const fixtureEnv = { ...env, WALDO_ENVIRONMENT: mapping.environment, WALDO_OWNER_DO_NAMESPACE: mapping.namespace,
      TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'fictional-inbox-secret', OPENAI_API_KEY: 'fictional-model-key',
      SUPABASE_PROJECT_URL: 'https://signed-metadata.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret',
      ARTIFACTS: {
        put: async (key: string, value: Uint8Array) => { puts.push(key); bytes.set(key, value.slice()); if (putPause) { const slot = putPause; putPause = undefined; slot.entered(); await slot.wait; } afterPut?.(); return null; },
        get: async (key: string) => { gets.push(key); const value = bytes.get(key); return value ? { arrayBuffer: async () => value.slice().buffer } : null; },
        delete: async (key: string) => { bytes.delete(key); },
      } as unknown as R2Bucket,
    };
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input); const prefix = `${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/`;
      if (!url.startsWith(prefix) || init?.method !== 'POST') { unexpected.push(url); throw new Error(`local fixture denies unexpected network: ${url}`); }
      const fn = url.slice(prefix.length); rpc.push(fn);
      const args = JSON.parse(String(init.body)) as Record<string, any>;
      expect(new Headers(init.headers).get('apikey')).toBe('fictional-publishable');
      expect(new Headers(init.headers).get('content-profile')).toBe('waldo');
      let message: string;
      switch (fn) {
        case 'workspace_owner_binding': {
          expect([args.p_environment, args.p_namespace, args.p_do_name, args.p_do_id]).toEqual([mapping.environment, mapping.namespace, name, state.id.toString()]);
          const locator = JSON.stringify([mapping.environment, mapping.namespace, name, state.id.toString()]);
          expect(args.p_locator).toBe(locator);
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(locator)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          message = `workspace.bind.${hash}`; break;
        }
        case 'assert_channel_presence':
          expect([args.p_do_name, args.p_provider, args.p_subject]).toEqual([name, 'telegram', '81101']);
          message = `presence.${name}.telegram.81101`; break;
        case 'health_context_read': expect(args.p_do_name).toBe(name); message = `healthctx.read.${name}`; break;
        case 'health_log_recent': expect(args.p_do_name).toBe(name); message = `health.recent.${name}.${args.p_limit}`; break;
        default: unexpected.push(url); throw new Error(`local fixture denies unexpected signed RPC: ${fn}`);
      }
      expect(args.p_sig).toBe(await routerSignature(fixtureEnv.WALDO_ROUTER_HMAC_SECRET, args.p_at, message));
      if (fn === 'workspace_owner_binding') {
        if (mappingPause && dispatches.mock.calls.some(([call]) => call.name === 'workspace_write') && (!pauseAfterReservation || manifest()?.operations.some(operation => operation.status === 'pending'))) { const slot = mappingPause; mappingPause = undefined; slot.entered(); await slot.wait; }
        return missing ? new Response('missing', { status: 404 }) : Response.json({ ...mapping });
      }
      return Response.json(fn === 'assert_channel_presence' ? true : fn === 'health_log_recent' ? [] : null);
    });
    const dispatches = vi.spyOn(dispatcher, 'dispatchTool'); // Observes original dispatcher, including losing async continuations.
    let instance = new TelegramOwnerDO(state, fixtureEnv);
    const enqueue = async (text: string, id = ++sequence, subject = '81101', doName = name) => ({ id, response: await instance.fetch(new Request('https://local.invalid/enqueue', {
      method: 'POST', headers: { 'x-waldo-inbox-secret': fixtureEnv.TELEGRAM_WEBHOOK_SECRET, 'x-waldo-telegram-subject': subject, 'x-waldo-do-name': doName },
      body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: Number(subject), is_bot: false }, chat: { id: Number(subject), type: 'private' }, text } }),
    })) });
    const send = async (text: string, id?: number) => {
      const admitted = await enqueue(text, id); expect(admitted.response.status).toBe(200);
      for (let i = 0; i < 3; i++) {
        await instance.alarm();
        const row = state.storage.kv.get<{ updateId: number; closedAt?: number }[]>('telegram_owner_inbox_v1')?.find(row => row.updateId === admitted.id);
        if (row?.closedAt !== undefined) return admitted.id;
      }
      throw new Error('authenticated fixture update did not close within three real alarms');
    };
    const manifest = () => {
      const exists = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_manifest'").toArray().length;
      if (!exists) return null;
      const row = state.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM workspace_manifest WHERE singleton=1').toArray()[0];
      return row ? JSON.parse(row.state_json) as WorkspaceState : null;
    };
    try { await work({ state, name, bytes, puts, gets, rpc, enqueue, send, alarm: () => instance.alarm(), request: request => instance.fetch(request), restart: () => { instance = new TelegramOwnerDO(state, fixtureEnv); }, manifest, mapping,
      absent: () => { missing = true; }, unlinked: () => { state.storage.kv.put('telegram_unlinked', true); },
      pauseMapping: (afterReservation = false) => { pauseAfterReservation = afterReservation; mappingPause = deferred(); pauses.push(mappingPause); return mappingPause; }, pausePut: () => { putPause = deferred(); pauses.push(putPause); return putPause; }, onPut: fn => { afterPut = fn; }, dispatches });
    } finally { for (const pause of pauses) pause.release(); await state.storage.deleteAlarm(); localFetch.mockRestore(); dispatches.mockRestore(); }
    expect(unexpected).toEqual([]);
  });
}

it('default two-argument owner turn advertises, creates, retries, lists and reads exact durable workspace bytes across restart', async () => {
  await proof(async h => {
    model.reply = request => {
      const done = outputs(request);
      if (!done.create) return [call('workspace_write', writeArgs, 'create')];
      if (!done.retry) return [{ ...call('workspace_write', writeArgs, 'create'), arguments: JSON.stringify(writeArgs, null, 2) }, call('workspace_list', {}, 'retry')];
      if (!done.read) return [call('workspace_read', { file_id: done.create.data.file_id, revision: done.create.data.revision }, 'read')];
      return 'Workspace fixture reply.';
    };
    const update = await h.send('Create notes/fixture.txt and verify the saved bytes.');
    const first = replies()[0]!;
    // Current default responder advertises registered handlers directly; discovery is not simulated.
    for (const name of ['workspace_write', 'workspace_list', 'workspace_read']) expect(first.tools?.map(tool => tool.name)).toContain(name);
    const result = allOutputs();
    expect(result.create).toMatchObject({ ok: true, data: { revision: 1, byte_size: new TextEncoder().encode(BYTES).length } });
    expect(result.retry).toMatchObject({ ok: true, source_taint: 'external', data: { count: 1, files: [{ path: writeArgs.path, revision: 1, provenance: 'agent_generated' }] } });
    expect(result.read).toMatchObject({ ok: true, source_taint: 'external', data: { text: BYTES, revision: 1, next_offset: null } });
    expect(h.puts).toHaveLength(1);
    expect(h.bytes.get(h.puts[0]!)).toEqual(new TextEncoder().encode(BYTES));
    expect(h.manifest()).toMatchObject({ binding: { ownerId: OWNER, doName: h.name }, files: [{ revision: 1, state: 'ready' }], operations: [{ status: 'committed' }] });
    expect(h.manifest()!.operations).toHaveLength(1);
    const writes = h.dispatches.mock.calls.filter(([c]) => c.name === 'workspace_write');
    expect(writes).toHaveLength(2); // Same call id, parsed arguments, authenticated turn; different JSON whitespace.
    expect(writes.map(([c]) => c.id)).toEqual(['create', 'create']);
    const writeResults = await Promise.all(h.dispatches.mock.results.filter((_, i) => h.dispatches.mock.calls[i]![0].name === 'workspace_write').map(result => result.value));
    expect(writeResults[0]).toMatchObject({ ok: true, data: result.create!.data }); expect(writeResults[1]).toMatchObject({ ok: true, data: result.create!.data });
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BYTES)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(result.create!.data.sha256).toBe(digest); expect(h.manifest()!.bodies[0]!.sha256).toBe(digest);
    const row = h.state.storage.kv.get<any[]>('telegram_owner_inbox_v1')!.find(row => row.updateId === update);
    expect(row).toMatchObject({ state: 'awaiting_delivery', reason: 'final_committed' });
    const final = h.state.storage.kv.get<any[]>('telegram_final_outbox_v1')!.find(final => final.id.startsWith('turn:'));
    expect(final.payload.text).toContain('Workspace fixture reply.');
    expect(final.inbox).toMatchObject({ runId: row.runId, attempt: row.attempt });
    const manifest = h.manifest(); const before = h.dispatches.mock.calls.length;
    h.restart(); await h.send('Create notes/fixture.txt and verify the saved bytes.', update);
    expect(h.dispatches.mock.calls).toHaveLength(before); expect(h.manifest()).toEqual(manifest); expect(h.puts).toHaveLength(1);
    model.reply = request => {
      const done = outputs(request);
      if (!done.listRestart) return [call('workspace_list', {}, 'listRestart')];
      if (!done.readRestart) return [call('workspace_read', { file_id: done.listRestart.data.files[0].file_id, revision: 1 }, 'readRestart')];
      return 'Restart readback verified.';
    };
    await h.send('Read my saved workspace file after restart.');
    expect(allOutputs().readRestart).toMatchObject({ ok: true, source_taint: 'external', data: { text: BYTES, revision: 1 } });
    expect(h.manifest()).toEqual(manifest); expect(h.puts).toHaveLength(1);
    expect(h.rpc).toContain('workspace_owner_binding'); expect(h.gets.length).toBeGreaterThan(1);
  });
});

it('authenticated default ingress rejects a foreign subject and locator before provider or workspace I/O', async () => {
  await proof(async h => {
    await h.send('Bind my owner presence.'); const calls = model.requests.length; const retained = h.manifest(); const rpc = h.rpc.length;
    expect((await h.enqueue('Other owner', undefined, '81102')).response.status).toBe(403);
    expect((await h.enqueue('Other locator', undefined, '81101', `${h.name}-foreign`)).response.status).toBe(403);
    expect(model.requests).toHaveLength(calls); expect(h.puts).toEqual([]); expect(h.gets).toEqual([]); expect(h.rpc).toHaveLength(rpc); expect(h.manifest()).toEqual(retained);
  });
});

it.each(['absent', 'owner', 'epoch'] as const)('registered writer fails closed when signed workspace mapping becomes %s', async fault => {
  await proof(async h => {
    model.reply = request => outputs(request).write ? 'Workspace attempt ended.' : [call('workspace_write', writeArgs, 'write')];
    if (fault === 'absent') h.absent();
    else {
      await h.send('Save the first owner file.');
      expect(allOutputs().write!.ok).toBe(true);
      const retained = h.manifest()!; const puts = h.puts.length; const gets = h.gets.length;
      if (fault === 'owner') h.mapping.owner_id = OTHER; else h.mapping.mapping_version++;
      model.reply = request => {
        const done = outputs(request);
        if (!done.changed) return [call('workspace_write', { ...writeArgs, path: 'notes/changed.txt' }, 'changed')];
        if (!done.changedRead) return [call('workspace_read', { file_id: retained.files[0]!.file_id, revision: 1 }, 'changedRead')];
        return 'Changed mapping refused.';
      };
      await h.send('Do not write through a changed workspace mapping.');
      expect(allOutputs().changed!.ok).toBe(false); expect(allOutputs().changedRead!.ok).toBe(false);
      expect(h.manifest()).toEqual(retained); expect(h.puts).toHaveLength(puts); expect(h.gets).toHaveLength(gets);
      return;
    }
    await h.send('Save only with an available canonical mapping.');
    expect(allOutputs().write!.ok).toBe(false); expect(h.puts).toEqual([]); expect(h.manifest()).toBeNull();
  });
});

it('epoch revocation after admitted R2 bytes preserves its pending reservation without publishing a ready revision', async () => {
  await proof(async h => {
    h.onPut(() => { h.mapping.state_version++; });
    model.reply = request => outputs(request).write ? 'Revoked write attempt ended.' : [call('workspace_write', writeArgs, 'write')];
    await h.send('Save only while my owner epoch is current.');
    expect(allOutputs().write!.ok).toBe(false); expect(h.puts).toHaveLength(1);
    expect(h.bytes.get(h.puts[0]!)).toEqual(new TextEncoder().encode(BYTES));
    expect(h.manifest()).toMatchObject({ files: [], bodies: [], operations: [{ status: 'pending', body: { byte_size: new TextEncoder().encode(BYTES).length } }] });
  });
});

it.each(['mapping_open', 'mapping_reserved', 'body'] as const)('actual /stop fences a registered write paused at %s after its losing handler resumes', async boundary => {
  await proof(async h => {
    const pause = boundary === 'body' ? h.pausePut() : h.pauseMapping(boundary === 'mapping_reserved');
    model.reply = request => outputs(request).write ? 'This must not publish.' : [call('workspace_write', writeArgs, 'write')];
    expect((await h.enqueue('Create a file until I stop the run.')).response.status).toBe(200);
    const alarm = h.alarm(); await pause.reached;
    const losing = h.dispatches.mock.results.filter((_, i) => h.dispatches.mock.calls[i]![0].name === 'workspace_write').at(-1)!.value as Promise<unknown>;
    expect(losing).toBeInstanceOf(Promise);
    expect((await h.enqueue('/stop')).response.status).toBe(200);
    await alarm; // The public alarm can settle before the pending I/O continuation.
    pause.release(); await Promise.allSettled([losing]);
    expect(h.manifest()?.files ?? []).toEqual([]); expect(h.manifest()?.bodies ?? []).toEqual([]);
    expect(h.state.storage.kv.get<any[]>('telegram_owner_inbox_v1')!.some(row => row.reason === 'owner_stopped' && row.closedAt !== undefined)).toBe(true);
    expect((h.state.storage.kv.get<any[]>('telegram_final_outbox_v1') ?? []).filter(row => row.id.startsWith('turn:'))).toEqual([]);
    if (boundary === 'mapping_open') { expect(h.puts).toEqual([]); expect(h.gets).toEqual([]); expect(h.manifest()).toMatchObject({ files: [], bodies: [], operations: [] }); }
    else if (boundary === 'mapping_reserved') { expect(h.puts).toEqual([]); expect(h.manifest()).toMatchObject({ files: [], bodies: [], operations: [{ status: 'pending' }] }); }
    else {
      expect(h.puts).toHaveLength(1); expect(h.bytes.get(h.puts[0]!)).toEqual(new TextEncoder().encode(BYTES));
      expect(h.manifest()!.operations).toHaveLength(1); expect(h.manifest()!.operations[0]!.status).toBe('pending');
    }
  });
});

it('unlinked owner during a pending body write cannot publish after the real handler resumes', async () => {
  await proof(async h => {
    const pause = h.pausePut();
    model.reply = request => outputs(request).write ? 'Unlinked write ended.' : [call('workspace_write', writeArgs, 'write')];
    expect((await h.enqueue('Save while the owner remains linked.')).response.status).toBe(200);
    const alarm = h.alarm(); await pause.reached; h.unlinked(); pause.release(); await alarm;
    await Promise.allSettled(h.dispatches.mock.results.filter((_, i) => h.dispatches.mock.calls[i]![0].name === 'workspace_write').map(result => result.value));
    expect(h.manifest()).toMatchObject({ files: [], bodies: [], operations: [{ status: 'pending' }] });
    expect((h.state.storage.kv.get<any[]>('telegram_final_outbox_v1') ?? []).filter(row => row.id.startsWith('turn:'))).toEqual([]);
  });
});

it('run A cannot borrow run B authority after /stop and a new default owner run starts', async () => {
  await proof(async h => {
    const pauseA = h.pausePut();
    model.reply = request => outputs(request).writeA ? 'A must not publish.' : [call('workspace_write', writeArgs, 'writeA')];
    const admittedA = await h.enqueue('Run A writes a pending file.'); expect(admittedA.response.status).toBe(200);
    const alarmA = h.alarm(); await pauseA.reached;
    const losingA = h.dispatches.mock.results.filter((_, i) => h.dispatches.mock.calls[i]![0].name === 'workspace_write').at(-1)!.value as Promise<unknown>;
    expect((await h.enqueue('/stop')).response.status).toBe(200); await alarmA;
    const pauseB = deferred();
    model.reply = async () => { pauseB.entered(); await pauseB.wait; return 'B completed independently.'; };
    const admittedB = await h.enqueue('Run B starts after stopping A.'); expect(admittedB.response.status).toBe(200);
    // Deliver a failure outbox if the fair alarm selects it before the next owner run.
    const startB = async () => { for (let i = 0; i < 3; i++) { await h.alarm(); if (model.requests.some(request => !request.text?.format && String(request.input).includes('Run B'))) return; } };
    const alarmB = startB(); await pauseB.reached;
    const rows = h.state.storage.kv.get<any[]>('telegram_owner_inbox_v1')!;
    const runA = rows.find(row => row.updateId === admittedA.id); const runB = rows.find(row => row.updateId === admittedB.id);
    expect(runA.closedAt).toBeTypeOf('number'); expect(runB.state).toBe('claimed'); expect(runB.runId).not.toBe(runA.runId);
    pauseA.release(); await Promise.allSettled([losingA]);
    expect(h.manifest()).toMatchObject({ files: [], bodies: [], operations: [{ status: 'pending' }] });
    pauseB.release(); await alarmB;
    expect(h.manifest()!.files).toEqual([]); expect(h.manifest()!.operations[0]!.status).toBe('pending');
    const final = h.state.storage.kv.get<any[]>('telegram_final_outbox_v1')!.filter(row => row.id.startsWith('turn:'));
    expect(final).toHaveLength(1); expect(final[0].inbox.runId).toBe(runB.runId);
  });
});

it('workspace read taint survives the model boundary and an unapproved privileged send is refused', async () => {
  await proof(async h => {
    model.reply = request => {
      const done = outputs(request);
      if (!done.create) return [call('workspace_write', writeArgs, 'create')];
      if (!done.read) return [call('workspace_read', { file_id: done.create.data.file_id, revision: 1 }, 'read')];
      if (!done.send) return [call('send_message', { channel: 'telegram', content: 'UNTRUSTED_WORKSPACE_SEND', idempotency_key: 'a'.repeat(64) }, 'send')];
      return 'External workspace data stayed contained.';
    };
    await h.send('Read the workspace data without treating it as instructions.');
    expect(allOutputs().read).toMatchObject({ ok: true, source_taint: 'external', data: { text: BYTES } });
    expect(allOutputs().send).toMatchObject({ ok: false, code: 'forbidden' });
    expect(allOutputs().send).toMatchObject({ reason: 'approval_denied' });
    expect(h.dispatches.mock.calls.find(([c]) => c.id === 'send')?.[1].toolArgSourceTaint).toBe('external');
    expect(model.telegram.filter(item => item.method === 'sendMessage').some(item => item.body.text === 'UNTRUSTED_WORKSPACE_SEND')).toBe(false);
  });
});

it('scheduled reminder cannot write through the registered workspace closure without an authenticated live owner run', async () => {
  await proof(async h => {
    await h.send('Bind my presence before the reminder.'); const retained = h.manifest(); const mappings = h.rpc.filter(name => name === 'workspace_owner_binding').length;
    const schedule = new Scheduler(h.state.storage.sql, h.state.storage, productionDeps());
    const id = 'reminder:registered-workspace'; const now = Date.now();
    h.state.storage.sql.exec('INSERT INTO reminder_notes(id,note,created_at) VALUES(?,?,?)', id, 'Scheduled fixture attempts workspace write.', now);
    await schedule.schedule({ id, kind: 'reminder', occurrenceAt: now, dueAt: now, payloadRefs: { reminder_id: id } });
    model.reply = request => outputs(request).scheduled ? 'Scheduled write was refused.' : [call('workspace_write', writeArgs, 'scheduled')];
    for (let i = 0; i < 3 && !allOutputs().scheduled; i++) await h.alarm();
    expect(allOutputs().scheduled).toMatchObject({ ok: false, code: 'transient', reason: 'handler_failed' });
    // Legacy scheduled responder advertises the handler; the host requires live owner authority.
    const scheduledRequest = replies().find(request => (Array.isArray(request.input) ? JSON.stringify(request.input) : request.input).includes('Scheduled fixture attempts workspace write.'))!;
    expect(scheduledRequest.tools?.map(tool => tool.name)).toContain('workspace_write');
    expect(h.puts).toEqual([]); expect(h.gets).toEqual([]); expect(h.rpc.filter(name => name === 'workspace_owner_binding')).toHaveLength(mappings); expect(h.manifest()).toEqual(retained);
    const scheduledContext = h.dispatches.mock.calls.find(([c]) => c.id === 'scheduled')![1];
    expect(scheduledContext.turnId).toBeTypeOf('string'); expect(scheduledContext.turnId!.length).toBeGreaterThan(0);
    expect(scheduledContext.runScope).toBeUndefined();
  });
});

it.each(['pdf', 'docx'] as const)('default owner ingress renders an actual %s file, downloads exact authenticated bytes and retains its digest after restart', async format => {
  await proof(async h => {
    await h.state.storage.put('origin', 'https://local.invalid');
    model.reply = request => {
      const done = outputs(request);
      if (!done.docSource) return [call('workspace_write', {path:'docs/source.md',text:'# Owner document\nA real saved file',mime:'text/markdown',expected_revision:0}, 'docSource')];
      if (!done.document) return [call('workspace_render', {source_file_id:done.docSource.data.file_id,source_revision:1,path:`docs/export.${format}`,expected_revision:0,format}, 'document')];
      return 'Document fixture reply.';
    };
    await h.send(`Save my document as ${format}.`);
    expect(replies()[0]!.tools?.map(t=>t.name)).toContain('workspace_render');
    const rendered = allOutputs().document!;
    expect(rendered).toMatchObject({ok:true,data:{status:'exported',revision:1,delivery:{status:'owner_link',audience:'owner_authenticated'}}});
    expect(rendered.data.delivery.url).toBe(`https://local.invalid/console/workspace/file?id=${rendered.data.file_id}&revision=1`);
    const manifest = h.manifest()!; expect(manifest.files).toHaveLength(2);
    const body = manifest.bodies.find(b=>b.file_id===rendered.data.file_id)!;
    const key = h.puts.find(k=>h.bytes.get(k)?.length===body.byte_size)!;
    const bytes = h.bytes.get(key)!;
    expect(bytes.length).toBe(rendered.data.byte_size);
    expect([...bytes.slice(0,4)]).toEqual(format==='pdf'?[37,80,68,70]:[80,75,3,4]);
    const access = consoleAccess(h.state.storage);
    const sessionLink = await access.mintLink('https://local.invalid');
    const session = await access.redeem(new URL(sessionLink).searchParams.get('t')!);
    expect(session).toBeTruthy();
    const headers = {cookie: `${CONSOLE_COOKIE}=${session}`};
    const download = await h.request(new Request(rendered.data.delivery.url, {headers}));
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe(format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="file"; filename*=UTF-8''export.${format}`);
    expect(download.headers.get('content-length')).toBe(String(bytes.length));
    expect(download.headers.get('cache-control')).toBe('private, no-store');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    const reads = h.gets.length;
    expect((await h.request(new Request(rendered.data.delivery.url))).status).toBe(401);
    const otherName = `${h.name}-foreign-download`;
    const otherStub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(otherName));
    const otherSession = await runInDurableObject(otherStub, async (_instance,state) => {
      const otherAccess = consoleAccess(state.storage);
      const link = await otherAccess.mintLink('https://local.invalid');
      return otherAccess.redeem(new URL(link).searchParams.get('t')!);
    });
    expect((await h.request(new Request(rendered.data.delivery.url,{headers:{cookie:`${CONSOLE_COOKIE}=${otherSession}`}}))).status).toBe(401);
    expect((await otherStub.fetch(rendered.data.delivery.url,{headers})).status).toBe(401);
    // Exercise the continuation through the real DO session/file admission boundary.
    const authEnv = { TELEGRAM_OWNER_DO: {
      idFromName: (name: string) => name,
      get: (name: string) => ({ fetch: (input: RequestInfo, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        return name === h.name ? h.request(request) : otherStub.fetch(request);
      } }),
    } as unknown as DurableObjectNamespace, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit };
    const identity = (name: string, verify = true) => ({
      readOwnerCookie: async (request: Request) => request.headers.get('cookie')?.includes('waldo_owner=') ? name : null,
      throttle: async () => true, verify: async () => verify ? name : null,
      ownerCookie: async () => 'fictional-owner-session',
    }) as unknown as ConsoleAuth;
    const storedSessions = (await h.state.storage.get<Record<string, { token: string; csrf: string; expires: number }>>('console:sessions'))!;
    storedSessions[session!]!.expires = Date.now() - 1;
    await h.state.storage.put('console:sessions', storedSessions);
    const expired = (await handleConsole(new Request(rendered.data.delivery.url, { headers: { cookie: `waldo_owner=fictional;${CONSOLE_COOKIE}=${session}` } }), authEnv, identity(h.name)))!;
    expect(expired.status).toBe(303);
    expect(new URL(expired.headers.get('location')!, rendered.data.delivery.url).searchParams.get('return_to')).toBe(new URL(rendered.data.delivery.url).pathname + new URL(rendered.data.delivery.url).search);
    await access.signOut(session!);
    const resume = (await handleConsole(new Request(rendered.data.delivery.url, { headers: { cookie: `waldo_owner=fictional;${CONSOLE_COOKIE}=${session}` } }), authEnv, identity(h.name)))!;
    expect(resume.status).toBe(303);
    const signInUrl = new URL(resume.headers.get('location')!, rendered.data.delivery.url);
    const returnTo = signInUrl.searchParams.get('return_to')!;
    expect(returnTo).toBe(new URL(rendered.data.delivery.url).pathname + new URL(rendered.data.delivery.url).search);
    const beforeAuthReads = h.gets.length;
    const invalid = (await handleConsole(new Request('https://local.invalid/console/verify', { method: 'POST', body: new URLSearchParams({ email: 'owner@example.test', code: 'wrong', return_to: returnTo }) }), authEnv, identity(h.name, false)))!;
    expect(await invalid.text()).not.toContain('id="signin-download"');
    expect(h.gets).toHaveLength(beforeAuthReads);
    const authenticate = async (name: string) => {
      const done = (await handleConsole(new Request('https://local.invalid/console/verify', { method: 'POST', body: new URLSearchParams({ email: 'owner@example.test', code: 'synthetic-valid', return_to: returnTo }) }), authEnv, identity(name)))!;
      expect(done.status).toBe(200);
      expect(await done.text()).toContain('Download your file');
      const cookie = done.headers.getAll('Set-Cookie').map(value => value.split(';')[0]).join('; ');
      return (await handleConsole(new Request(new URL(returnTo, 'https://local.invalid'), { headers: { cookie } }), authEnv, identity(name)))!;
    };
    const switched = await authenticate(otherName);
    expect(switched.status).not.toBe(200);
    expect(h.gets).toHaveLength(beforeAuthReads);
    const resumed = await authenticate(h.name);
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get('content-type')).toBe(format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(new Uint8Array(await resumed.arrayBuffer())).toEqual(bytes);
    // Refresh the original session for the existing restart assertions below.
    const refreshed = await access.grant();
    headers.cookie = `${CONSOLE_COOKIE}=${refreshed}`;
    const readsAfterResume = h.gets.length;
    const absent = new URL(rendered.data.delivery.url);absent.searchParams.set('id',crypto.randomUUID());
    expect((await h.request(new Request(absent,{headers}))).status).toBe(404);
    expect(h.gets).toHaveLength(readsAfterResume);
    h.restart();
    const afterRestart = await h.request(new Request(rendered.data.delivery.url,{headers}));
    expect(afterRestart.status).toBe(200);
    expect(new Uint8Array(await afterRestart.arrayBuffer())).toEqual(bytes);
    model.reply = request => outputs(request).savedDoc ? 'Stored document remains.' : [call('workspace_list',{prefix:'docs/export.'},'savedDoc')];
    await h.send('Check my exported document after restart.');
    expect(allOutputs().savedDoc).toMatchObject({ok:true,data:{files:[{file_id:rendered.data.file_id,revision:1,sha256:rendered.data.sha256}]}});
    expect(h.manifest()).toEqual(manifest); expect(h.puts).toHaveLength(2);
  });
});

it('default MD and TXT writes return authenticated downloads with exact text MIME, filename and bytes',async()=>{
 await proof(async h=>{
  await h.state.storage.put('origin','https://local.invalid');
  model.reply=request=>{
   const done=outputs(request);
   if(!done.markdownFile)return [call('workspace_write',{path:'docs/notes.md',text:'# Notes\nSaved markdown.',mime:'text/markdown',expected_revision:0},'markdownFile')];
   if(!done.textFile)return [call('workspace_write',{path:'docs/notes.txt',text:'Saved plain text.',mime:'text/plain',expected_revision:0},'textFile')];
   return 'Text documents saved.';
  };
  await h.send('Save my notes in Markdown and TXT.');
  const access=consoleAccess(h.state.storage),link=await access.mintLink('https://local.invalid');
  const session=await access.redeem(new URL(link).searchParams.get('t')!);
  for(const [name,mime,filename,text] of [['markdownFile','text/markdown','notes.md','# Notes\nSaved markdown.'],['textFile','text/plain','notes.txt','Saved plain text.']] as const){
   const r=allOutputs()[name]!;expect(r.ok).toBe(true);expect(r.data.delivery.status).toBe('owner_link');
   const download=await h.request(new Request(r.data.delivery.url,{headers:{cookie:`${CONSOLE_COOKIE}=${session}`}}));
   expect(download.status).toBe(200);expect(download.headers.get('content-type')).toBe(mime);
   expect(download.headers.get('content-disposition')).toBe(`attachment; filename="file"; filename*=UTF-8''${filename}`);
   expect(await download.text()).toBe(text);
  }
  expect(h.puts).toHaveLength(2);
 });
});

it('external list then initial creation preserves exact private contact bytes through revision, guarded read and authenticated download', async () => {
  await proof(async h => {
    await h.state.storage.put('origin', 'https://local.invalid');
    const initial = 'To: demo@example.test\nPhone: +1 415 555 0100\nAddress: 123 Main Street\nDemo at 13:00\nThanks.';
    const revised = initial.replace('13:00', '14:00').replace('Thanks.', 'Thanks so much. Looking forward to seeing you!');
    const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    model.reply = request => {
      const done = outputs(request);
      if (!done.beforeCreate) return [call('workspace_list', {}, 'beforeCreate')];
      if (!done.createContact) return [call('workspace_write', { path: 'docs/contact.md', text: initial, mime: 'text/markdown', expected_revision: 0 }, 'createContact')];
      if (!done.initialRead) return [call('workspace_read', { file_id: done.createContact.data.file_id, revision: 1 }, 'initialRead')];
      if (!done.reviseContact) return [call('workspace_write', { path: 'docs/contact.md', edits: [{ before: '13:00', after: '14:00' }, { before: 'Thanks.', after: 'Thanks so much. Looking forward to seeing you!' }], mime: 'text/markdown', expected_revision: 1 }, 'reviseContact')];
      if (!done.revisedRead) return [call('workspace_read', { file_id: done.createContact.data.file_id, revision: 2 }, 'revisedRead')];
      return 'Private contact fixture revised.';
    };
    await h.send(`Save these exact private document fields, then change the time and tone: ${initial}`);
    const result = allOutputs();
    expect(result.beforeCreate).toMatchObject({ ok: true, source_taint: 'external', data: { count: 0 } });
    expect(h.dispatches.mock.calls.find(([c]) => c.id === 'createContact')?.[1].toolArgSourceTaint).toBe('external');
    expect(result.createContact).toMatchObject({ ok: true, data: { revision: 1, byte_size: new TextEncoder().encode(initial).length, sha256: await digest(initial) } });
    expect(h.bytes.get(h.puts[0]!)).toEqual(new TextEncoder().encode(initial));
    expect(result.reviseContact).toMatchObject({ ok: true, data: { file_id: result.createContact!.data.file_id, revision: 2, byte_size: new TextEncoder().encode(revised).length, sha256: await digest(revised) } });
    expect(h.bytes.get(h.puts[1]!)).toEqual(new TextEncoder().encode(revised));
    expect(h.puts).toHaveLength(2);
    for (const name of ['initialRead', 'revisedRead']) {
      expect(result[name]).toMatchObject({ ok: true, source_taint: 'external' });
      expect(result[name]!.data.text).toContain('[REDACTED_EMAIL]');
      expect(result[name]!.data.text).not.toContain('demo@example.test');
    }
    expect(result.revisedRead!.data.text).toContain('Demo at 14:00');
    expect(h.dispatches.mock.calls.find(([c]) => c.id === 'reviseContact')?.[1].toolArgSourceTaint).toBe('external');
    const access = consoleAccess(h.state.storage);
    const session = await access.grant();
    const headers = { cookie: `${CONSOLE_COOKIE}=${session}` };
    h.restart();
    for (const [name, text] of [['createContact', initial], ['reviseContact', revised]] as const) {
      const download = await h.request(new Request(result[name]!.data.delivery.url, { headers }));
      expect(download.status).toBe(200);
      const bytes = new Uint8Array(await download.arrayBuffer());
      expect(bytes).toEqual(new TextEncoder().encode(text));
      expect([...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')).toBe(result[name]!.data.sha256);
      expect((await h.request(new Request(result[name]!.data.delivery.url))).status).toBe(401);
    }
    expect(h.manifest()).toMatchObject({ binding: { ownerId: OWNER, doName: h.name }, files: [{ file_id: result.createContact!.data.file_id, revision: 2 }], operations: [{ status: 'committed' }, { status: 'committed' }] });
  });
});
