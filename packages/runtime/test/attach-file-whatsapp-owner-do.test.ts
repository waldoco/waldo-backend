// attach_file through the real owner DO on WhatsApp: admission, run scope, dispatcher, workspace host and the Graph
// upload. Graph, the signed directory RPC and R2 are local. The model writes a file, attaches it and replies; the
// document goes out after the reply, once, under one effect intent.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { WA_HELD_PREFIX } from '../src/channels/whatsapp-window';
import { toolOutput } from './fixtures/tool-output';

type RequestBody = { instructions?: string; tools?: { name?: string }[]; input: string | { type?: string; call_id?: string; output?: string }[]; text?: { format?: { name?: string } } };
type Call = { type: 'function_call'; call_id: string; name: string; arguments: string };
const model = vi.hoisted(() => ({ requests: [] as RequestBody[] }));
const outputOf = <T>(id: string) => model.requests.flatMap(r => Array.isArray(r.input) ? r.input : [])
  .filter(item => item.type === 'function_call_output' && item.call_id === id).map(item => toolOutput<T>(item.output!))[0];
const call = (call_id: string, name: string, args: object): Call => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args) });
// The model writes a note, attaches the file it wrote, then answers.
const reply = (): Call[] | string => {
  const written = outputOf<{ ok: boolean; data?: { file_id: string; revision: number } }>('write');
  if (!written) return [call('write', 'workspace_write', { path: 'notes/plan.txt', text: 'Plan for Friday\n', mime: 'text/plain', expected_revision: 0 })];
  if (!outputOf('attach')) return [call('attach', 'attach_file', { file_id: written.data!.file_id, revision: written.data!.revision })];
  return 'Here is the plan; the file follows.';
};
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const result = format ? format === 'claim_ops'
      ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
      : format === 'reaction' ? '{"reaction":"👌"}' : format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}'
      : reply();
    return { id: 'fixture', output_text: typeof result === 'string' ? result : '', output: Array.isArray(result) ? result : [], usage: { input_tokens: 1, output_tokens: 1 } };
  } };
} }));

const SUBJECT = '15550001111';
const OWNER = '10000000-0000-0000-0000-000000000001';

beforeEach(() => { model.requests = []; });

type GraphCall = { type: string; text?: string; document?: { id: string; filename: string }; upload?: { type: string; filename: string; size: number } };
type Owner = Readonly<{ state: DurableObjectState; graph: GraphCall[]; attachEffects(): Array<{ state: string; receipt?: { provider_id: string } }> }>;
// One owner asks for the plan in a message sent `ageMs` ago, through the real admission path. unlinkOnFileRead unlinks
// WhatsApp when the file's bytes are read after the attach was queued (the delivery step), closing the run mid-delivery.
const whatsappOwner = (name: string, ageMs: number, check: (owner: Owner) => void, unlinkOnFileRead = false) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const bytes = new Map<string, Uint8Array>();
    const graph: GraphCall[] = [];
    const mapping = { owner_id: OWNER, environment: 'fixture', namespace: 'fixture-owner-namespace', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const fixtureEnv = { ...env, OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      WALDO_ENVIRONMENT: mapping.environment, WALDO_OWNER_DO_NAMESPACE: mapping.namespace,
      SUPABASE_PROJECT_URL: 'https://signed-metadata.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret',
      ARTIFACTS: {
        put: async (key: string, value: Uint8Array) => { bytes.set(key, value.slice()); return null; },
        get: async (key: string) => { if (unlinkOnFileRead && outputOf('attach')) state.storage.kv.put('whatsapp_unlinked', true); const value = bytes.get(key); return value ? { arrayBuffer: async () => value.slice().buffer } : null; },
        delete: async (key: string) => { bytes.delete(key); },
      } as unknown as R2Bucket,
    };
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://graph.facebook.com/v21.0/fictional-phone-id/media') {
        const form = init?.body as FormData, file = form.get('file') as unknown as File;
        graph.push({ type: 'upload', upload: { type: String(form.get('type')), filename: file.name, size: file.size } });
        return Response.json({ id: 'media.1' });
      }
      if (url === 'https://graph.facebook.com/v21.0/fictional-phone-id/messages') {
        const body = JSON.parse(String(init?.body)) as { type: string; text?: { body: string }; document?: { id: string; filename: string } };
        graph.push({ type: body.type, ...(body.text ? { text: body.text.body } : {}), ...(body.document ? { document: body.document } : {}) });
        return Response.json({ messages: [{ id: `wamid.out.${graph.length}` }] });
      }
      if (url === `${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/workspace_owner_binding`) return Response.json({ ...mapping });
      if (url.startsWith(`${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/`)) return Response.json(url.endsWith('health_log_recent') ? [] : url.endsWith('assert_channel_presence') ? true : null);
      throw new Error(`local fixture denies unexpected network: ${url}`);
    });
    const instance = new OwnerDO(state, fixtureEnv);
    try {
      const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT, 'x-waldo-do-name': name, 'x-waldo-origin': 'https://waldo.example' },
        body: JSON.stringify({ messages: [{ from: SUBJECT, id: 'wamid.ask', timestamp: String(Math.floor((Date.now() - ageMs) / 1000)), type: 'text', text: { body: 'Write up the plan and send me the file.' } }] }),
      }));
      expect(response.status).toBe(200);
      await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
      expect(outputOf('attach')).toMatchObject({ ok: true, data: { queued: true, filename: 'plan.txt' } });
      check({ state, graph, attachEffects: () => [...state.storage.kv.list<{ tool: string; state: string; receipt?: { provider_id: string } }>({ prefix: 'owner:effect:' })].map(([, row]) => row).filter(row => row.tool === 'attach_file') });
    } finally { network.mockRestore(); await state.storage.deleteAlarm(); }
  });

it('a WhatsApp owner asks for a file: the reply goes out, then the file as a document, with one effect record', async () => {
  await whatsappOwner('attach-file-whatsapp-e2e', 0, ({ graph, attachEffects }) => {
    const turn = model.requests.find(request => request.tools?.some(tool => tool.name === 'attach_file'));
    expect(turn?.instructions).toContain('Attachment sending: available');
    expect(graph).toEqual([
      { type: 'text', text: expect.stringMatching(/^Here is the plan; the file follows\./) },
      { type: 'upload', upload: { type: 'text/plain', filename: 'plan.txt', size: 'Plan for Friday\n'.length } },
      { type: 'document', document: { id: 'media.1', filename: 'plan.txt' } },
    ]);
    // The file was only queued when the reply was written, so the reply never claims it.
    expect(graph[0]!.text).not.toMatch(/attach|sent/i);
    expect(attachEffects()).toMatchObject([{ state: 'done', receipt: { provider_id: 'wamid.out.3' } }]);
  });
});

it('a message answered after the 24-hour window closed: the reply is held, no bytes leave, and the link is held behind it', async () => {
  await whatsappOwner('attach-file-whatsapp-window-closed', 25 * 60 * 60 * 1000, ({ state, graph, attachEffects }) => {
    expect(graph.filter(call => call.type === 'upload' || call.type === 'document')).toEqual([]);
    const held = [...state.storage.kv.list<{ body: { text: string } }>({ prefix: WA_HELD_PREFIX })].map(([, record]) => record.body.text);
    expect(held).toEqual([expect.stringMatching(/^Here is the plan; the file follows\./), expect.stringMatching(/^Here is plan\.txt\. Open it here: https:\/\/waldo\.example\/console\/workspace\/file\?id=[^&]+&revision=1$/)]);
    // The file was not sent; the held link text is the window layer's custody, so the file's intent is never done.
    expect(attachEffects()).toEqual([expect.objectContaining({ state: 'rejected' })]);
    expect(attachEffects()[0]!.receipt).toBeUndefined();
  });
});

it('a run closed while the file is being read sends no bytes, records the file as not sent, and tells no unlinked sender', async () => {
  await whatsappOwner('attach-file-whatsapp-closed-run', 0, ({ graph, attachEffects }) => {
    expect(graph).toEqual([{ type: 'text', text: expect.stringMatching(/^Here is the plan; the file follows\./) }]);
    expect(attachEffects()).toMatchObject([{ state: 'rejected' }]);
  }, true);
});
