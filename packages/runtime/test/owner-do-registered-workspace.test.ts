// Actual deployed constructor, authenticated inbox and alarm, dispatcher, workspace host,
// SQLite manifest and R2-shaped byte fixture. No private owner host or live provider exists.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import type { WorkspaceState } from '@waldo/workspace';
import type { ComputeService } from '../src/channels/compute-host';
import type { ComputeResult } from '../src/execution-environment/compute-journal';
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
const model = vi.hoisted(() => ({ sourceDecision: '{"decision":"retain","sources":[]}', requests: [] as RequestBody[], reply: undefined as undefined | ((request: RequestBody) => Promise<Call[] | string> | Call[] | string), telegram: [] as { method: string; body: any }[] }));
vi.mock('../src/channels/telegram-api', async load => ({
  ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, body: unknown) => { model.telegram.push({ method, body }); return method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: 1, chat: { id: (body as { chat_id: number }).chat_id } } : true; },
}));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const result = format ? format === 'task_source_scope' ? model.sourceDecision : format === 'claim_ops'
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
beforeEach(() => { model.sourceDecision = '{"decision":"retain","sources":[]}'; model.requests = []; model.reply = undefined; model.telegram = []; });

// Private service double, never a Linux isolation or live provider claim.
const computeFixture = (loseResponse = false) => {
  const results = new Map<string, ComputeResult>();
  const execute = vi.fn<ComputeService['execute']>(async (scope, request) => {
    const previous = results.get(`${scope}:${request.operationId}`); if (previous) return previous;
    expect(request.argv[0]).toBe('node'); expect(request.inputs).toHaveLength(1);
    expect(new TextDecoder().decode(request.inputs[0]!.bytes)).toBe('category,amount\nFood,10\nFood,15\nTravel,30\n');
    const result = { bytes: new TextEncoder().encode('# Expense report\nFood: 25\nTravel: 30\nTotal: 55\n'), stdout: '3 rows processed', stderr: '', exitCode: 0 };
    results.set(`${scope}:${request.operationId}`, result); if (loseResponse) { loseResponse = false; throw Error('synthetic provider response lost'); } return result;
  });
  const recover = vi.fn<ComputeService['recover']>(async (scope, operation) => results.get(`${scope}:${operation}`) ?? null);
  const service = { execute, recover, cancel: vi.fn(async () => {}) } satisfies ComputeService;
  return { service, execute, recover };
};
const computeInput = { path: 'compute/expenses.csv', text: 'category,amount\nFood,10\nFood,15\nTravel,30\n', mime: 'text/plain', expected_revision: 0 };
const computeArgs = (fileId: string) => ({ argv: ['node', '-e',  'const fs=require("node:fs");const rows=fs.readFileSync("input.csv","utf8").trim().split("\\n").slice(1).map(row=>row.split(","));const totals={};for(const [category,amount] of rows)totals[category]=(totals[category]||0)+Number(amount);fs.writeFileSync("report.md","# Expense report\\n"+Object.entries(totals).map(([k,v])=>k+": "+v).join("\\n")+"\\nTotal: "+Object.values(totals).reduce((a,b)=>a+b,0)+"\\n");' ], inputs: [{ file_id: fileId, revision: 1, path: 'input.csv' }], output_path: 'report.md', path: 'compute/report.md', mime: 'text/markdown', expected_revision: 0 });

async function proof(work: (h: {
  state: DurableObjectState; name: string; bytes: Map<string, Uint8Array>; puts: string[]; gets: string[]; rpc: string[];
  enqueue(text: string, id?: number, subject?: string, doName?: string, entities?: readonly { type: string; offset: number; length: number }[]): Promise<{ response: Response; id: number }>;
  send(text: string, id?: number, entities?: readonly { type: string; offset: number; length: number }[]): Promise<number>; alarm(): Promise<void>; restart(): void; manifest(): WorkspaceState | null; request(request: Request): Promise<Response>;
  mapping: { owner_id: string; environment: string; namespace: string; do_name: string; do_id: string; state_version: number; mapping_version: number };
  absent(): void; unlinked(): void; pauseMapping(afterReservation?: boolean): ReturnType<typeof deferred>; pausePut(): ReturnType<typeof deferred>;
  onPut(fn: () => void): void; dispatches: MockInstance<typeof dispatcher.dispatchTool>;
}) => Promise<void>, numericWorkspaceIdsAfter?: number, extraEnv: Record<string, unknown> = {}) {
  const name = `registered-workspace-${++sequence}`;
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const nativeUuid = crypto.randomUUID.bind(crypto);
    let workspaceIds = 0;
    // Inject at the production workspace host's newId boundary, not run ids/canaries.
    // Other production calls keep real UUIDs and all workspace I/O remains real.
    const uuid = numericWorkspaceIdsAfter === undefined ? undefined : vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      if (!new Error().stack?.includes('workspace-host.ts')) return nativeUuid();
      const n = ++workspaceIds;
      return n <= numericWorkspaceIdsAfter
        ? `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, 'a')}`
        : `aaaaaaaa-aaaa-4aaa-4111-${String(n).padStart(12, '1')}`;
    });
    const mapping = { owner_id: OWNER, environment: 'fixture', namespace: 'fixture-owner-namespace', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const bytes = new Map<string, Uint8Array>(); const puts: string[] = []; const gets: string[] = []; const rpc: string[] = []; const unexpected: string[] = []; const pauses: ReturnType<typeof deferred>[] = [];
    let pauseAfterReservation = false; let missing = false; let mappingPause: ReturnType<typeof deferred> | undefined; let putPause: ReturnType<typeof deferred> | undefined; let afterPut: (() => void) | undefined;
    const fixtureEnv = { ...env, ...extraEnv, WALDO_ENVIRONMENT: mapping.environment, WALDO_OWNER_DO_NAMESPACE: mapping.namespace,
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
    const enqueue = async (text: string, id = ++sequence, subject = '81101', doName = name, entities?: readonly { type: string; offset: number; length: number }[]) => ({ id, response: await instance.fetch(new Request('https://local.invalid/enqueue', {
      method: 'POST', headers: { 'x-waldo-inbox-secret': fixtureEnv.TELEGRAM_WEBHOOK_SECRET, 'x-waldo-origin': 'https://local.invalid', 'x-waldo-telegram-subject': subject, 'x-waldo-do-name': doName },
      body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: Number(subject), is_bot: false }, chat: { id: Number(subject), type: 'private' }, text, ...(entities ? { entities } : {}) } }),
    })) });
    const send = async (text: string, id?: number, entities?: readonly { type: string; offset: number; length: number }[]) => {
      const admitted = await enqueue(text, id, undefined, undefined, entities); expect(admitted.response.status).toBe(200);
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
    } finally { for (const pause of pauses) pause.release(); await state.storage.deleteAlarm(); localFetch.mockRestore(); dispatches.mockRestore(); uuid?.mockRestore(); }
    expect(unexpected).toEqual([]);
  });
}

it('ordinary two-argument owner turn computes a saved CSV report, recovers lost result, reads/renders/delivers it and reopens after restart', async () => {
  const compute = computeFixture(true);
  await proof(async h => {
    await h.state.storage.put('origin', 'https://local.invalid');
    model.reply = request => {
      const done = outputs(request);
      if (!done.csvInput) return [call('workspace_write', computeInput, 'csvInput')];
      if (!done.computeReport) return [call('workspace_compute', computeArgs(done.csvInput.data.file_id), 'computeReport')];
      if (!done.computeReport.ok) return 'Compute failed without a usable artifact.';
      if (!done.readReport) return [call('workspace_read', { file_id: done.computeReport.data.file_id, revision: 1 }, 'readReport')];
      if (!done.renderReport) return [call('workspace_render', { source_file_id: done.computeReport.data.file_id, source_revision: 1, path: 'compute/report.pdf', expected_revision: 0, format: 'pdf' }, 'renderReport')];
      return `Report saved: ${done.renderReport.data.delivery.url}`;
    };
    const update = await h.send('Use my pasted CSV category,amount; Food,10; Food,15; Travel,30. Save it privately, compute category totals with Node, read the report and render a PDF.');
    expect(replies()[0]!.tools?.map(tool => tool.name)).toContain('workspace_compute');
    const done = allOutputs();
    expect(done.computeReport, JSON.stringify(done.computeReport)).toMatchObject({ ok: true, source_taint: 'external', data: { stdout: '3 rows processed', delivery: { status: 'owner_link', audience: 'owner_authenticated' } } });
    expect(done.readReport).toMatchObject({ ok: true, data: { text: '# Expense report\nFood: 25\nTravel: 30\nTotal: 55\n' } });
    expect(done.renderReport).toMatchObject({ ok: true, data: { mime: 'application/pdf', delivery: { status: 'owner_link' } } });
    expect(compute.execute).toHaveBeenCalledTimes(1); expect(compute.execute.mock.calls[0]![0]).toBe(h.state.id.toString());
    expect([...h.state.storage.kv.list<any>({ prefix: 'owner:effect:' })].map(([, row]) => row).find(row => row.tool === 'workspace_compute')).toMatchObject({ state: 'done' });
    const access = consoleAccess(h.state.storage); const session = await access.grant(); const headers = { cookie: `${CONSOLE_COOKIE}=${session}` };
    const saved = new Map<string, Uint8Array>();
    for (const name of ['computeReport', 'renderReport']) {
      const download = await h.request(new Request(done[name]!.data.delivery.url, { headers })); expect(download.status).toBe(200);
      const bytes = new Uint8Array(await download.arrayBuffer()); saved.set(name, bytes);
      expect((await h.request(new Request(done[name]!.data.delivery.url))).status).toBe(401);
    }
    expect(new TextDecoder().decode(saved.get('renderReport')!.slice(0, 5))).toBe('%PDF-');
    const manifest = h.manifest(); expect(manifest!.files).toHaveLength(3); expect(manifest!.files.find(file => file.path === 'compute/report.md')!.provenance).toBe('sandbox_output');
    h.restart(); await h.send('Use my pasted CSV category,amount; Food,10; Food,15; Travel,30. Save it privately, compute category totals with Node, read the report and render a PDF.', update); expect(compute.execute).toHaveBeenCalledTimes(1);
    for (const name of ['computeReport', 'renderReport']) {
      const download = await h.request(new Request(done[name]!.data.delivery.url, { headers })); expect(new Uint8Array(await download.arrayBuffer())).toEqual(saved.get(name));
    }
    model.reply = request => outputs(request).reopenReport ? 'Stored report reopened.' : [call('workspace_read', { file_id: done.computeReport!.data.file_id, revision: 1 }, 'reopenReport')];
    await h.send('Read my saved expense report after restart.'); expect(allOutputs().reopenReport).toMatchObject({ ok: true, data: { text: '# Expense report\nFood: 25\nTravel: 30\nTotal: 55\n' } });
    expect(compute.execute).toHaveBeenCalledTimes(1); expect(h.manifest()).toEqual(manifest);
  }, undefined, { COMPUTE: compute.service });
});

it('console CSV upload reaches the ordinary owner loop, computes the requested revision, and delivers a private PDF link that survives restart', async () => {
  const compute = computeFixture();
  await proof(async h => {
    await h.send('Open my private workspace.');
    const session = await consoleAccess(h.state.storage).grant();
    const headers = { cookie: `${CONSOLE_COOKIE}=${session}`, origin: 'https://local.invalid' };
    const listing = await h.request(new Request('https://local.invalid/console/workspace', { headers: { ...headers, accept: 'application/json' } }));
    expect(listing.status).toBe(200);
    const { csrf } = await listing.json() as { csrf: string };
    const upload = async (text: string, expected: number, token = csrf) => {
      const form = new FormData();
      form.set('csrf', token); form.set('operation_id', crypto.randomUUID());
      form.set('path', computeInput.path); form.set('expected_revision', String(expected));
      form.set('file', new File([text], 'expenses.csv', { type: 'text/csv' }));
      return h.request(new Request('https://local.invalid/console/workspace/upload', { method: 'POST', headers, body: form }));
    };
    expect((await upload(computeInput.text, 0, 'wrong-csrf')).status).toBe(403);
    expect(h.puts).toEqual([]); expect(compute.execute).not.toHaveBeenCalled();
    const original = await upload(computeInput.text, 0); expect(original.status).toBe(200);
    const source = await original.json() as { file_id: string; revision: number };
    expect(source.revision).toBe(1);
    const changed = await upload('category,amount\nFood,999\n', 1); expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ file_id: source.file_id, revision: 2 });
    model.reply = request => {
      const done = outputs(request);
      if (!done.uploads) return [call('workspace_list', { prefix: 'compute/' }, 'uploads')];
      if (!done.uploadedReport) return [call('workspace_compute', computeArgs(done.uploads.data.files[0].file_id), 'uploadedReport')];
      if (!done.uploadedReport.ok) return 'The uploaded report could not be computed.';
      if (!done.uploadedRead) return [call('workspace_read', { file_id: done.uploadedReport.data.file_id, revision: 1 }, 'uploadedRead')];
      if (!done.uploadedPdf) return [call('workspace_render', { source_file_id: done.uploadedReport.data.file_id, source_revision: 1, path: 'compute/report.pdf', expected_revision: 0, format: 'pdf' }, 'uploadedPdf')];
      return `Your uploaded CSV report is ready: ${done.uploadedPdf.data.delivery.url}`;
    };
    await h.send('Use revision 1 of my uploaded compute/expenses.csv, even though I uploaded a newer revision. Compute category totals, read the report, and send me a PDF.');
    const done = allOutputs();
    expect(done.uploads).toMatchObject({ ok: true, data: { files: [{ file_id: source.file_id, revision: 2, provenance: 'owner_upload' }] } });
    expect(done.uploadedRead).toMatchObject({ ok: true, source_taint: 'external', data: { text: '# Expense report\nFood: 25\nTravel: 30\nTotal: 55\n' } });
    expect(done.uploadedPdf).toMatchObject({ ok: true, data: { delivery: { status: 'owner_link', audience: 'owner_authenticated' } } });
    expect(compute.execute).toHaveBeenCalledTimes(1);
    expect(compute.execute.mock.calls[0]![0]).toBe(h.state.id.toString());
    expect(compute.execute.mock.calls[0]![1].inputs).toEqual([{ path: 'input.csv', bytes: new TextEncoder().encode(computeInput.text) }]);
    const url = done.uploadedPdf!.data.delivery.url;
    const deliveryClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000);
    try { await h.alarm(); await h.alarm(); } finally { deliveryClock.mockRestore(); }
    const delivered = model.telegram.filter(message => message.method === 'sendMessage' && message.body.text.includes(done.uploadedPdf!.data.file_id));
    expect(delivered).toHaveLength(1); expect(delivered[0]!.body.chat_id).toBe(81101);
    expect(delivered[0]!.body.text.replace(/&#38;|&amp;/g, '&')).toContain(url);
    expect(h.state.storage.kv.get<any[]>('telegram_final_outbox_v1')!.find(row => row.payload.text.includes(done.uploadedPdf!.data.file_id))).toMatchObject({ status: 'delivered', settled: true, deliveredParts: 1 });
    const download = await h.request(new Request(url, { headers })); expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(sha256).toBe(done.uploadedPdf!.data.sha256);
    expect((await h.request(new Request(url))).status).toBe(401);
    const manifest = h.manifest(); const puts = h.puts.length;
    h.restart();
    const reopened = await h.request(new Request(url, { headers })); expect(reopened.status).toBe(200);
    expect(new Uint8Array(await reopened.arrayBuffer())).toEqual(bytes);
    model.reply = request => outputs(request).uploadedReopen ? 'The saved report is unchanged.' : [call('workspace_read', { file_id: done.uploadedReport!.data.file_id, revision: 1 }, 'uploadedReopen')];
    await h.send('Read the saved report again.');
    expect(allOutputs().uploadedReopen).toMatchObject({ ok: true, data: { text: '# Expense report\nFood: 25\nTravel: 30\nTotal: 55\n' } });
    expect(compute.execute).toHaveBeenCalledTimes(1); expect(h.puts).toHaveLength(puts); expect(h.manifest()).toEqual(manifest);
  }, undefined, { COMPUTE: compute.service });
});

it('actual /stop cancels in-flight compute without publishing a late artifact', async () => {
  const compute = computeFixture(); const pause = deferred();
  await proof(async h => {
    model.reply = request => outputs(request).seedCompute ? 'Input saved.' : [call('workspace_write', computeInput, 'seedCompute')];
    await h.send('Save my expense CSV.'); const seed = allOutputs().seedCompute!;
    const manifest = h.manifest(); const puts = h.puts.length;
    compute.execute.mockImplementation(async () => { pause.entered(); await pause.wait; return { bytes: new TextEncoder().encode('late result'), stdout: '', stderr: '', exitCode: 0 }; });
    compute.service.cancel = vi.fn(async () => { pause.release(); });
    model.reply = request => outputs(request).lateCompute ? 'Stopped.' : [call('workspace_compute', computeArgs(seed.data.file_id), 'lateCompute')];
    await h.enqueue('Compute the report.'); const alarm = h.alarm(); await pause.reached;
    const losing = h.dispatches.mock.results.filter((_, i) => h.dispatches.mock.calls[i]![0].name === 'workspace_compute').at(-1)!.value as Promise<unknown>;
    await h.enqueue('/stop'); await alarm; await Promise.allSettled([losing]);
    expect(compute.service.cancel).toHaveBeenCalled(); expect(h.puts).toHaveLength(puts); expect(h.manifest()).toEqual(manifest);
    expect([...h.state.storage.kv.list<any>({ prefix: 'owner:effect:' })].map(([, row]) => row).find(row => row.tool === 'workspace_compute')).toMatchObject({ state: 'unknown' });
  }, undefined, { COMPUTE: compute.service });
});

it.each(['binding', 'owner', 'epoch'] as const)('ordinary owner compute cannot issue with invalid %s boundary', async fault => {
  const compute = computeFixture();
  await proof(async h => {
    model.reply = request => outputs(request).seedCompute ? 'Input saved.' : [call('workspace_write', computeInput, 'seedCompute')];
    await h.send('Save my pasted expense CSV privately.'); const seed = allOutputs().seedCompute!; expect(seed.ok).toBe(true);
    const manifest = h.manifest(); const puts = h.puts.length;
    if (fault === 'owner') h.mapping.owner_id = OTHER;
    if (fault === 'epoch') compute.recover.mockImplementation(async () => { h.mapping.state_version++; return null; });
    model.reply = request => outputs(request).deniedCompute ? 'Compute unavailable.' : [call('workspace_compute', computeArgs(seed.data.file_id), 'deniedCompute')];
    await h.send('Compute my saved CSV now.');
    expect(allOutputs().deniedCompute!.ok).toBe(false); expect(compute.execute).not.toHaveBeenCalled(); expect(h.puts).toHaveLength(puts); expect(h.manifest()).toEqual(manifest);
  }, undefined, fault === 'binding' ? {} : { COMPUTE: compute.service });
});

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

it.each([['pdf', undefined], ['docx', undefined], ['docx', 2]] as const)('default owner ingress renders an actual %s file, downloads exact authenticated bytes and retains its digest after restart', async (format, numericIdsAfter) => {
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
  }, numericIdsAfter);
});

it.each([undefined, 0])('default MD and TXT writes return authenticated downloads with exact text MIME, filename and bytes (numeric UUIDs after %s)',async numericIdsAfter=>{
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
   expect(download.status,`download ${name} -> ${download.status} ${await download.clone().text()}`).toBe(200);expect(download.headers.get('content-type')).toBe(mime);
   expect(download.headers.get('content-disposition')).toBe(`attachment; filename="file"; filename*=UTF-8''${filename}`);
   expect(await download.text()).toBe(text);
  }
  expect(h.puts).toHaveLength(2);
 }, numericIdsAfter);
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
      // Owner direction 2026-10-04: model-bound reads keep the owner's own contact details readable.
      expect(result[name]!.data.text).toContain('demo@example.test');
      expect(result[name]!.data.text).not.toContain('[REDACTED_EMAIL]');
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
