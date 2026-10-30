// WhatsApp reactions, quoted replies and stickers through the owner object's real admission path. The owner's reaction on
// a message Waldo sent waits for their next turn as one line and starts nothing; a swipe-reply to Waldo's message reaches
// the turn as the guarded quote, authored by Waldo; Waldo's own reaction goes out after its reply, on the message it
// answers; a reply quotes the owner's message only when a later one came in after it; a static sticker is read as an image.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';

type RequestBody = { tools?: { name?: string }[]; input: string | { type?: string; call_id?: string }[]; text?: { format?: { name?: string } } };
const model = vi.hoisted(() => ({ requests: [] as RequestBody[], react: null as string | null }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const reacted = Array.isArray(body.input) && body.input.some(item => item.type === 'function_call_output' && item.call_id === 'react');
    const offered = body.tools?.some(tool => tool.name === 'react_to_message');
    const output = !format && model.react && offered && !reacted
      ? [{ type: 'function_call', call_id: 'react', name: 'react_to_message', arguments: JSON.stringify({ reaction: model.react }) }] : [];
    const text = format ? format === 'claim_ops'
      ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
      : format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}'
      : output.length ? '' : 'Your train is at 07:40.';
    return { id: `fixture-${model.requests.length}`, output_text: text, output, usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));

const OWNER = '00000000-0000-4000-8000-0000000000e2';
const SUBJECT = '15550002222';
type GraphCall = Record<string, unknown> & { type?: string; status?: string; context?: { message_id: string }; text?: { body: string }; reaction?: { message_id: string; emoji: string } };

beforeEach(() => { model.requests = []; model.react = null; });

const whatsappOwner = (name: string, run: (deliver: (...messages: Record<string, unknown>[]) => Promise<void>, graph: GraphCall[]) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const bytes = new Map<string, Uint8Array>();
    const graph: GraphCall[] = [];
    const mapping = { owner_id: OWNER, environment: 'fixture', namespace: 'fixture-owner-namespace', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const fixtureEnv = { ...env, OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
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
    const deliver = async (...messages: Record<string, unknown>[]) => {
      const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT, 'x-waldo-do-name': name, 'x-waldo-origin': 'https://waldo.example' },
        body: JSON.stringify({ messages: messages.map(message => ({ from: SUBJECT, timestamp: String(Math.floor(Date.now() / 1000)), ...message })) }),
      }));
      expect(response.status).toBe(200);
      await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
    };
    try { await run(deliver, graph); } finally { network.mockRestore(); await state.storage.deleteAlarm(); }
  });

const sends = (graph: readonly GraphCall[]) => graph.filter(call => call.status !== 'read');
const turns = () => model.requests.filter(request => !request.text?.format && request.tools?.length);
const lastTurn = () => JSON.stringify(turns().at(-1));
// The owner's message the latest turn answers: the last item of its input, after the history.
const lastMessage = () => { const input = turns().at(-1)!.input; return JSON.stringify(Array.isArray(input) ? input.at(-1) : input); };
const text = (body: string, id: string, context?: object) => ({ id, type: 'text', text: { body }, ...(context ? { context } : {}) });

it('the owner\'s reaction on Waldo\'s reply starts no turn and reaches their next turn as one line; taking it back removes the line', async () => {
  await whatsappOwner('wa-react-in', async (deliver, graph) => {
    await deliver(text('when is my train?', 'wamid.ask'));
    const reply = sends(graph).find(call => call.text?.body.startsWith('Your train is at 07:40.'));
    const replyId = `wamid.out.${graph.indexOf(reply!) + 1}`;
    const before = turns().length;
    await deliver({ id: 'wamid.react.1', type: 'reaction', reaction: { message_id: replyId, emoji: '❤️' } });
    expect(turns().length).toBe(before);
    await deliver(text('thanks', 'wamid.next'));
    expect(lastMessage()).toContain('[Owner reacted ❤️ to your message: \\"Your train is at 07:40.');

    await deliver({ id: 'wamid.react.2', type: 'reaction', reaction: { message_id: replyId, emoji: '👍' } });
    await deliver({ id: 'wamid.react.3', type: 'reaction', reaction: { message_id: replyId } });
    await deliver(text('and tomorrow?', 'wamid.after'));
    expect(lastMessage()).toContain('and tomorrow?');
    expect(lastMessage()).not.toContain('Owner reacted');
  });
}, 60_000);

it('a reaction on a message Waldo has no record of leaves nothing for the next turn', async () => {
  await whatsappOwner('wa-react-unknown', async (deliver) => {
    await deliver({ id: 'wamid.react.x', type: 'reaction', reaction: { message_id: 'wamid.someone-else', emoji: '😂' } });
    await deliver(text('hi', 'wamid.hi'));
    expect(lastMessage()).toContain('hi');
    expect(lastTurn()).not.toContain('Owner reacted');
  });
}, 60_000);

it('a swipe-reply to Waldo\'s message reaches the turn as Waldo\'s quoted words, and an unknown target adds nothing', async () => {
  await whatsappOwner('wa-reply-in', async (deliver, graph) => {
    await deliver(text('when is my train?', 'wamid.ask'));
    const replyId = `wamid.out.${graph.findIndex(call => call.text?.body.startsWith('Your train is at 07:40.')) + 1}`;
    await deliver(text('can you move it later?', 'wamid.reply', { from: '15550009999', id: replyId }));
    expect(lastTurn()).toContain('Transport-observed author: waldo; forwarded: false.');
    expect(lastTurn()).toContain('Your train is at 07:40.');
    await deliver(text('what about this one?', 'wamid.reply2', { from: '15550009999', id: 'wamid.unknown' }));
    expect(lastTurn()).not.toContain('Reply target');
  });
}, 60_000);

it('Waldo\'s reaction goes out after its reply, on the owner\'s message it answers', async () => {
  await whatsappOwner('wa-react-out', async (deliver, graph) => {
    model.react = 'love';
    await deliver(text('I got the job!', 'wamid.news'));
    const out = sends(graph);
    expect(out.map(call => call.type)).toEqual(['text', 'reaction']);
    expect(out[1]!.reaction).toEqual({ message_id: 'wamid.news', emoji: '❤️' });
  });
}, 60_000);

it('a reply quotes the owner\'s message only when another came in after it', async () => {
  await whatsappOwner('wa-quote-out', async (deliver, graph) => {
    await deliver(text('first question', 'wamid.first'), text('second question', 'wamid.second'));
    const replies = sends(graph).filter(call => call.type === 'text');
    expect(replies).toHaveLength(2);
    expect(replies[0]!.context).toEqual({ message_id: 'wamid.first' });
    expect(replies[1]!.context).toBeUndefined();
    await deliver(text('one more', 'wamid.single'));
    expect(sends(graph).filter(call => call.type === 'text').at(-1)!.context).toBeUndefined();
  });
}, 60_000);

it('a static sticker is read as an image and an animated one gets the honest unsupported reply', async () => {
  await whatsappOwner('wa-sticker', async (deliver, graph) => {
    await deliver({ id: 'wamid.sticker', type: 'sticker', sticker: { id: 'media-sticker', mime_type: 'image/webp', animated: false } });
    expect(lastTurn()).toContain('sticker.webp');
    const before = turns().length;
    await deliver({ id: 'wamid.animated', type: 'sticker', sticker: { id: 'media-animated', mime_type: 'image/webp', animated: true } });
    expect(turns().length).toBe(before);
    expect(sends(graph).some(call => /can read text, photos, documents and voice notes/.test(call.text?.body ?? ''))).toBe(true);
  });
}, 60_000);
