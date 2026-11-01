// WhatsApp messages the owner sends close together get one reply, through the owner object's real admission path: texts in
// one payload or within the quiet window are one turn, and a reply that newer texts overtook before it did anything is not
// sent; one turn answers them all. A turn that acted keeps its reply, and a command or forward is never folded in.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

type RequestBody = { tools?: { name?: string }[]; input: string | { type?: string; call_id?: string }[]; text?: { format?: { name?: string } } };
const model = vi.hoisted(() => ({ requests: [] as RequestBody[], react: null as string | null, gate: null as Promise<void> | null, entered: () => {} }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const reacted = Array.isArray(body.input) && body.input.some(item => item.type === 'function_call_output' && item.call_id === 'react');
    const offered = body.tools?.some(tool => tool.name === 'react_to_message');
    if (!format && offered) { model.entered(); const gate = model.gate; model.gate = null; if (gate) await gate; }
    const output = !format && model.react && offered && !reacted
      ? [{ type: 'function_call', call_id: 'react', name: 'react_to_message', arguments: JSON.stringify({ reaction: model.react }) }] : [];
    const text = format ? format === 'claim_ops'
      ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
      : format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}'
      : output.length ? '' : `Reply ${model.requests.length}.`;
    return { id: `fixture-${model.requests.length}`, output_text: text, output, usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));

const OWNER = '00000000-0000-4000-8000-0000000000e3';
const SUBJECT = '15550002222';
type GraphCall = Record<string, unknown> & { type?: string; status?: string; context?: { message_id: string }; text?: { body: string }; reaction?: { message_id: string; emoji: string } };

beforeEach(() => { model.requests = []; model.react = null; model.gate = null; model.entered = () => {}; });

type Admit = (...messages: Record<string, unknown>[]) => Promise<void>;
const whatsappOwner = (name: string, run: (admit: Admit, drain: () => Promise<void>, graph: GraphCall[]) => Promise<void>, quietMs = '0') =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const bytes = new Map<string, Uint8Array>();
    const graph: GraphCall[] = [];
    const mapping = { owner_id: OWNER, environment: 'fixture', namespace: 'fixture-owner-namespace', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const fixtureEnv = { ...env, WHATSAPP_QUIET_MS: quietMs, OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      WALDO_ENVIRONMENT: mapping.environment, WALDO_OWNER_DO_NAMESPACE: mapping.namespace,
      SUPABASE_PROJECT_URL: 'https://signed-metadata.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret',
      ARTIFACTS: {
        put: async (key: string, value: Uint8Array) => { bytes.set(key, value.slice()); return null; },
        get: async (key: string) => { const value = bytes.get(key); return value ? { arrayBuffer: async () => value.slice().buffer } : null; },
        delete: async (key: string) => { bytes.delete(key); },
      } as unknown as R2Bucket,
    };
    // A 1x1 WebP, the shape of a static sticker.
    const webp = Uint8Array.from(atob('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA='), c => c.charCodeAt(0));
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://graph.facebook.com/v26.0/media-sticker') return Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=sticker' });
      if (url.startsWith('https://lookaside.fbsbx.com/')) return new Response(webp, { headers: { 'content-type': 'image/webp' } });
      if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
        const body = JSON.parse(String(init?.body)) as GraphCall;
        graph.push(body);
        return Response.json(body.status === 'read' ? { success: true } : { messages: [{ id: `wamid.out.${graph.length}` }] });
      }
      if (url === `${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/workspace_owner_binding`) return Response.json({ ...mapping });
      if (url.startsWith(`${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/`)) return Response.json(url.endsWith('health_log_recent') ? [] : url.endsWith('assert_channel_presence') ? true : null);
      throw new Error(`local fixture denies unexpected network: ${url}`);
    });
    const instance = new OwnerDO(state, fixtureEnv);
    // Admission only: the turns run when the owner's alarm pass drains the inbox, as drain() does here.
    const admit: Admit = async (...messages) => {
      const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT, 'x-waldo-do-name': name, 'x-waldo-origin': 'https://waldo.example' },
        body: JSON.stringify({ messages: messages.map(message => ({ from: SUBJECT, timestamp: String(Math.floor(Date.now() / 1000)), ...message })) }),
      }));
      expect(response.status).toBe(200);
    };
    try { await run(admit, () => drainWhatsAppTurns(instance), graph); } finally { network.mockRestore(); await state.storage.deleteAlarm(); }
  });

const replies = (graph: readonly GraphCall[]) => graph.filter(call => call.type === 'text').map(call => call.text!.body);
const turns = () => model.requests.filter(request => !request.text?.format && request.tools?.length);
const lastMessage = () => { const input = turns().at(-1)!.input; return JSON.stringify(Array.isArray(input) ? input.at(-1) : input); };
const text = (body: string, id: string, context?: object) => ({ id, type: 'text', text: { body }, ...(context ? { context } : {}) });
// Holds the next reply's model call until released, and says when it has started.
const holdReply = () => {
  let release!: () => void, started!: () => void;
  model.gate = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { started = done; });
  model.entered = () => { started(); model.entered = () => {}; };
  return { release, entered };
};

it('texts in one payload are one turn and one reply', async () => {
  await whatsappOwner('wa-merge-payload', async (admit, drain, graph) => {
    await admit(text('Hey Waldo', 'wamid.hey'), text('I have lost my axis bank debit card', 'wamid.card'));
    await drain();
    expect(turns()).toHaveLength(1);
    expect(lastMessage()).toContain('Hey Waldo\\nI have lost my axis bank debit card');
    expect(replies(graph)).toHaveLength(1);
  });
}, 60_000);

it('a greeting overtaken by the real question while Waldo is answering gets no reply of its own: one reply answers both', async () => {
  await whatsappOwner('wa-merge-overtaken', async (admit, drain, graph) => {
    const hold = holdReply();
    await admit(text('Hey Waldo', 'wamid.hey'));
    const draining = drain();
    await hold.entered;
    await admit(text('I have lost my axis bank debit card can you help me deactivate it', 'wamid.card'));
    hold.release();
    await draining;
    expect(turns()).toHaveLength(2);
    expect(lastMessage()).toContain('Hey Waldo\\nI have lost my axis bank debit card');
    expect(replies(graph)).toHaveLength(1);
  });
}, 60_000);

it('keeps the reply of a turn that acted, and answers the newer message on its own', async () => {
  await whatsappOwner('wa-merge-acted', async (admit, drain, graph) => {
    model.react = '👍';
    const hold = holdReply();
    await admit(text('Moved my gym to mornings', 'wamid.gym'));
    const draining = drain();
    await hold.entered;
    await admit(text('also book a table for two', 'wamid.table'));
    hold.release();
    await draining;
    await drain();
    expect(turns().map(turn => JSON.stringify(turn.input)).filter(input => input.includes('also book a table')).length).toBeGreaterThan(0);
    expect(replies(graph)).toHaveLength(2);
  });
}, 60_000);

it('never folds a reply into a forward that arrives while it is being written', async () => {
  await whatsappOwner('wa-merge-forward', async (admit, drain, graph) => {
    const hold = holdReply();
    await admit(text('Hey Waldo', 'wamid.hey'));
    const draining = drain();
    await hold.entered;
    await admit(text('Meeting moved to 4pm', 'wamid.fwd', { forwarded: true }));
    hold.release();
    await draining;
    await drain();
    expect(replies(graph)).toHaveLength(2);
  });
}, 60_000);

it('texts sent a moment apart within the quiet window are one turn', async () => {
  await whatsappOwner('wa-merge-quiet', async (admit, drain, graph) => {
    await admit(text('Hey Waldo', 'wamid.hey'));
    await new Promise(resolve => setTimeout(resolve, 50));
    await admit(text('I have lost my axis bank debit card', 'wamid.card'));
    // Still inside the quiet window: nothing has started yet.
    await drain();
    expect(turns()).toHaveLength(0);
    await new Promise(resolve => setTimeout(resolve, 350));
    await drain();
    expect(turns()).toHaveLength(1);
    expect(lastMessage()).toContain('Hey Waldo\\nI have lost my axis bank debit card');
    expect(replies(graph)).toHaveLength(1);
  }, '300');
}, 60_000);
