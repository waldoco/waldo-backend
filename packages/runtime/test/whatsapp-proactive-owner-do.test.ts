// Scheduled work for an owner whose only surface is WhatsApp, through the real alarm, scheduler and final outbox. Outside
// the 24-hour window the reminder waits in the outbox, the owner gets one approved template, and nothing is retried or
// reported as failed; the owner's reply delivers it before that reply's own turn, or drops it if it was cancelled meanwhile.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_NOW_ONLY } from '../src/channels/delivery-routes';
import { traceBook } from '../src/channels/harness';
import { reminderBook } from '../src/channels/reminders';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

const REMINDER_TEXT = 'Time to call Sam.';
// Counts the reminder turns only; the day plan the runtime boots also calls the model.
const model = vi.hoisted(() => ({ reminders: 0, reminderText: null as string | null }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    const sent = JSON.stringify(request);
    if (sent.includes('Reminder due now')) model.reminders += 1;
    return { ok: true as const, data: { model: request.request.model, text: sent.includes('Reminder due now') ? model.reminderText ?? REMINDER_TEXT : 'Noted.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const SUBJECT = '15550001111';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };

// `stall` holds one text send open until the test releases it, so another request can overlap it; `reached` says the send
// has started and is waiting.
const wire = { events: [] as string[], other: [] as string[], wamid: 0, stall: null as null | { text: string; until: Promise<void>; reached: () => void } };
beforeEach(() => {
  model.reminders = 0; model.reminderText = null; wire.events = []; wire.other = []; wire.wamid = 0; wire.stall = null;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (url === 'https://graph.facebook.com/v21.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; template?: { name: string }; text?: { body: string } };
      wire.events.push(body.type === 'template' ? `template:${body.template!.name}` : `text:${body.text!.body}`);
      wire.wamid += 1;
      if (wire.stall && body.text?.body === wire.stall.text) { wire.stall.reached(); await wire.stall.until; }
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${wire.wamid}` }] });
    }
    wire.other.push(url);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Outbox = { id: string; status: string; reason?: string; providerMessageIds?: (string | null)[] }[];

const drive = async (name: string, script: (steps: Readonly<{
  alarms(passes: number): Promise<void>;
  reply(): Promise<void>;
  cancel(): Promise<void>;
  refuse(id: string, at?: number): Promise<number>;
  sendNowOnly(text: string): Promise<unknown>;
  hold(texts: string[]): void;
  replyStarted(sentAt?: number): Promise<void>;
  stall(text: string): Readonly<{ reached: Promise<void>; release: () => void }>;
  settled(): Promise<void>;
  held(): string[];
  ledger(): Readonly<{ runs: { outcome: string; delivery: string | null }[]; outbox: Outbox; notes: number; notices: number; scheduled: { status: string; attempts: number }[] }>;
}>) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    traceBook(state.storage.sql);
    const clockBack = (ms: number) => () => new Date(Date.now() - ms);
    const book = reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: clockBack(3_600_000) }, () => 'rem-1');
    const reminder = await book.set({ note: 'call Sam', at: clockBack(30 * 60_000)().toISOString().slice(0, 16), repeat: 'none' });
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    // The owner last wrote 30 hours ago, so WhatsApp's 24-hour window is closed.
    state.storage.kv.put('wa_last_inbound_ms', Date.now() - 30 * 60 * 60_000);
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const turn = vi.spyOn(owner as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => { wire.events.push('turn'); });
    let seq = 0;
    try {
      await script({
        // A queued record falls due 250 ms after it is written, so each pass waits that out before the next. The wake a pass
        // armed is cleared first, so the platform does not run this object's alarm on its own instance meanwhile.
        alarms: async passes => { for (let pass = 0; pass < passes; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 300)); } },
        reply: async () => {
          seq += 1;
          const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
            method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
            body: JSON.stringify({ messages: [{ from: SUBJECT, id: `wamid.in.${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }] }),
          }));
          expect(response.status).toBe(200);
          await Promise.all([...(owner as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
        },
        cancel: async () => { expect(await book.cancel(reminder.id)).toBe(true); },
        hold: texts => texts.forEach((text, index) => state.storage.kv.put(`wa_held:${String(index + 1).padStart(12, '0')}`, { heldAt: Date.now(), body: { chat_id: Number(SUBJECT), text } })),
        // The owner's message is admitted and its turn's work starts in the background, as after the webhook's ack.
        stall: text => {
          let release!: () => void, reached!: () => void;
          const started = new Promise<void>(resolve => { reached = resolve; });
          wire.stall = { text, until: new Promise<void>(resolve => { release = resolve; }), reached };
          return { reached: started, release };
        },
        // A send time past now is clamped to receipt time, so `sentAt` can make a message newer than one sent this second.
        replyStarted: async (sentAt = Date.now()) => {
          seq += 1;
          const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
            method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
            body: JSON.stringify({ messages: [{ from: SUBJECT, id: `wamid.in.${seq}`, timestamp: String(Math.floor(sentAt / 1000)), type: 'text', text: { body: 'hi' } }] }),
          }));
          expect(response.status).toBe(200);
        },
        settled: async () => {
          await Promise.all([...(owner as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
          await (owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(async () => undefined);
        },
        // The owner runtime's own call stack (routing, link redaction, egress gate, window layer, shim).
        sendNowOnly: async text => {
          const runtime = (owner as unknown as { setup(channel: string): { call(method: string, body: object): Promise<unknown>; owner: number } }).setup('whatsapp');
          return runtime.call('sendMessage', { chat_id: runtime.owner, text, [SEND_NOW_ONLY]: true });
        },
        held: () => [...state.storage.kv.list<{ body: { text: string } }>({ prefix: 'wa_held:' })].map(([, record]) => record.body.text),
        refuse: async (id, at = Date.now()) => (await owner.fetch(new Request('https://telegram-owner/whatsapp-status', {
          method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT }, body: JSON.stringify({ refused: [{ id, at }] }),
        }))).status,
        ledger: () => ({
          runs: state.storage.sql.exec<{ outcome: string; delivery: string | null }>('SELECT outcome, delivery FROM schedule_runs WHERE schedule_id = ? ORDER BY id', reminder.id).toArray(),
          outbox: (state.storage.kv.get<Outbox>('telegram_final_outbox_v1') ?? []).map(({ id, status, reason, providerMessageIds }) => ({ id, status, ...(reason ? { reason } : {}), ...(providerMessageIds ? { providerMessageIds } : {}) })),
          notes: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reminder_notes WHERE id = ?', reminder.id).one().n,
          notices: (state.storage.kv.get<Outbox>('telegram_final_outbox_v1') ?? []).filter(row => row.id.startsWith('schedule-failed:')).length,
          scheduled: state.storage.sql.exec<{ status: string; attempts: number }>('SELECT status, attempts FROM schedule WHERE id = ?', reminder.id).toArray(),
        }),
      });
    } finally { await state.storage.deleteAlarm(); turn.mockRestore(); }
  });
};

// Each alarm pass waits out the 250 ms a queued record takes to fall due, so these run past the 5 s default.
describe('a WhatsApp-only owner outside the 24-hour window', { timeout: 20_000 }, () => {
  it('holds a due reminder with one template knock, never retries or reports it, and delivers it on the reply before that turn', async () => {
    await drive('whatsapp-only-reminder', async ({ alarms, reply, ledger }) => {
      await alarms(3);
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      expect(model.reminders).toBe(1);
      expect(ledger()).toMatchObject({
        runs: [{ outcome: 'running', delivery: 'pending' }],
        outbox: [{ id: expect.stringMatching(/^reminder:/), status: 'pending' }],
        notes: 1, notices: 0,
      });
      // Later passes neither knock again, nor send, nor run the reminder again.
      await alarms(3);
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      expect(model.reminders).toBe(1);
      expect(ledger().runs).toHaveLength(1);

      await reply();
      expect(wire.events).toEqual(['template:waldo_update_ready', `text:${REMINDER_TEXT}`, 'turn']);
      expect(ledger()).toMatchObject({
        runs: [{ outcome: 'ok', delivery: 'sent' }],
        outbox: [{ id: expect.stringMatching(/^reminder:/), status: 'delivered', providerMessageIds: ['wamid.out.2'] }],
        notes: 0, notices: 0,
      });
      expect(wire.other).toEqual([]);
    });
  });

  it('never knocks for a reminder the owner cancelled before its first send', async () => {
    await drive('whatsapp-only-cancelled-early', async ({ alarms, cancel, ledger }) => {
      await alarms(1);
      expect(ledger().outbox).toMatchObject([{ id: expect.stringMatching(/^reminder:/), status: 'pending' }]);
      await cancel();
      await alarms(3);
      expect(wire.events).toEqual([]);
      expect(ledger().outbox).toMatchObject([{ status: 'blocked' }]);
    });
  });

  it('drops a held reminder the owner cancelled before replying', async () => {
    await drive('whatsapp-only-cancelled', async ({ alarms, reply, cancel, ledger }) => {
      await alarms(3);
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      await cancel();
      await reply();
      expect(wire.events).toEqual(['template:waldo_update_ready', 'turn']);
      expect(ledger()).toMatchObject({ outbox: [{ id: expect.stringMatching(/^reminder:/), status: 'blocked' }], notices: 0 });
      expect(ledger().runs.map(run => run.outcome)).not.toContain('quarantined');
    });
  });

  it('sends a due reminder at once while the window is open, with an honest WhatsApp receipt', async () => {
    await drive('whatsapp-only-open-window', async ({ alarms, reply, ledger }) => {
      await reply();
      wire.events = [];
      await alarms(3);
      expect(wire.events).toEqual([`text:${REMINDER_TEXT}`]);
      expect(ledger()).toMatchObject({
        runs: [{ outcome: 'ok', delivery: 'sent' }],
        outbox: [{ id: expect.stringMatching(/^reminder:/), status: 'delivered', providerMessageIds: ['wamid.out.1'] }],
        notes: 0,
      });
    });
  });

  it('a reminder Meta refuses after accepting it closes the window, knocks once, and goes out again on the reply', async () => {
    await drive('whatsapp-only-late-refusal', async ({ alarms, reply, refuse, settled, ledger }) => {
      await reply();
      await alarms(3);
      expect(wire.events).toEqual(['turn', `text:${REMINDER_TEXT}`]);
      expect(await refuse('wamid.out.1')).toBe(200);
      expect(await refuse('wamid.out.1')).toBe(200);
      // The knock runs in the owner's serial queue, after the acknowledgement.
      await settled();
      expect(wire.events).toEqual(['turn', `text:${REMINDER_TEXT}`, 'template:waldo_update_ready']);
      await reply();
      expect(wire.events).toEqual(['turn', `text:${REMINDER_TEXT}`, 'template:waldo_update_ready', `text:${REMINDER_TEXT}`, 'turn']);
      expect(ledger().notices).toBe(0);
    });
  });

  it('refuses a status callback for a subject this owner is not bound to', async () => {
    await drive('whatsapp-only-foreign-status', async () => {
      const response = await env.OWNER_DO!.get(env.OWNER_DO!.idFromName('whatsapp-only-foreign-status')).fetch(new Request('https://telegram-owner/whatsapp-status', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15559999999' }, body: JSON.stringify({ refused: [{ id: 'wamid.x', at: null }] }),
      }));
      expect(response.status).toBe(403);
      expect(wire.events).toEqual([]);
    });
  });

  it('a one-time code outside the window is refused through the owner runtime, never held, with one knock', async () => {
    await drive('whatsapp-only-now-only', async ({ sendNowOnly, held }) => {
      expect(await sendNowOnly('From bank:\nCode: 482913')).toBeUndefined();
      expect(held()).toEqual([]);
      expect(wire.events).toEqual(['template:waldo_update_ready']);
    });
  });

  it('a status callback during the reply\'s held delivery sends each held message exactly once', async () => {
    await drive('whatsapp-only-held-race', async ({ hold, stall, replyStarted, refuse, settled }) => {
      hold(['one', 'two']);
      const { reached, release } = stall('one');
      await replyStarted();
      // The reply's pass is waiting on the send of 'one' when Meta's status callback arrives; its refusal predates the reply.
      await reached;
      expect(await refuse('wamid.unknown', 0)).toBe(200);
      release();
      await settled();
      expect(wire.events.filter(event => event.startsWith('text:'))).toEqual(['text:one', 'text:two']);
      expect(wire.events.at(-1)).toBe('turn');
    });
  });

  it('a refusal that closes the window while the queue is busy does not knock once the owner has written again; the next closure knocks', async () => {
    await drive('whatsapp-only-late-knock', async ({ hold, stall, replyStarted, refuse, settled }) => {
      hold(['one']);
      const { reached, release } = stall('one');
      await replyStarted();
      await reached;
      // Meta refuses a send: the window closes and a knock is due, but the queue is busy with the reply's delivery. The refusal
      // is a second past the admitted message, which is dated to its whole second, so it closes the window whatever the clock reads.
      expect(await refuse('wamid.refused.1', Date.now() + 1_000)).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 5));
      // The owner writes again before the knock runs, which reopens the window.
      await replyStarted(Date.now() + 1_000);
      release();
      await settled();
      expect(wire.events.filter(event => event.startsWith('template:'))).toEqual([]);
      // The next closure of this window still knocks, once.
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(await refuse('wamid.refused.2', Date.now())).toBe(200);
      await settled();
      expect(wire.events.filter(event => event.startsWith('template:'))).toEqual(['template:waldo_update_ready']);
    });
  });

  it('a late refusal of each part of a split reminder holds every refused part, and the reply delivers them in order', async () => {
    const parts = ['a'.repeat(3000), 'b'.repeat(3000)];
    model.reminderText = parts.join('\n\n');
    await drive('whatsapp-only-split-refusal', async ({ alarms, reply, refuse, settled, held }) => {
      await reply();
      await alarms(3);
      expect(wire.events.filter(event => event.startsWith('text:'))).toEqual(parts.map(part => `text:${part}`));
      expect(await refuse('wamid.out.1')).toBe(200);
      expect(await refuse('wamid.out.2')).toBe(200);
      await settled();
      expect(held()).toEqual(parts);
      wire.events = [];
      await reply();
      expect(wire.events).toEqual([...parts.map(part => `text:${part}`), 'turn']);
    });
  });
});
