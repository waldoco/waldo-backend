// One owner timeline across surfaces (WALDO_ONE_TIMELINE): what the owner says on WhatsApp is in the app's next turn and the
// reverse, each row keeps the surface it came from, and each reply goes back where its message was written. The owner object
// stays the one writer, so turns from two surfaces queue on one chain. The model is scripted.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import { traceBook } from '../src/channels/harness';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

const REPLY = 'Noted.';
const SUMMARY = 'Earlier on WhatsApp: the owner trains at the gym at 7 every weekday.';
const model = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const reply = (text: string, tool_calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const,
      data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format?.name === 'claim_ops') return reply('{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    if (request.response_format) return reply(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}');
    if (String(request.system ?? '').startsWith('Summarise the earlier part of this conversation')) return reply(SUMMARY);
    model.asked.push(JSON.stringify(request.messages));
    // The owner asks to forget: the model calls forget_memory once, then answers.
    if (String(request.messages.at(-1)?.content ?? '').includes('Forget everything about Priya') && !request.tool_turns?.length)
      return reply('', [{ call_id: 'forget-priya', name: 'forget_memory', arguments: JSON.stringify({ topic: 'Priya', scope_note: 'my sister' }) }]);
    return reply(REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');
type Owner = InstanceType<typeof OwnerDO>;

const OWNER_ID = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const SUBJECT = '15550006666';
const SESSION = 'b'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
const wire = vi.hoisted(() => ({ whatsappTexts: [] as string[] }));

beforeEach(() => {
  model.asked = []; wire.whatsappTexts = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; text?: { body: string } };
      if (body.type === 'text') wire.whatsappTexts.push(body.text!.body);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${wire.whatsappTexts.length}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

// One owner bound to the app and to WhatsApp.
// `restart` stands in for a new deploy: a fresh owner object on the same storage, with the given switches.
const withOwner = (name: string, switches: Readonly<Record<string, string>>,
  run: (owner: () => Owner, state: DurableObjectState, restart: (next: Readonly<Record<string, string>>) => void) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    const poolAlarm = vi.spyOn(instance as Owner, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    state.storage.kv.put('wa_last_inbound_ms', Date.now() - 60_000);
    state.storage.kv.put('timezone', 'UTC');
    state.storage.kv.put('timezone_confirmed', true);
    await state.storage.put('origin', 'https://fixture.invalid');
    const make = (set: Readonly<Record<string, string>>) => new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, ...set,
      OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' } as never);
    let current = make(switches);
    try { await run(() => current, state, next => { current = make(next); }); }
    finally { await state.storage.deleteAlarm(); poolAlarm.mockRestore(); void (current = make(switches)); }
  });

let wamid = 0;
const saysOnWhatsApp = async (owner: Owner, text: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
    method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
    body: JSON.stringify({ messages: [{ from: SUBJECT, id: `wamid.in.${++wamid}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] }),
  }));
  expect(response.status).toBe(200);
  const sent = wire.whatsappTexts.length;
  await drainWhatsAppTurns(owner);
  expect(wire.whatsappTexts.length).toBe(sent + 1);
};
const appHeaders = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': SESSION, 'content-type': 'application/json' });
const saysInApp = async (owner: Owner, state: DurableObjectState, name: string, text: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: appHeaders(name),
    body: JSON.stringify({ client_message_id: `client-${crypto.randomUUID()}`, text }) }));
  expect(sent.status).toBe(202);
  const { message_id: id } = await sent.json() as { message_id: string };
  await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
};
const appChat = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: appHeaders(name) }));
  expect(response.status).toBe(200);
  return (await response.json() as { messages: { role: string; text: string }[] }).messages.map(({ role, text }) => ({ role, text }));
};
// The rows of the owner's timeline, each with the surface it records.
const timeline = (state: DurableObjectState) => [...state.storage.kv.list<{ role?: string; surface: string; appPayload: string }>({ prefix: 'canonical-owner-v1:' })]
  .map(([, row]) => row).filter(row => row && typeof row === 'object' && 'surface' in row);
const ON = { WALDO_ONE_TIMELINE: '1' } as const;

describe('one owner timeline across the app and WhatsApp', { timeout: 30_000 }, () => {
  it('what the owner said on WhatsApp is in the app\'s next turn, from a chain that starts empty', async () => {
    const name = 'one-timeline-wa-to-app';
    await withOwner(name, ON, async (owner, state) => {
      await saysOnWhatsApp(owner(), 'My sister Priya lands Thursday at 6pm.');
      await saysInApp(owner(), state, name, 'When does she land?');
      expect(model.asked.at(-1)).toContain('My sister Priya lands Thursday at 6pm.');
    });
  });

  it('what the owner said in the app is in the next WhatsApp turn', async () => {
    const name = 'one-timeline-app-to-wa';
    await withOwner(name, ON, async (owner, state) => {
      await saysInApp(owner(), state, name, 'The plumber comes Friday at 9.');
      await saysOnWhatsApp(owner(), 'When is the plumber coming?');
      expect(model.asked.at(-1)).toContain('The plumber comes Friday at 9.');
    });
  });

  it('each row keeps the surface it was written on, and each reply goes back where its message came from', async () => {
    const name = 'one-timeline-surfaces';
    await withOwner(name, ON, async (owner, state) => {
      await saysOnWhatsApp(owner(), 'Book the dentist.');
      await saysInApp(owner(), state, name, 'Also call the bank.');
      const rows = timeline(state);
      expect(rows.find(row => row.appPayload === 'Book the dentist.')?.surface).toBe('whatsapp');
      expect(rows.find(row => row.appPayload === 'Also call the bank.')?.surface).toBe('app');
      expect(wire.whatsappTexts).toEqual([REPLY]);
      expect((await appChat(owner(), name)).filter(message => message.role === 'assistant')).toHaveLength(2);
    });
  });

  it('messages on both surfaces at once are answered once each, on one chain the owner object writes in turn', async () => {
    const name = 'one-timeline-concurrent';
    await withOwner(name, ON, async (owner, state) => {
      await Promise.all([saysOnWhatsApp(owner(), 'First from WhatsApp.'), saysInApp(owner(), state, name, 'First from the app.')]);
      expect(wire.whatsappTexts).toEqual([REPLY]);
      const said = timeline(state).filter(row => row.role === 'user').map(row => row.appPayload).sort();
      expect(said).toEqual(['First from WhatsApp.', 'First from the app.']);
      expect(model.asked.at(-1)).toMatch(/First from WhatsApp\.[\s\S]*First from the app\.|First from the app\.[\s\S]*First from WhatsApp\./);
    });
  });

  it('the cutover is forward-only: the WhatsApp chain from before stays stored, and reaches the timeline once, through one summary the next turn reads', async () => {
    const name = 'one-timeline-cutover';
    await withOwner(name, {}, async (owner, state, restart) => {
      await saysOnWhatsApp(owner(), 'My gym is at 7 every weekday.');
      const legacy = [...state.storage.kv.list({ prefix: 'conv:' })];
      expect(legacy.length).toBeGreaterThan(0);
      restart({ ...ON, WALDO_COMPACTION: 'on' });
      await saysInApp(owner(), state, name, 'What does my week look like?');
      await owner().alarm().catch(() => undefined);
      expect([...state.storage.kv.list({ prefix: 'conv:' })]).toEqual(legacy);
      const seeds = timeline(state).filter(row => row.role === 'compaction');
      expect(seeds).toHaveLength(1);
      expect(timeline(state).some(row => row.role !== 'compaction' && row.appPayload === 'My gym is at 7 every weekday.')).toBe(false);
      await saysInApp(owner(), state, name, 'And on Friday?');
      expect(model.asked.at(-1)).toContain(SUMMARY);
      // Once carried, the earlier chain is not carried again.
      await owner().alarm().catch(() => undefined);
      expect(timeline(state).filter(row => row.role === 'compaction')).toHaveLength(1);
    });
  });

  it('an owner who only writes on WhatsApp gets the same carry-over: their next WhatsApp turn reads the summary of their chain from before', async () => {
    const name = 'one-timeline-cutover-whatsapp';
    await withOwner(name, {}, async (owner, state, restart) => {
      await saysOnWhatsApp(owner(), 'My gym is at 7 every weekday.');
      const legacy = [...state.storage.kv.list({ prefix: 'conv:' })];
      restart({ ...ON, WALDO_COMPACTION: 'on' });
      await saysOnWhatsApp(owner(), 'Plan my week.');
      expect([...state.storage.kv.list({ prefix: 'conv:' })]).toEqual(legacy);
      expect(timeline(state).filter(row => row.role === 'compaction')).toHaveLength(1);
      await saysOnWhatsApp(owner(), 'And Friday?');
      expect(model.asked.at(-1)).toContain(SUMMARY);
    });
  });

  it('a forget asked for in the app clears what was said on WhatsApp from every later turn, on either surface', async () => {
    const name = 'one-timeline-forget';
    await withOwner(name, ON, async (owner, state) => {
      await saysOnWhatsApp(owner(), 'My sister Priya lands Thursday at 6pm.');
      await saysInApp(owner(), state, name, 'Forget everything about Priya.');
      await saysOnWhatsApp(owner(), 'What is on Thursday?');
      expect(model.asked.at(-1)).toContain('What is on Thursday?');
      expect(model.asked.at(-1)).not.toContain('Priya');
      expect(timeline(state).some(row => row.appPayload.includes('Priya'))).toBe(false);
    });
  });

  it('with the switch off, the two surfaces keep their own chains as before', async () => {
    const name = 'one-timeline-off';
    await withOwner(name, {}, async (owner, state) => {
      await saysOnWhatsApp(owner(), 'My sister Priya lands Thursday at 6pm.');
      await saysInApp(owner(), state, name, 'When does she land?');
      expect(model.asked.at(-1)).not.toContain('Priya lands Thursday');
    });
  });
});
