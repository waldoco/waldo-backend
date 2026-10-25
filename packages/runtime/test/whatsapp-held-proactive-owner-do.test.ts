// Scheduled cards and reports for an owner whose only surface is WhatsApp, through the real scheduler, final outbox and window
// layer. While the 24-hour window is closed nothing is recorded as delivered: a day card or a standing-order report waits in
// the outbox, goes out once on the owner's reply, and is recorded only when Meta reports it reached the phone; one that went
// stale meanwhile expires unsent; an update card is not written at all.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardExpiry, dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { loopBook } from '../src/channels/loops';
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
const UPDATE = 'Lunch moved to 13:00.';
// Counts the job turns by the prompt each one opens with; the runtime's other model calls answer 'Noted.'.
// slowReportMs moves the clock on while a report turn runs, as a turn that browses for minutes does.
// reportOnce: later runs of the order find nothing to report, so they queue nothing.
const model = vi.hoisted(() => ({ cards: 0, reports: 0, updates: 0, slowReportMs: 0, reportOnce: false }));
const realNow = Date.now;
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: LLMGatewayRequest) {
    const asked = request.request.messages.at(-1)?.content ?? '';
    const text = asked.includes('[Scheduled card "The Brief"') ? (model.cards += 1, CARD)
      : asked.includes('[Standing order due now') ? (model.reports += 1, model.slowReportMs && ((shift: number) => { const before = Date.now; Date.now = () => before() + shift; })(model.slowReportMs), model.reportOnce && model.reports > 1 ? '' : REPORT)
        : asked.includes('[Update check,') ? (model.updates += 1, UPDATE) : 'Noted.';
    return { ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const calendar = vi.hoisted(() => ({ changed: false }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (...args: Parameters<typeof original.googleClient>) => args[0].clientId !== 'held-fixture' ? original.googleClient(...args) : ({
    changedEvents: async () => calendar.changed ? [{ id: 'lunch', title: 'Lunch', start: '2026-10-17T13:00:00Z', end: '2026-10-17T14:00:00Z', all_day: false, status: 'confirmed', created: '2026-10-01T08:00:00Z' }] : [],
    newMail: async () => [], events: async () => [],
  }) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SUBJECT = '15550002222';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
const HOUR = 60 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);

const wire = { events: [] as string[], wamid: 0 };
beforeEach(() => {
  model.cards = 0; model.reports = 0; model.updates = 0; model.slowReportMs = 0; model.reportOnce = false; Date.now = realNow; calendar.changed = false; wire.events = []; wire.wamid = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; template?: { name: string }; text?: { body: string } };
      wire.events.push(body.type === 'template' ? `template:${body.template!.name}` : `text:${body.text!.body}`);
      wire.wamid += 1;
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, '') }], messages: [{ id: `wamid.out.${wire.wamid}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); Date.now = realNow; });

type Outbox = { id: string; status: string; reason?: string }[];
type Run = { status: string; summary: string | null };

// Unless a test says otherwise the owner last wrote 30 hours ago, so the window is closed. Today's cards are already planned,
// so the runtime's boot neither plans nor arms them: only what a test schedules fires.
const owned = async (name: string, script: (steps: Readonly<{
  alarms(passes: number): Promise<void>;
  // Quiet hours from an hour ago to an hour from now, or none.
  quiet(on: boolean): void;
  reply(): Promise<void>;
  // A fresh object over the same storage, as after the platform evicts it: its constructor and boot run again.
  restart(): void;
  // Runs the step with the clock moved forward, as when the owner next writes much later.
  later<T>(ms: number, step: () => Promise<T>): Promise<T>;
  card(): Promise<void>;
  // Arms the Check-in this far ahead; answers when it is due.
  checkIn(ms: number): Promise<number>;
  // Daily unless a cron expression is given.
  order(cron?: string, id?: string): Promise<void>;
  refireOrder(): Promise<void>;
  expiry(): number | undefined;
  // A calendar change no card has covered yet, and whether a card has folded it in.
  update(): void;
  folded(): number[];
  // The owner forgets something from the console, a pattern or a spot; answers the action's result.
  // The Midday card falls due now, as a card that is queued and then armed again later does.
  midday(): Promise<void>;
  expiryOf(card: string): number | undefined;
  forget(kind: 'node' | 'spot', text: string): Promise<boolean | string>;
  planned(): { sent: boolean; state?: string } | undefined;
  // Marks the Brief held for quiet hours, as a crash between queuing it and recording it waiting leaves it.
  markHeld(): void;
  runs(): Run[];
  outbox(): Outbox;
  // Meta reports that every message it accepted reached the owner's phone.
  arrived(): Promise<void>;
}>) => Promise<void>, wrote = 30 * HOUR) => {
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
    const turns: { mockRestore(): void }[] = [];
    const build = () => {
      const built = new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
      turns.push(vi.spyOn(built as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => { wire.events.push('turn'); }));
      return built;
    };
    let owner = build();
    let seq = 0;
    try {
      await script({
        // A queued record falls due 250 ms after it is written, so each pass waits that out. The wake a pass armed is cleared
        // first, so the platform does not run this object's alarm on its own meanwhile.
        alarms: async passes => { for (let pass = 0; pass < passes; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 300)); } },
        quiet: on => {
          const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
          loopBook(state.storage.sql, { newId: () => 'fixture', now: Date.now }).setProactivity({ volume: 'normal', quiet_start: on ? clock(Date.now() - HOUR) : null, quiet_end: on ? clock(Date.now() + HOUR) : null });
        },
        reply: async () => {
          seq += 1;
          const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
            method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
            body: JSON.stringify({ messages: [{ from: SUBJECT, id: `wamid.in.${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }] }),
          }));
          expect(response.status).toBe(200);
          await Promise.all([...(owner as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
        },
        restart: () => { owner = build(); },
        later: async (ms, step) => {
          const now = Date.now;
          Date.now = () => now() + ms;
          try { return await step(); } finally { Date.now = now; }
        },
        card: async () => { await scheduler.schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000, recurrence: null }); },
        checkIn: async ms => {
          const at = Date.now() + ms;
          await scheduler.schedule({ id: 'card:midday', kind: 'brief', payloadRefs: { id: 'card:midday' }, occurrenceAt: at, dueAt: at, recurrence: null });
          return at;
        },
        // A daily order set an hour ago for half an hour ago, so its first run is due now.
        order: async (cron, id = 'ord1') => {
          const clock = { timezone: 'UTC', now: () => new Date(Date.now() - HOUR) };
          const at = new Date(Date.now() - 30 * 60_000).toISOString().slice(11, 16);
          await standingOrderBook(state.storage.sql, scheduler, clock, () => id).set(cron
            ? { scope: 'check the forecast', trigger: 'cron', cron, gate: 'act_and_report', escalation: 'log_only' }
            : { scope: 'check the forecast', trigger: 'daily', at, gate: 'act_and_report', escalation: 'log_only' });
        },
        // Arms the order again for the occurrence whose report is queued.
        refireOrder: async () => {
          const records = state.storage.kv.get<{ id: string }[]>('telegram_final_outbox_v1') ?? [];
          const occurrence = Number(/^standing-order:order:ord1:(\d+)$/.exec(records[0]?.id ?? '')?.[1]);
          const { recurrence } = scheduler.read('order:ord1')!;
          await scheduler.schedule({ id: 'order:ord1', kind: 'standing_order', payloadRefs: { order_id: 'order:ord1' }, occurrenceAt: occurrence, dueAt: occurrence, recurrence });
        },
        midday: async () => { await scheduler.schedule({ id: 'card:midday', kind: 'brief', payloadRefs: { id: 'card:midday' }, occurrenceAt: Date.now() - 120_000, dueAt: Date.now() - 120_000, recurrence: null }); },
        expiryOf: card => (state.storage.kv.get<{ id: string; expiresAt?: number }[]>('telegram_final_outbox_v1') ?? []).find(record => record.id === `day-card:${today()}:${card}`)?.expiresAt,
        planned: () => dayPlanBook(state.storage.sql).read(today()).find(row => row.card === 'card:brief'),
        markHeld: () => { dayPlanBook(state.storage.sql).held(today(), 'card:brief'); },
        runs: () => state.storage.sql.exec<Run>("SELECT status, summary FROM background_runs WHERE kind = 'standing_order' ORDER BY started_at").toArray(),
        outbox: () => (state.storage.kv.get<Outbox>('telegram_final_outbox_v1') ?? []).map(({ id, status, reason }) => ({ id, status, ...(reason ? { reason } : {}) })),
        expiry: () => state.storage.kv.get<{ expiresAt?: number }[]>('telegram_final_outbox_v1')?.[0]?.expiresAt,
        update: () => { updateBook(state.storage.sql).record(today(), Date.now() - 60_000, [{ source: 'calendar', kind: 'added', detail: '{"title":"Lunch"}' }], null); },
        folded: () => state.storage.sql.exec<{ folded: number }>('SELECT folded FROM update_cards ORDER BY id').toArray().map(row => row.folded),
        forget: async (kind, text) => {
          const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
          if (kind === 'node') state.storage.sql.exec("INSERT INTO constellation_nodes(domain,label,summary,strength,status,first_seen,last_confirmed,supporting_spots) VALUES ('work',?,'synthetic',0.5,'active','now','now','[]')", text);
          else memory.add({ kind: 'fact', text, source: 'stated', evidence: `"${text}"`, origin: 'owner' }, new Date().toISOString());
          const id = kind === 'node' ? memory.nodes().find(row => row.label === text)!.id : memory.claims()[0]!.id;
          const runtime = (owner as unknown as { setup(channel: string): { act(input: { action: 'node.forget' | 'spot.forget'; id: string; value: string }): Promise<boolean | string> } }).setup('whatsapp');
          return runtime.act({ action: `${kind}.forget`, id: String(id), value: '' });
        },
        arrived: async () => {
          const ids = (state.storage.kv.get<{ status: string; providerMessageIds?: (string | null)[] }[]>('telegram_final_outbox_v1') ?? [])
            .filter(record => record.status === 'accepted').flatMap(record => record.providerMessageIds ?? []).filter((id): id is string => !!id);
          const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-status', {
            method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT }, body: JSON.stringify({ delivered: ids.map(id => ({ id, at: Date.now() })) }) }));
          expect(response.status).toBe(200);
          await (owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(async () => undefined);
        },
      });
    } finally { await state.storage.deleteAlarm(); for (const turn of turns) turn.mockRestore(); }
  });
};

// Each alarm pass waits out the 250 ms a queued record takes to fall due, so these run past the 5 s default.
describe('scheduled cards and reports for a WhatsApp-only owner', { timeout: 20_000 }, () => {
  it('waits a day card in the outbox with one knock, and records it sent only when the reply delivers it, once', async () => {
    await owned('wa-held-day-card', async ({ alarms, reply, arrived, card, checkIn, planned, outbox, expiry, update, folded }) => {
      const nextCard = await checkIn(10 * 60_000);
      update();
      await card();
      await alarms(3);
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      expect(model.cards).toBe(1);
      expect(planned()).toMatchObject({ sent: false });
      expect(folded()).toEqual([0]);
      expect(outbox()).toEqual([{ id: `day-card:${today()}:card:brief`, status: 'pending' }]);
      // It is current until the Check-in is due (or the day ends, if that comes first).
      expect(expiry()).toBe(Math.min(Date.parse(`${today()}T00:00:00Z`) + 24 * HOUR, nextCard));
      // Later passes neither knock again, nor send, nor write the card again, even when the card is armed again that day.
      await card();
      await alarms(3);
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      expect(model.cards).toBe(1);
      expect(outbox()).toHaveLength(1);

      await reply();
      expect(wire.events).toEqual(['template:waldo_update_ready', `text:${CARD}`, 'turn']);
      // Meta accepted it; it is recorded once Meta reports it reached the phone.
      expect(planned()).toMatchObject({ sent: false });
      expect(outbox()).toEqual([{ id: `day-card:${today()}:card:brief`, status: 'accepted' }]);
      await arrived();
      expect(planned()).toMatchObject({ sent: true, state: 'sent' });
      expect(folded()).toEqual([1]);
      expect(outbox()).toEqual([{ id: `day-card:${today()}:card:brief`, status: 'delivered' }]);
      await alarms(2);
      expect(wire.events.filter(event => event === `text:${CARD}`)).toHaveLength(1);
    });
  });

  it('leaves a card that is already queued out of the next-card bound, so arming it again never shortens another card', async () => {
    await owned('wa-queued-card-rearmed', async ({ alarms, midday, card, checkIn, expiryOf }) => {
      await midday();
      await alarms(1);
      expect(expiryOf('card:midday')).toBeDefined();
      // The queued Midday card is armed again for later today (a pin, a retry or a crash leaves it so); it will write nothing.
      await checkIn(10 * 60_000);
      await card();
      await alarms(3);
      expect(expiryOf('card:brief')).toBe(Date.parse(`${today()}T00:00:00Z`) + 24 * HOUR);
    });
  });

  it('sends a day card and a standing-order report on the next alarm while the window is open, and records each as it goes', async () => {
    await owned('wa-open-window-jobs', async ({ alarms, arrived, card, order, planned, runs, outbox }) => {
      await card();
      await order();
      await alarms(4);
      expect([...wire.events].sort()).toEqual([`text:${CARD}`, `text:${REPORT}`].sort());
      expect(outbox().map(record => record.status)).toEqual(['accepted', 'accepted']);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);
      await arrived();
      expect(planned()).toMatchObject({ sent: true, state: 'sent' });
      expect(runs()).toEqual([{ status: 'completed', summary: 'order reported' }]);
      expect(outbox().map(record => record.status)).toEqual(['delivered', 'delivered']);
    }, HOUR);
  });

  it('stops counting a card as held for quiet hours once it is queued after their end, so the heartbeat does not fire it again', async () => {
    await owned('wa-held-day-card-after-quiet', async ({ alarms, card, quiet, planned, outbox }) => {
      quiet(true);
      await card();
      await alarms(2);
      expect(planned()).toMatchObject({ sent: false, state: 'held' });
      expect(model.cards).toBe(0);
      // Quiet hours end, and the heartbeat's release arms the card again.
      quiet(false);
      await card();
      await alarms(3);
      expect(model.cards).toBe(1);
      expect(outbox()).toMatchObject([{ status: 'pending' }]);
      expect(planned()).toMatchObject({ sent: false, state: 'pending' });
    });
  });

  it('lets a day card expire unsent when the owner writes only after its day, instead of sending it late', async () => {
    await owned('wa-held-day-card-stale', async ({ alarms, reply, later, card, planned, outbox, update, folded }) => {
      update();
      await card();
      await alarms(3);
      expect(outbox()).toMatchObject([{ status: 'pending' }]);

      await later(24 * HOUR, reply);
      expect(wire.events).toEqual(['template:waldo_update_ready', 'turn']);
      expect(planned()).toMatchObject({ sent: false });
      // What the card covered stays for the next card.
      expect(folded()).toEqual([0]);
      expect(outbox()).toEqual([{ id: `day-card:${today()}:card:brief`, status: 'blocked', reason: 'expired' }]);
    });
  });

  it.each(['node', 'spot'] as const)('never sends a waiting day card that carries something the owner then forgot (%s)', async kind => {
    await owned(`wa-held-day-card-forget-${kind}`, async ({ alarms, reply, card, planned, outbox, forget }) => {
      await card();
      await alarms(3);
      expect(outbox()).toMatchObject([{ status: 'pending' }]);

      expect(await forget(kind, 'keep the morning clear')).toBe(true);
      expect(outbox()).toEqual([{ id: `day-card:${today()}:card:brief`, status: 'blocked', reason: 'owner_forget' }]);
      await reply();
      expect(wire.events).toEqual(['template:waldo_update_ready', 'turn']);
      expect(planned()).toMatchObject({ sent: false });
    });
  });

  it('waits a standing-order report in the outbox and finishes the order\'s run only when the reply delivers it', async () => {
    await owned('wa-held-order', async ({ alarms, reply, arrived, order, refireOrder, runs, outbox }) => {
      await order();
      await alarms(3);
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      expect(model.reports).toBe(1);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);
      expect(outbox()).toEqual([{ id: expect.stringMatching(/^standing-order:order:ord1:\d+$/), status: 'pending' }]);
      // A retry of the same occurrence, as after a crash, finds the report waiting and does not run the order again.
      await refireOrder();
      await alarms(3);
      expect(model.reports).toBe(1);
      expect(runs()).toHaveLength(1);

      await reply();
      expect(wire.events).toEqual(['template:waldo_update_ready', `text:${REPORT}`, 'turn']);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);
      await arrived();
      expect(runs()).toEqual([{ status: 'completed', summary: 'order reported' }]);
    });
  });

  it('delivers the report of an order whose turn outlasts its period, and completes its run', async () => {
    await owned('wa-late-order', async ({ alarms, arrived, order, runs, outbox }) => {
      // An every-minute order whose report turn takes two minutes: the report is written after the order's next slot.
      model.slowReportMs = 2 * 60_000;
      await order('* * * * *');
      await alarms(4);
      expect(model.reports).toBeGreaterThanOrEqual(1);
      expect(wire.events).toContain(`text:${REPORT}`);
      expect(runs().length).toBe(model.reports);
      expect(new Set(outbox().map(record => record.status))).toEqual(new Set(['accepted']));
      await arrived();
      expect(new Set(runs().map(run => `${run.status}: ${run.summary}`))).toEqual(new Set(['completed: order reported']));
      expect(new Set(outbox().map(record => record.status))).toEqual(new Set(['delivered']));
    }, HOUR);
  });

  it('replaces a report still waiting when the order reports again: the older one is never sent and its run stops', async () => {
    await owned('wa-superseded-order', async ({ alarms, reply, arrived, later, order, runs, outbox }) => {
      await order();
      await alarms(3);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);
      // The next run, a day later, with the window still closed.
      await later(24 * HOUR + 60_000, () => alarms(4));
      expect(model.reports).toBe(2);
      expect(outbox().map(record => [record.status, record.reason])).toEqual([['blocked', 'superseded'], ['pending', undefined]]);
      expect(runs()).toEqual([{ status: 'stopped', summary: 'order ran; a newer report replaced this one' }, { status: 'running', summary: null }]);

      await later(24 * HOUR + 120_000, async () => {
        await reply();
        expect(wire.events.filter(event => event === `text:${REPORT}`)).toHaveLength(1);
        expect(runs().map(run => run.status)).toEqual(['stopped', 'running']);
        await arrived();
      });
      expect(runs().map(run => run.status)).toEqual(['stopped', 'completed']);
    });
  });

  it('lets one order\'s report replace only that order\'s waiting report', async () => {
    await owned('wa-two-orders', async ({ alarms, order, runs, outbox }) => {
      await order(undefined, 'ord1');
      await order(undefined, 'ord2');
      await alarms(5);
      expect(model.reports).toBe(2);
      expect(outbox().map(record => record.status)).toEqual(['pending', 'pending']);
      expect(runs().map(run => run.status)).toEqual(['running', 'running']);
    });
  });

  it('ends a report the owner never answers at the 30-day cap, on the alarm alone', async () => {
    await owned('wa-order-cap', async ({ alarms, later, order, runs, outbox }) => {
      model.reportOnce = true;
      await order();
      await alarms(3);
      // A month on, the day's own cards wait too; only the report is followed here.
      const report = () => outbox().filter(record => record.id.startsWith('standing-order:'));
      await later(29 * 24 * HOUR, () => alarms(2));
      expect(report()).toMatchObject([{ status: 'pending' }]);
      await later(30 * 24 * HOUR + 60_000, () => alarms(2));
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      expect(report()).toMatchObject([{ status: 'blocked', reason: 'lapsed' }]);
      expect(runs()[0]).toEqual({ status: 'stopped', summary: 'order ran; its report waited 30 days for your WhatsApp window and was not sent' });
    });
  });

  it('leaves a report that was delivered alone when the order reports again', async () => {
    await owned('wa-delivered-then-next', async ({ alarms, reply, arrived, later, order, runs, outbox }) => {
      await order();
      await alarms(4);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);
      await arrived();
      expect(runs()).toEqual([{ status: 'completed', summary: 'order reported' }]);
      await later(24 * HOUR + 60_000, async () => {
        await reply(); await alarms(4);
        expect(outbox().map(record => record.status)).toEqual(['delivered', 'accepted']);
        await arrived();
      });
      expect(outbox().map(record => record.status)).toEqual(['delivered', 'delivered']);
      expect(runs()).toEqual([{ status: 'completed', summary: 'order reported' }, { status: 'completed', summary: 'order reported' }]);
    }, HOUR);
  });

  it('keeps a queued card reading as waiting when it is re-armed into quiet hours', async () => {
    await owned('wa-queued-card-quiet', async ({ alarms, card, quiet, planned, markHeld, outbox }) => {
      await card();
      await alarms(3);
      expect(outbox()).toMatchObject([{ status: 'pending' }]);
      markHeld();
      quiet(true);
      await card();
      await alarms(2);
      expect(model.cards).toBe(1);
      expect(planned()).toMatchObject({ sent: false, state: 'pending' });
    });
  });

  it('does not fail an order whose report is queued when a later step throws; the report still settles its run', async () => {
    await owned('wa-order-queued-then-throw', async ({ alarms, reply, arrived, order, runs }) => {
      const rearm = Scheduler.prototype.rearm;
      let thrown = false;
      const spy = vi.spyOn(Scheduler.prototype, 'rearm').mockImplementation(async function (this: Scheduler, ...args: Parameters<Scheduler['rearm']>) {
        if (!thrown && model.reports === 1) { thrown = true; throw new Error('storage hiccup'); }
        return rearm.apply(this, args);
      });
      try {
        await order();
        await alarms(3);
      } finally { spy.mockRestore(); }
      expect(thrown).toBe(true);
      expect(model.reports).toBe(1);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);
      await reply();
      expect(wire.events.filter(event => event === `text:${REPORT}`)).toHaveLength(1);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);
      await arrived();
      expect(runs()).toEqual([{ status: 'completed', summary: 'order reported' }]);
    });
  });

  it('keeps a card and a report waiting across a restart, then delivers and records each once', async () => {
    await owned('wa-held-restart', async ({ alarms, reply, arrived, restart, card, order, planned, runs, outbox }) => {
      await card();
      await order();
      await alarms(4);
      expect(outbox().map(record => record.status)).toEqual(['pending', 'pending']);

      restart();
      await alarms(2);
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      expect(planned()).toMatchObject({ sent: false });
      expect(runs()).toEqual([{ status: 'running', summary: null }]);

      await reply();
      expect(wire.events.slice(1, 3).sort()).toEqual([`text:${CARD}`, `text:${REPORT}`].sort());
      expect(wire.events.slice(3)).toEqual(['turn']);
      await arrived();
      expect(planned()).toMatchObject({ sent: true, state: 'sent' });
      expect(runs()).toEqual([{ status: 'completed', summary: 'order reported' }]);
      expect([model.cards, model.reports]).toEqual([1, 1]);
    });
  });

  it('keeps a waiting report current until the order reports again: a reply a day later, before any newer report, gets it', async () => {
    await owned('wa-held-order-later-reply', async ({ alarms, reply, arrived, later, order, runs, outbox }) => {
      await order();
      await alarms(3);
      expect(runs()).toEqual([{ status: 'running', summary: null }]);

      await later(25 * HOUR, async () => {
        await reply();
        expect(wire.events).toEqual(['template:waldo_update_ready', `text:${REPORT}`, 'turn']);
        expect(runs()).toEqual([{ status: 'running', summary: null }]);
        await arrived();
      });
      expect(runs()).toEqual([{ status: 'completed', summary: 'order reported' }]);
      expect(outbox()).toMatchObject([{ status: 'delivered' }]);
    });
  });

  it.each([
    ['closed', 30 * HOUR, 0],
    ['open', HOUR, 1],
  ] as const)('writes an update card only while the window is open (%s)', async (window, wrote, sent) => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`wa-update-${window}`)), async (_instance, state) => {
      claimStore(state.storage.sql);
      ensureSchema(state.storage);
      traceBook(state.storage.sql);
      state.storage.kv.put('do_name', `wa-update-${window}`);
      state.storage.kv.put('whatsapp_subject', SUBJECT);
      state.storage.kv.put('wa_last_inbound_ms', Date.now() - wrote);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'fixture', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      const owner = new OwnerDO(state, { ...env, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined,
        GOOGLE_CLIENT_ID: 'held-fixture', GOOGLE_CLIENT_SECRET: 'fixture' });
      const runtime = (owner as unknown as { setup(channel: string): { updateCheck(trace: string): Promise<void> } }).setup('whatsapp');
      try {
        await runtime.updateCheck('seed');
        calendar.changed = true;
        await runtime.updateCheck('changed');
        expect(model.updates).toBe(sent);
        expect(wire.events.filter(event => event.startsWith('text:'))).toEqual(sent ? [expect.stringContaining(UPDATE)] : []);
        // The change is kept either way; only a card that reached the owner is recorded as pushed.
        expect(state.storage.sql.exec<{ pushed: number }>('SELECT pushed FROM update_cards ORDER BY id').toArray()).toEqual([{ pushed: sent }]);
      } finally { await state.storage.deleteAlarm(); }
    });
  });
});

describe('a waiting day card goes stale', () => {
  const at = (iso: string) => Date.parse(iso);
  it('when the owner\'s next card is due, since that card covers the same day with newer facts', () => {
    expect(cardExpiry(at('2026-10-17T08:00:00Z'), 'UTC', [at('2026-10-17T14:00:00Z'), at('2026-10-17T21:30:00Z')])).toBe(at('2026-10-17T14:00:00Z'));
  });
  it('at the end of its own day when no later card is due that day', () => {
    expect(cardExpiry(at('2026-10-17T21:30:00Z'), 'UTC', [])).toBe(at('2026-10-18T00:00:00Z'));
    expect(cardExpiry(at('2026-10-17T21:30:00Z'), 'UTC', [at('2026-10-18T08:00:00Z')])).toBe(at('2026-10-18T00:00:00Z'));
    expect(cardExpiry(at('2026-10-17T16:00:00Z'), 'Asia/Kolkata', [])).toBe(at('2026-10-17T18:30:00Z'));
  });
  it('never by a card due before it', () => {
    expect(cardExpiry(at('2026-10-17T14:00:00Z'), 'UTC', [at('2026-10-17T08:00:00Z')])).toBe(at('2026-10-18T00:00:00Z'));
  });
});

describe('owner forget reaches day cards and standing-order reports in the outbox', () => {
  it('cancels a waiting one, scrubs a delivered one and leaves other records alone', async () => {
    const { TelegramFinalOutbox, redactJobReportEntries, FINAL_OUTBOX_KEY } = await import('../src/channels/telegram-final-outbox');
    const values = new Map<string, unknown>();
    const kv = { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined, put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); } };
    const forgotten = 'the harbour fund';
    const outbox = new TelegramFinalOutbox(kv, () => 1000);
    const base = { trace: 'fixture', payload: { chat_id: 42, text: `Today: ${forgotten}.` }, ownerSubject: '42', doName: 'owner' };
    await outbox.enqueue({ ...base, id: 'card', dayCard: { day: '2026-10-17', card: 'card:brief', foldUpTo: 900 } });
    await outbox.enqueue({ ...base, id: 'report', standingOrder: { runId: 'run', gate: 'act_and_report' } });
    await outbox.enqueue({ ...base, id: 'delivered-card', dayCard: { day: '2026-10-16', card: 'card:close', foldUpTo: 800 } });
    await outbox.enqueue({ ...base, id: 'reply' });
    const rows = outbox.records(); rows[2]!.status = 'delivered'; rows[2]!.settled = true; kv.put(FINAL_OUTBOX_KEY, rows);

    expect(redactJobReportEntries(kv, [forgotten], '[forgotten]')).toEqual({ rewritten: 3, remaining: 0 });
    expect(new TelegramFinalOutbox(kv).records().map(({ id, status, reason, payload }) => ({ id, status, reason, text: payload.text }))).toEqual([
      { id: 'card', status: 'blocked', reason: 'owner_forget', text: 'Today: [forgotten].' },
      { id: 'report', status: 'blocked', reason: 'owner_forget', text: 'Today: [forgotten].' },
      { id: 'delivered-card', status: 'delivered', reason: undefined, text: 'Today: [forgotten].' },
      { id: 'reply', status: 'pending', reason: undefined, text: `Today: ${forgotten}.` },
    ]);
  });
});
