// Meta refuses, for the 24-hour window, a send our own window check let through: at the send itself, or by a failed status
// after it accepted the message. For an owner whose only surface is WhatsApp the final outbox keeps custody of the refused
// record: it waits pending with its id, expiry and receipts, goes out once when the owner writes, and its producer records it
// only once Meta reports it reached the phone, the one evidence a later refusal cannot contradict. One that went stale
// meanwhile expires unsent.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { standingOrderBook } from '../src/channels/standing-orders';
import { updateBook } from '../src/channels/update-cards';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

const CARD = 'The Brief\nOne call at 15:00; keep the morning clear.';
const REPORT = 'Checked the forecast: dry all day.';
const KNOCK = 'template:waldo_update_ready';
const model = vi.hoisted(() => ({ card: null as string | null }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: LLMGatewayRequest) {
    const asked = request.request.messages.at(-1)?.content ?? '';
    const text = asked.includes('[Scheduled card "The Brief"') ? model.card ?? CARD : asked.includes('[Standing order due now') ? REPORT : 'Noted.';
    return { ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d';
const SUBJECT = '15550003333';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
const HOUR = 60 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);
const CARD_ID = () => `day-card:${today()}:card:brief`;

// Meta refuses a text in `refuse` at the send itself with 131047, as when its clock closed the window before ours.
// `knockStall` holds the next template send open until the test releases it, so a request can land while a pass waits on it.
const wire = { events: [] as string[], wamid: 0, refuse: new Set<string>(), knockStall: null as null | { reached: () => void; until: Promise<void> } };
beforeEach(() => {
  model.card = null; wire.events = []; wire.wamid = 0; wire.refuse = new Set(); wire.knockStall = null;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (url === 'https://graph.facebook.com/v21.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; template?: { name: string }; text?: { body: string } };
      if (body.text && wire.refuse.has(body.text.body)) {
        wire.events.push(`refused:${body.text.body}`);
        return Response.json({ error: { message: 'Re-engagement message', type: 'OAuthException', code: 131047 } }, { status: 400 });
      }
      wire.events.push(body.type === 'template' ? `template:${body.template!.name}` : `text:${body.text!.body}`);
      wire.wamid += 1;
      if (body.type === 'template' && wire.knockStall) { const stall = wire.knockStall; wire.knockStall = null; stall.reached(); await stall.until; }
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${wire.wamid}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Record = { id: string; status: string; reason?: string; providerMessageIds?: (string | null)[] };
type Run = { status: string; summary: string | null };

// Unless a test says otherwise the owner last wrote an hour ago, so by our clock the window is open. Today's cards are already
// planned, so the runtime's boot neither plans nor arms them: only what a test schedules fires.
const owned = async (name: string, script: (steps: Readonly<{
  alarms(passes: number): Promise<void>;
  reply(): Promise<void>;
  // Runs the step with the clock moved forward, as when the owner next writes much later.
  later<T>(ms: number, step: () => Promise<T>): Promise<T>;
  card(): Promise<void>;
  order(): Promise<void>;
  // Meta's status callbacks, as the webhook forwards them: a 131047 refusal, evidence the message reached the phone
  // (delivered, read or played), or any other failure.
  status(kind: 'refused' | 'delivered' | 'failed', ids: readonly (string | null)[], at?: number): Promise<void>;
  // The same report, answered without waiting for the owner's queue (which a stalled pass holds).
  report(kind: 'delivered', ids: readonly (string | null)[]): Promise<void>;
  settled(): Promise<void>;
  // The message ids of the one record in the outbox, by part.
  ids(): (string | null)[];
  texts(): string[];
  held(): string[];
  update(): void;
  folded(): number[];
  forget(text: string): Promise<boolean | string>;
  planned(): { sent: boolean; state?: string } | undefined;
  runs(): Run[];
  outbox(): Record[];
}>) => Promise<void>, wrote = HOUR) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    state.storage.kv.put('wa_last_inbound_ms', Date.now() - wrote);
    const plans = dayPlanBook(state.storage.sql);
    for (const card of ['card:brief', 'card:midday', 'card:close'] as const) plans.save(today(), { card, time: null, reason: 'planned by the fixture' });
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const turn = vi.spyOn(owner as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => { wire.events.push('turn'); });
    const records = () => state.storage.kv.get<Record[]>('telegram_final_outbox_v1') ?? [];
    const settled = async () => {
      await Promise.all([...(owner as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
      await (owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(async () => undefined);
    };
    let seq = 0;
    try {
      await script({
        // A queued record falls due 250 ms after it is written, so each pass waits that out. The wake a pass armed is cleared
        // first, so the platform does not run this object's alarm on its own meanwhile.
        alarms: async passes => { for (let pass = 0; pass < passes; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 300)); } },
        reply: async () => {
          seq += 1;
          const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
            method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
            body: JSON.stringify({ messages: [{ from: SUBJECT, id: `wamid.in.${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }] }),
          }));
          expect(response.status).toBe(200);
          await settled();
        },
        later: async (ms, step) => {
          const now = Date.now;
          Date.now = () => now() + ms;
          try { return await step(); } finally { Date.now = now; }
        },
        card: async () => { await scheduler.schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000, recurrence: null }); },
        // A daily order set an hour ago for half an hour ago, so its first run is due now.
        order: async () => {
          const clock = { timezone: 'UTC', now: () => new Date(Date.now() - HOUR) };
          const at = new Date(Date.now() - 30 * 60_000).toISOString().slice(11, 16);
          await standingOrderBook(state.storage.sql, scheduler, clock, () => 'ord1').set({ scope: 'check the forecast', trigger: 'daily', at, gate: 'act_and_report', escalation: 'log_only' });
        },
        status: async (kind, ids, at = Date.now()) => {
          const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-status', {
            method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT }, body: JSON.stringify({ [kind]: ids.map(id => ({ id, at })) }),
          }));
          expect(response.status).toBe(200);
          await settled();
        },
        report: async (kind, ids) => {
          const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-status', {
            method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT }, body: JSON.stringify({ [kind]: ids.map(id => ({ id, at: Date.now() })) }),
          }));
          expect(response.status).toBe(200);
        },
        settled,
        ids: () => { expect(records()).toHaveLength(1); return records()[0]!.providerMessageIds ?? []; },
        texts: () => wire.events.filter(event => event.startsWith('text:')).map(event => event.slice('text:'.length)),
        held: () => [...state.storage.kv.list<{ body: { text: string } }>({ prefix: 'wa_held:' })].map(([, record]) => record.body.text),
        update: () => { updateBook(state.storage.sql).record(today(), Date.now() - 60_000, [{ source: 'calendar', kind: 'added', detail: '{"title":"Lunch"}' }], null); },
        folded: () => state.storage.sql.exec<{ folded: number }>('SELECT folded FROM update_cards ORDER BY id').toArray().map(row => row.folded),
        forget: async text => {
          const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
          memory.add({ kind: 'fact', text, source: 'stated', evidence: `"${text}"`, origin: 'owner' }, new Date().toISOString());
          const runtime = (owner as unknown as { setup(channel: string): { act(input: { action: 'spot.forget'; id: string; value: string }): Promise<boolean | string> } }).setup('whatsapp');
          return runtime.act({ action: 'spot.forget', id: String(memory.claims()[0]!.id), value: '' });
        },
        planned: () => dayPlanBook(state.storage.sql).read(today()).find(row => row.card === 'card:brief'),
        runs: () => state.storage.sql.exec<Run>("SELECT status, summary FROM background_runs WHERE kind = 'standing_order' ORDER BY started_at").toArray(),
        outbox: () => records().map(({ id, status, reason, providerMessageIds }) => ({ id, status, ...(reason ? { reason } : {}), ...(providerMessageIds ? { providerMessageIds } : {}) })),
      });
    } finally { await state.storage.deleteAlarm(); turn.mockRestore(); }
  });
};

// Each alarm pass waits out the 250 ms a queued record takes to fall due, so these run past the 5 s default.
describe('a WhatsApp send Meta refuses for the window our check let through', { timeout: 20_000 }, () => {
  it('a card refused at the send waits in the outbox, goes out once on the reply, and is recorded only when Meta says it arrived', async () => {
    await owned('wa-refused-at-send', async ({ alarms, reply, card, status, ids, texts, held, update, folded, planned, outbox }) => {
      wire.refuse.add(CARD);
      update();
      await card();
      await alarms(3);
      // Meta's refusal closes the window: one knock, and the card stays in the outbox's custody, not the held store.
      expect(wire.events).toEqual([`refused:${CARD}`, KNOCK]);
      expect(held()).toEqual([]);
      expect(outbox()).toEqual([{ id: CARD_ID(), status: 'pending', reason: 'window_refused' }]);
      expect(planned()).toMatchObject({ sent: false });
      expect(folded()).toEqual([0]);
      // Later passes neither send nor knock again while the window is closed.
      await alarms(2);
      expect(wire.events).toEqual([`refused:${CARD}`, KNOCK]);

      wire.refuse.delete(CARD);
      await reply();
      expect(wire.events).toEqual([`refused:${CARD}`, KNOCK, `text:${CARD}`, 'turn']);
      // Meta accepted it; that alone is not a delivery a later refusal could not undo.
      expect(outbox()).toMatchObject([{ id: CARD_ID(), status: 'accepted' }]);
      expect(planned()).toMatchObject({ sent: false });
      expect(folded()).toEqual([0]);

      await status('delivered', ids());
      expect(outbox()).toMatchObject([{ id: CARD_ID(), status: 'delivered' }]);
      expect(planned()).toMatchObject({ sent: true, state: 'sent' });
      expect(folded()).toEqual([1]);
      await alarms(2);
      expect(texts()).toEqual([CARD]);
    });
  });

  it('a card Meta accepted and then refused by status goes back to the outbox, out once on the reply, recorded only on arrival', async () => {
    await owned('wa-refused-by-status', async ({ alarms, reply, card, status, ids, texts, held, update, folded, planned, outbox }) => {
      update();
      await card();
      await alarms(3);
      expect(wire.events).toEqual([`text:${CARD}`]);
      expect(outbox()).toMatchObject([{ id: CARD_ID(), status: 'accepted' }]);
      expect(planned()).toMatchObject({ sent: false });
      expect(folded()).toEqual([0]);

      const [first] = ids();
      await status('refused', [first!]);
      expect(wire.events).toEqual([`text:${CARD}`, KNOCK]);
      expect(held()).toEqual([]);
      expect(outbox()).toMatchObject([{ id: CARD_ID(), status: 'pending', reason: 'window_refused' }]);
      expect(planned()).toMatchObject({ sent: false });
      // Meta delivers status callbacks again; a repeat changes nothing, and passes before the reply send nothing.
      await status('refused', [first!]);
      await alarms(2);
      expect(wire.events).toEqual([`text:${CARD}`, KNOCK]);

      await reply();
      expect(wire.events).toEqual([`text:${CARD}`, KNOCK, `text:${CARD}`, 'turn']);
      const [second] = ids();
      expect(second).not.toBe(first);
      expect(planned()).toMatchObject({ sent: false });

      await status('delivered', [second!]);
      expect(outbox()).toMatchObject([{ id: CARD_ID(), status: 'delivered', providerMessageIds: [second] }]);
      expect(planned()).toMatchObject({ sent: true, state: 'sent' });
      expect(folded()).toEqual([1]);
      // A late copy of the first refusal neither reopens nor resends what arrived.
      await status('refused', [first!]);
      await alarms(2);
      expect(texts()).toEqual([CARD, CARD]);
      expect(outbox()).toMatchObject([{ status: 'delivered' }]);
    });
  });

  it('a standing order\'s run stays running through a refusal after acceptance, and completes only when the report arrives', async () => {
    await owned('wa-refused-order', async ({ alarms, reply, order, status, ids, runs }) => {
      await order();
      await alarms(3);
      expect(wire.events).toEqual([`text:${REPORT}`]);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);

      await status('refused', ids());
      expect(runs()).toEqual([{ status: 'running', summary: null }]);
      await reply();
      expect(wire.events).toEqual([`text:${REPORT}`, KNOCK, `text:${REPORT}`, 'turn']);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);

      await status('delivered', ids());
      expect(runs()).toEqual([{ status: 'completed', summary: 'order reported' }]);
    });
  });

  it.each(['at the send', 'by status'] as const)('a refused card expires unsent when the owner writes only after its day (%s)', async refusal => {
    await owned(`wa-refused-stale-${refusal.replace(' ', '-')}`, async ({ alarms, reply, later, card, status, ids, texts, update, folded, planned, outbox }) => {
      if (refusal === 'at the send') wire.refuse.add(CARD);
      update();
      await card();
      await alarms(3);
      if (refusal === 'by status') await status('refused', ids());
      expect(outbox()).toMatchObject([{ status: 'pending', reason: 'window_refused' }]);

      wire.refuse.delete(CARD);
      await later(24 * HOUR, reply);
      expect(texts()).toEqual(refusal === 'by status' ? [CARD] : []);
      expect(wire.events.at(-1)).toBe('turn');
      expect(outbox()).toMatchObject([{ id: CARD_ID(), status: 'blocked', reason: 'expired' }]);
      expect(planned()).toMatchObject({ sent: false });
      expect(folded()).toEqual([0]);
    });
  });

  it('refusals of a split card\'s parts that arrive out of order still resend the parts in order', async () => {
    const parts = ['a'.repeat(3000), 'b'.repeat(3000)];
    model.card = parts.join('\n\n');
    await owned('wa-refused-split-order', async ({ alarms, reply, card, status, ids, texts, planned }) => {
      await card();
      await alarms(3);
      expect(texts()).toEqual(parts);
      const [head, tail] = ids();
      await status('refused', [tail!]);
      await status('refused', [head!]);
      await reply();
      expect(texts()).toEqual([...parts, ...parts]);
      expect(wire.events.at(-1)).toBe('turn');
      await status('delivered', ids());
      expect(planned()).toMatchObject({ sent: true });
    });
  });

  it('when one part of a split card arrived and the other was refused, the reply resends only the refused part', async () => {
    const parts = ['a'.repeat(3000), 'b'.repeat(3000)];
    model.card = parts.join('\n\n');
    await owned('wa-refused-split-tail', async ({ alarms, reply, card, status, ids, texts, planned, outbox }) => {
      await card();
      await alarms(3);
      const [head, tail] = ids();
      await status('delivered', [head!]);
      expect(planned()).toMatchObject({ sent: false });
      await status('refused', [tail!]);
      await reply();
      expect(texts()).toEqual([...parts, parts[1]]);
      const [kept, resent] = ids();
      expect(kept).toBe(head);
      expect(resent).not.toBe(tail);
      await status('delivered', [resent!]);
      expect(outbox()).toMatchObject([{ status: 'delivered' }]);
      expect(planned()).toMatchObject({ sent: true });
    });
  });

  it('a card the owner forgot something from after Meta accepted it is cancelled, not resent, when Meta then refuses it', async () => {
    await owned('wa-refused-forgotten', async ({ alarms, reply, card, status, ids, texts, forget, planned, outbox }) => {
      await card();
      await alarms(3);
      expect(await forget('keep the morning clear')).toBe(true);
      await status('refused', ids());
      expect(outbox()).toMatchObject([{ id: CARD_ID(), status: 'blocked', reason: 'owner_forget' }]);
      await reply();
      expect(texts()).toEqual([CARD]);
      expect(planned()).toMatchObject({ sent: false });
    });
  });

  it('a card Meta accepted and then failed for another reason ends unsent and is never resent', async () => {
    await owned('wa-failed-other', async ({ alarms, reply, card, status, ids, texts, planned, outbox }) => {
      await card();
      await alarms(3);
      await status('failed', ids());
      expect(outbox()).toMatchObject([{ id: CARD_ID(), status: 'blocked', reason: 'provider_failed' }]);
      expect(planned()).toMatchObject({ sent: false });
      await reply();
      expect(texts()).toEqual([CARD]);
    });
  });

  it('a report Meta accepted but never reports as arrived or refused ends unconfirmed after Meta\'s 30 days, not delivered', async () => {
    await owned('wa-accepted-lapsed', async ({ alarms, later, order, runs, outbox }) => {
      await order();
      await alarms(3);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);
      await later(31 * 24 * HOUR, () => alarms(2));
      expect(outbox()[0]).toMatchObject({ status: 'quarantined', reason: 'delivery_unconfirmed' });
      expect(runs()[0]).toEqual({ status: 'failed', summary: 'order report delivery unconfirmed' });
    });
  });

  it('a card and a report still waiting for Meta\'s report never hold back their next occurrence', async () => {
    await owned('wa-accepted-next', async ({ alarms, later, card, order, outbox, runs }) => {
      await card();
      await order();
      await alarms(4);
      expect(outbox().map(record => record.status)).toEqual(['accepted', 'accepted']);
      // The phone stays off. A day later the next card and the order's next run go ahead (the window has closed by then, so
      // they wait in the outbox for the owner's next message), and the earlier two still wait for their report.
      await later(24 * HOUR + 60_000, async () => { await card(); await alarms(4); });
      expect(outbox().filter(record => record.id.startsWith('day-card:')).map(record => record.status)).toEqual(['accepted', 'pending']);
      expect(outbox().filter(record => record.id.startsWith('standing-order:')).map(record => record.status)).toEqual(['accepted', 'pending']);
      expect(runs()).toEqual([{ status: 'running', summary: null }, { status: 'running', summary: null }]);
    });
  });

  it('an arrival that lands while an alarm pass waits on its knock is kept, and records the card', async () => {
    await owned('wa-arrival-during-knock', async ({ alarms, later, card, order, report, settled, ids, planned, outbox }) => {
      await card();
      await alarms(3);
      const [first] = ids();
      let release!: () => void;
      const reached = new Promise<void>(resolve => { wire.knockStall = { reached: resolve, until: new Promise<void>(go => { release = go; }) }; });
      await later(24 * HOUR, async () => {
        // A day on the window has closed: the order's report waits, and the pass that holds it knocks.
        await order();
        const passes = alarms(4);
        await reached;
        await report('delivered', [first!]);
        release();
        await passes;
        await settled();
      });
      expect(outbox().find(record => record.id.startsWith('day-card:'))).toMatchObject({ status: 'delivered' });
      expect(planned()).toMatchObject({ sent: true, state: 'sent' });
    });
  });

  it('a report that comes after a record has ended changes nothing, however often Meta repeats it', async () => {
    await owned('wa-status-after-end', async ({ alarms, reply, card, status, ids, texts, planned, folded, update, outbox }) => {
      update();
      await card();
      await alarms(3);
      const [first] = ids();
      await status('delivered', [first!]);
      await status('delivered', [first!]);
      expect(outbox()).toMatchObject([{ status: 'delivered' }]);
      expect(folded()).toEqual([1]);
      await status('failed', [first!]);
      await status('refused', [first!]);
      await reply();
      expect(outbox()).toMatchObject([{ status: 'delivered' }]);
      expect(planned()).toMatchObject({ sent: true, state: 'sent' });
      expect(texts()).toEqual([CARD]);
    });
    wire.events = [];
    await owned('wa-status-after-expiry', async ({ alarms, reply, later, card, status, ids, texts, planned, outbox }) => {
      await card();
      await alarms(3);
      const [first] = ids();
      await status('refused', [first!]);
      await later(24 * HOUR, reply);
      expect(outbox()).toMatchObject([{ status: 'blocked', reason: 'expired' }]);
      await later(24 * HOUR, () => status('delivered', [first!]));
      expect(outbox()).toMatchObject([{ status: 'blocked', reason: 'expired' }]);
      expect(planned()).toMatchObject({ sent: false });
      expect(texts()).toEqual([CARD]);
    });
  });
});
