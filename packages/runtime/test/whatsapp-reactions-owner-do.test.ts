// WhatsApp reactions, quoted replies and stickers through the owner object's real admission path. The owner's reaction on
// a message Waldo sent waits for their next turn as one line and starts nothing; a swipe-reply to Waldo's message reaches
// the turn as the guarded quote, authored by Waldo; Waldo's own reaction goes out after its reply, on the message it
// answers; a reply quotes the owner's message only when a later one came in after it; a static sticker is read as an image.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { reactedNote } from '../src/channels/owner-turn';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

type RequestBody = { tools?: { name?: string }[]; input: string | { type?: string; call_id?: string }[]; text?: { format?: { name?: string } } };
// plan: the reaction calls the model makes in a turn, one per round, before it answers in words.
const model = vi.hoisted(() => ({ requests: [] as RequestBody[], react: null as string | null, plan: [] as { reaction: string; delivery?: string }[] }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const results = Array.isArray(body.input) ? body.input.filter(item => item.type === 'function_call_output') : [];
    const reacted = results.some(item => item.call_id === 'react');
    const offered = body.tools?.some(tool => tool.name === 'react_to_message');
    const planned = !format && offered ? model.plan[results.length] : undefined;
    const output = planned
      ? [{ type: 'function_call', call_id: `plan-${results.length}`, name: 'react_to_message', arguments: JSON.stringify(planned) }]
      : !format && model.react && offered && !reacted
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

beforeEach(() => { model.requests = []; model.react = null; model.plan = []; graphRefuses.reaction = false; });
// Meta refusing every reaction (a closed window, an outage), as an error answer.
const graphRefuses = { reaction: false };

const whatsappOwner = (name: string, run: (deliver: (...messages: Record<string, unknown>[]) => Promise<void>, graph: GraphCall[], owner: OwnerDO) => Promise<void>) =>
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
        if (body.type === 'reaction' && graphRefuses.reaction) return Response.json({ error: { code: 131047, message: 'Re-engagement message' } }, { status: 400 });
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
      await drainWhatsAppTurns(instance);
    };
    try { await run(deliver, graph, instance); } finally { network.mockRestore(); await state.storage.deleteAlarm(); }
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

it.each([['🎉', '🎉'], ['love', '❤️']])('Waldo\'s reaction %s goes out after its reply as %s, on the owner\'s message it answers', async (chosen, emoji) => {
  await whatsappOwner(`wa-react-out-${emoji}`, async (deliver, graph) => {
    model.react = chosen;
    await deliver(text('I got the job!', 'wamid.news'));
    expect(lastTurn()).toContain('Reactions: available.');
    const out = sends(graph);
    expect(out.map(call => call.type)).toEqual(['text', 'reaction']);
    expect(out[1]!.reaction).toEqual({ message_id: 'wamid.news', emoji });
  });
}, 60_000);

it('a reply quotes the owner\'s message only when another came in after it', async () => {
  await whatsappOwner('wa-quote-out', async (deliver, graph) => {
    // Two texts in a row would be one turn, so the later message is a photo: two turns, two replies.
    await deliver(text('first question', 'wamid.first'), { id: 'wamid.second', type: 'sticker', sticker: { id: 'media-sticker', mime_type: 'image/webp', animated: false } });
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
    expect(lastMessage()).toContain('data:image/webp;base64,');
    const before = turns().length;
    await deliver({ id: 'wamid.animated', type: 'sticker', sticker: { id: 'media-animated', mime_type: 'image/webp', animated: true } });
    expect(turns().length).toBe(before);
    expect(sends(graph).some(call => /can read text, photos, documents and voice notes/.test(call.text?.body ?? ''))).toBe(true);
  });
}, 60_000);

it('a message the delivery outbox sent (an app message copied to WhatsApp, a Brief, a reminder) can be reacted to and swipe-replied to', async () => {
  await whatsappOwner('wa-outbox-react', async (deliver, graph, owner) => {
    await deliver(text('hi', 'wamid.hi'));
    await (owner as unknown as { queueWhatsAppCopy(id: string, text: string, appAt: number): Promise<void> }).queueWhatsAppCopy('wa-copy:brief', 'Three meetings today; the 4pm moved to 5.', Date.now());
    // Queued records fall due 250 ms after they are written; the owner's next message releases what is due.
    await new Promise(resolve => setTimeout(resolve, 300));
    await deliver(text('ok', 'wamid.ok'));
    const copyId = `wamid.out.${graph.findIndex(call => call.text?.body.startsWith('Three meetings')) + 1}`;
    expect(copyId).not.toBe('wamid.out.0');
    await deliver({ id: 'wamid.react.copy', type: 'reaction', reaction: { message_id: copyId, emoji: '🙏' } });
    await deliver(text('can you push the 5pm too?', 'wamid.reply.copy', { from: '15550009999', id: copyId }));
    expect(lastMessage()).toContain('[Owner reacted 🙏 to your message: \\"Three meetings today; the 4pm moved to 5.');
    expect(lastTurn()).toContain('Transport-observed author: waldo; forwarded: false.');
  });
}, 60_000);

it('a "thanks" answered by a reaction alone sends only the reaction, and the next turn reads that Waldo answered with it', async () => {
  await whatsappOwner('wa-react-alone', async (deliver, graph) => {
    model.plan = [{ reaction: '🙏', delivery: 'instead_of_reply' }];
    await deliver(text('thanks!', 'wamid.thanks'));
    expect(sends(graph)).toEqual([expect.objectContaining({ type: 'reaction', reaction: { message_id: 'wamid.thanks', emoji: '🙏' } })]);
    // The closing round made no second model call for words.
    expect(turns()).toHaveLength(1);
    model.plan = [];
    await deliver(text('when is my train?', 'wamid.next'));
    // Later turns read the reaction as a reaction, never as a bare emoji Waldo wrote.
    const input = turns().at(-1)!.input;
    const answers = (Array.isArray(input) ? input : []).filter(item => (item as { role?: string }).role === 'assistant').map(item => JSON.stringify(item));
    expect(answers.some(answer => answer.includes(reactedNote('🙏')))).toBe(true);
  });
}, 60_000);

it('a long turn reacts at once, then answers, and the reaction is sent once', async () => {
  await whatsappOwner('wa-react-now', async (deliver, graph) => {
    model.plan = [{ reaction: '👀', delivery: 'now' }, { reaction: '👀', delivery: 'now' }];
    await deliver(text('find me a train for tomorrow', 'wamid.slow'));
    expect(sends(graph).map(call => call.type)).toEqual(['reaction', 'text']);
    expect(sends(graph)[0]!.reaction).toEqual({ message_id: 'wamid.slow', emoji: '👀' });
  });
}, 60_000);

it('a question answered in words sends the words, and a reaction only if the model chose one', async () => {
  await whatsappOwner('wa-react-words', async (deliver, graph) => {
    await deliver(text('when is my train?', 'wamid.q'));
    expect(sends(graph).map(call => call.type)).toEqual(['text']);
  });
}, 60_000);

it('a reaction sent now and then made the whole answer goes once, and a redelivered message runs no second turn', async () => {
  await whatsappOwner('wa-react-replay', async (deliver, graph) => {
    model.plan = [{ reaction: '👍', delivery: 'now' }, { reaction: '👍', delivery: 'instead_of_reply' }];
    await deliver(text('ok, done', 'wamid.ok'));
    await deliver(text('ok, done', 'wamid.ok'));
    expect(sends(graph)).toEqual([expect.objectContaining({ type: 'reaction', reaction: { message_id: 'wamid.ok', emoji: '👍' } })]);
  });
}, 60_000);

it('a reaction Meta refuses leaves nothing behind: sent now, the turn still answers in words and never retries it', async () => {
  await whatsappOwner('wa-react-refused-now', async (deliver, graph) => {
    graphRefuses.reaction = true;
    model.plan = [{ reaction: '👀', delivery: 'now' }, { reaction: '👀', delivery: 'now' }];
    await deliver(text('find me a train for tomorrow', 'wamid.slow'));
    expect(sends(graph).map(call => call.type)).toEqual(['text']);
    // The model heard that the reaction did not go, and the second call was refused without a send.
    expect(lastTurn()).toContain('\\"queued\\":false,\\"reason\\":\\"unavailable\\"');
    graphRefuses.reaction = false;
    model.plan = [{ reaction: '🙏', delivery: 'instead_of_reply' }];
    await deliver(text('thanks!', 'wamid.thanks'));
    expect(sends(graph).at(-1)).toEqual(expect.objectContaining({ type: 'reaction', reaction: { message_id: 'wamid.thanks', emoji: '🙏' } }));
  });
}, 60_000);

it('a reaction Meta refuses as the whole answer ends the turn without its reply: the owner gets the one check-first notice', async () => {
  await whatsappOwner('wa-react-refused-alone', async (deliver, graph) => {
    graphRefuses.reaction = true;
    model.plan = [{ reaction: '🙏', delivery: 'instead_of_reply' }];
    await deliver(text('thanks!', 'wamid.thanks'));
    const out = sends(graph);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(expect.objectContaining({ type: 'text', context: { message_id: 'wamid.thanks' } }));
    expect(out[0]!.text!.body).not.toContain('🙏');
  });
}, 60_000);
