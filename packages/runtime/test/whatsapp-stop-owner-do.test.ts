// The owner's explicit stop on WhatsApp (WHATSAPP_STOP): a typed /stop, the same control Telegram has, stops the running turn
// at once, even while it waits on a long call, and stops the owner's background browser work as Telegram's does. Anything
// else the owner writes meanwhile is the model's to weigh (the second-message desk); no wording is read as a stop. The
// owner's messages still waiting ahead of the /stop are stopped with it; what they write after it runs as usual.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { traceBook } from '../src/channels/harness';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { INTERRUPTED_NOTICES } from '../src/prompt/fixed-lines';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

const LATE = 'Here is your whole week, planned.';
const world = vi.hoisted(() => ({ started: 0, returned: 0, release: () => undefined as void, hold: Promise.resolve() as Promise<void>, sent: [] as { text: string; quote?: string }[], refuseNotice: false }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const reply = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return reply('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    world.started += 1;
    await world.hold;
    world.returned += 1;
    return reply(LATE);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d';
const SUBJECT = '15550009999';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' };

beforeEach(() => {
  world.started = 0; world.returned = 0; world.sent = []; world.refuseNotice = false;
  world.hold = new Promise<void>(resolve => { world.release = resolve; });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; text?: { body: string }; context?: { message_id: string } };
      if (world.refuseNotice && body.text?.body === INTERRUPTED_NOTICES.stopped) return Response.json({ error: { message: 'synthetic refusal', code: 131000 } }, { status: 500 });
      if (body.type === 'text') world.sent.push({ text: body.text!.body, ...(body.context ? { quote: body.context.message_id } : {}) });
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, '') }], messages: [{ id: `wamid.out.${world.sent.length}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { world.release(); vi.unstubAllGlobals(); });

type Owner = InstanceType<typeof OwnerDO>;
const message = (id: string, text: string, forwarded = false) => ({ from: SUBJECT, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...(forwarded ? { context: { forwarded: true } } : {}) });
const owner = (name: string, switches: Record<string, string>, run: (o: Owner, state: DurableObjectState, admit: (m: object) => Promise<number>, stops: () => number) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    await state.storage.put('origin', 'https://waldo.fixture.invalid');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const o = new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', ...switches } as never);
    const stopped = vi.spyOn(o as unknown as { stopOwnerWork(): Promise<void> }, 'stopOwnerWork');
    const admit = async (m: object) => (await o.fetch(new Request('https://telegram-owner/whatsapp-admit', { method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT }, body: JSON.stringify({ messages: [m] }) }))).status;
    try { await run(o, state, admit, () => stopped.mock.calls.length); } finally { world.release(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
// The cut-off turn's model call returns only once released; whatever it would still do has had its chance after this.
const settled = async () => { await vi.waitFor(() => expect(world.returned).toBe(world.started), { timeout: 10_000, interval: 20 }); await new Promise(resolve => setTimeout(resolve, 100)); };
const rows = (state: DurableObjectState) => [...state.storage.kv.list<{ wamid: string; state: string }>({ prefix: 'whatsapp:inbox-record:' })].map(([, row]) => [row.wamid, row.state]);

describe('a typed /stop on WhatsApp', { timeout: 30_000 }, () => {
  it('stops the running turn at once, tells the owner, and the late reply never goes out; /stop runs no turn of its own', async () => {
    await owner('wa-stop-running', { WHATSAPP_STOP: '1' }, async (o, state, admit, stops) => {
      expect(await admit(message('wamid.in.long', 'Plan my whole week in detail'))).toBe(200);
      const draining = drainWhatsAppTurns(o);
      await vi.waitFor(() => expect(world.started).toBe(1), { timeout: 10_000, interval: 20 });
      expect(await admit(message('wamid.in.stop', '/stop'))).toBe(200);
      await vi.waitFor(() => expect(world.sent).toEqual([{ text: INTERRUPTED_NOTICES.stopped, quote: 'wamid.in.long' }]), { timeout: 5_000, interval: 20 });
      expect(stops()).toBe(1);
      // The turn ends now, while its model call is still out: the drain finishes before that call returns.
      await draining;
      expect(world.returned).toBe(0);
      world.release();
      await settled();
      await drainWhatsAppTurns(o);
      expect(world.sent.map(sent => sent.text)).toEqual([INTERRUPTED_NOTICES.stopped]);
      expect(rows(state)).toEqual(expect.arrayContaining([['wamid.in.long', 'interrupted'], ['wamid.in.stop', 'completed']]));
    });
  });

  it('stops the messages waiting behind the running turn, not what the owner writes after the /stop', async () => {
    await owner('wa-stop-queued', { WHATSAPP_STOP: '1' }, async (o, state, admit) => {
      expect(await admit(message('wamid.in.long', 'Plan my whole week in detail'))).toBe(200);
      const draining = drainWhatsAppTurns(o);
      await vi.waitFor(() => expect(world.started).toBe(1), { timeout: 10_000, interval: 20 });
      expect(await admit(message('wamid.in.queued', 'And book the dentist'))).toBe(200);
      expect(await admit(message('wamid.in.stop', '/stop'))).toBe(200);
      await draining;
      expect(await admit(message('wamid.in.after', 'What is on today?'))).toBe(200);
      world.release();
      await settled();
      await drainWhatsAppTurns(o);
      expect(world.started).toBe(2);
      expect(world.sent).toEqual([{ text: INTERRUPTED_NOTICES.stopped, quote: 'wamid.in.long' }, { text: LATE }]);
      expect(rows(state)).toEqual(expect.arrayContaining([['wamid.in.long', 'interrupted'], ['wamid.in.queued', 'revoked'], ['wamid.in.stop', 'completed'], ['wamid.in.after', 'completed']]));
    });
  });

  it('does not stop an approval tap waiting behind the running turn: a decision is not a message, and it still runs', async () => {
    await owner('wa-stop-keeps-tap', { WHATSAPP_STOP: '1' }, async (o, state, admit) => {
      expect(await admit(message('wamid.in.long', 'Plan my whole week in detail'))).toBe(200);
      const draining = drainWhatsAppTurns(o);
      await vi.waitFor(() => expect(world.started).toBe(1), { timeout: 10_000, interval: 20 });
      expect(await admit(message('wamid.in.tap', 'a:synthetic-approval'))).toBe(200);
      expect(await admit(message('wamid.in.stop', '/stop'))).toBe(200);
      await draining;
      expect(rows(state)).toEqual(expect.arrayContaining([['wamid.in.long', 'interrupted'], ['wamid.in.tap', 'completed'], ['wamid.in.stop', 'completed']]));
    });
  });

  it('sent before the turn began stops the waiting message: it never runs, and the owner is told', async () => {
    await owner('wa-stop-before-claim', { WHATSAPP_STOP: '1' }, async (o, state, admit) => {
      expect(await admit(message('wamid.in.long', 'Plan my whole week in detail'))).toBe(200);
      expect(await admit(message('wamid.in.stop', '/stop'))).toBe(200);
      world.release();
      await drainWhatsAppTurns(o);
      expect(world.started).toBe(0);
      await vi.waitFor(() => expect(world.sent).toEqual([{ text: INTERRUPTED_NOTICES.stopped, quote: 'wamid.in.long' }]), { timeout: 5_000, interval: 20 });
      expect(rows(state)).toEqual(expect.arrayContaining([['wamid.in.long', 'revoked'], ['wamid.in.stop', 'completed']]));
    });
  });

  it('still stops, and Meta still gets its 200, when WhatsApp refuses the notice', async () => {
    world.refuseNotice = true;
    await owner('wa-stop-notice-refused', { WHATSAPP_STOP: '1' }, async (o, state, admit) => {
      expect(await admit(message('wamid.in.long', 'Plan my whole week in detail'))).toBe(200);
      const draining = drainWhatsAppTurns(o);
      await vi.waitFor(() => expect(world.started).toBe(1), { timeout: 10_000, interval: 20 });
      expect(await admit(message('wamid.in.stop', '/stop'))).toBe(200);
      await draining;
      world.release();
      await settled();
      await drainWhatsAppTurns(o);
      expect(world.sent).toEqual([]);
      expect(rows(state)).toEqual(expect.arrayContaining([['wamid.in.long', 'interrupted'], ['wamid.in.stop', 'completed']]));
    });
  });

  it('with nothing running stops background work and answers that nothing is running, as before', async () => {
    await owner('wa-stop-idle', { WHATSAPP_STOP: '1' }, async (o, _state, admit, stops) => {
      expect(await admit(message('wamid.in.stop', '/stop'))).toBe(200);
      expect(stops()).toBe(1);
      await drainWhatsAppTurns(o);
      expect(world.sent.map(sent => sent.text)).toEqual(['Nothing is running right now.']);
    });
  });

  it('forwarded, or in other words, stops nothing: other words are the model\'s to weigh', async () => {
    await owner('wa-stop-not-a-control', { WHATSAPP_STOP: '1' }, async (o, state, admit, stops) => {
      expect(await admit(message('wamid.in.long', 'Plan my whole week in detail'))).toBe(200);
      const draining = drainWhatsAppTurns(o);
      await vi.waitFor(() => expect(world.started).toBe(1), { timeout: 10_000, interval: 20 });
      expect(await admit(message('wamid.in.fwd', '/stop', true))).toBe(200);
      expect(await admit(message('wamid.in.words', 'please stop'))).toBe(200);
      expect(stops()).toBe(0);
      expect(world.sent).toEqual([]);
      world.release();
      await draining;
      expect(world.sent.map(sent => sent.text)).toContain(LATE);
      expect(rows(state)).toEqual(expect.arrayContaining([['wamid.in.fwd', 'completed'], ['wamid.in.words', 'completed']]));
      expect(rows(state)).toEqual(expect.arrayContaining([['wamid.in.long', 'completed']]));
    });
  });

  it('with the switch off waits its turn as it always has: the running reply goes out, then nothing is running', async () => {
    await owner('wa-stop-off', { WHATSAPP_STOP: '0' }, async (o, _state, admit, stops) => {
      expect(await admit(message('wamid.in.long', 'Plan my whole week in detail'))).toBe(200);
      const draining = drainWhatsAppTurns(o);
      await vi.waitFor(() => expect(world.started).toBe(1), { timeout: 10_000, interval: 20 });
      expect(await admit(message('wamid.in.stop', '/stop'))).toBe(200);
      expect(stops()).toBe(0);
      world.release();
      await draining;
      await drainWhatsAppTurns(o);
      expect(world.sent.map(sent => sent.text)).toEqual([LATE, 'Nothing is running right now.']);
    });
  });
});
