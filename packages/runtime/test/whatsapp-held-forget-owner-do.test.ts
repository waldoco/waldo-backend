// Owner forget reaches a heartbeat check-back or a reminder that waits in the outbox for a WhatsApp-only owner whose 24-hour
// window is closed, through the real scheduler, final outbox and window layer, from each of the four places a forget runs:
// the console's spot and pattern forgets, the forget tool in an owner turn, and a forget finished at the owner's next turn.
// The waiting copy ends blocked and scrubbed and is never sent; its job ends stopped, not failed; the reminder itself stays.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { HEARTBEAT_EVERY_MS, HEARTBEAT_ID } from '../src/channels/heartbeat';
import { loopBook } from '../src/channels/loops';
import { reminderBook } from '../src/channels/reminders';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { runBook } from '../src/channels/background-runs';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { jobBook } from '../src/tasks/jobs';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// The forgotten literal comes only from what the model wrote, never from the loop title or the reminder note: a loop whose
// title carried it would be dropped by the purge, and the outbox would then refuse the check-back for that reason instead.
const SECRET = 'harbour fund';
const CHECK_BACK = `The quarterly numbers are still open; the ${SECRET} draft is in your inbox.`;
const REMINDER = `Time to send the quarterly numbers; the ${SECRET} draft is ready.`;
const model = vi.hoisted(() => ({ checkBacks: 0, reminders: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: LLMGatewayRequest) {
    const reply = (text: string, tool_calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const,
      data: { model: request.request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.request.response_format) return reply('{}');
    const asked = JSON.stringify(request.request.messages.at(-1)?.content ?? '');
    if (asked.includes('[Check-back due now')) { model.checkBacks += 1; return reply(CHECK_BACK); }
    if (asked.includes('Reminder due now')) { model.reminders += 1; return reply(REMINDER); }
    if (asked.includes(`forget the ${SECRET}`) && !request.request.tool_turns?.length) {
      return reply('', [{ call_id: 'forget', name: 'forget_memory', arguments: JSON.stringify({ topic: SECRET, scope_note: 'the fund' }) }]);
    }
    return reply('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
// The owner's message sends what waited before its own turn runs. The in-chat forgets below hold that back, so their forget
// meets the check-back still waiting.
const release = vi.hoisted(() => ({ held: false }));
vi.mock('../src/channels/whatsapp-window', async load => {
  const original = await load<typeof import('../src/channels/whatsapp-window')>();
  return { ...original, releaseWhatsAppOutbox: (...args: Parameters<typeof original.releaseWhatsAppOutbox>) => release.held ? Promise.resolve() : original.releaseWhatsAppOutbox(...args) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const SUBJECT = '15550003333';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
const HOUR = 60 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);

const wire = { events: [] as string[], wamid: 0, unlinked: false };
beforeEach(() => {
  model.checkBacks = 0; model.reminders = 0; release.held = false; wire.events = []; wire.wamid = 0; wire.unlinked = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    // The directory's WhatsApp presence: active until the owner unlinks it from the console.
    if (fn === 'assert_channel_presence') return Response.json(!wire.unlinked);
    if (fn === 'presence_hint') return Response.json(!wire.unlinked && String(init?.body).includes('"p_provider":"whatsapp"') ? '1111' : null);
    if (fn === 'unlink_presence') { wire.unlinked = true; return Response.json(true); }
    if (fn === 'health_context_read') return Response.json(null);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; template?: { name: string }; text?: { body: string } };
      wire.events.push(body.type === 'template' ? `template:${body.template!.name}` : `text:${body.text!.body}`);
      wire.wamid += 1;
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, '') }], messages: [{ id: `wamid.out.${wire.wamid}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Row = { id: string; status: string; reason?: string; payload: { text: string } };
type Steps = Readonly<{
  alarms(passes: number): Promise<void>;
  // The owner writes on WhatsApp, which opens the window; `turn` runs the message's real turn instead of a stand-in.
  write(text: string, turn?: boolean): Promise<void>;
  // A past-due loop and the heartbeat tick due now.
  heartbeat(): Promise<void>;
  // A reminder due now, one-off or daily; answers its id.
  reminder(repeat: 'none' | 'daily'): Promise<string>;
  forget(kind: 'node' | 'spot', text: string): Promise<boolean | string>;
  // Meta's report on every message it accepted: it reached the phone, or it was refused for the closed window.
  report(kind: 'delivered' | 'refused'): Promise<void>;
  // The owner unlinks WhatsApp from the console.
  unlink(): Promise<void>;
  // Every record in the outbox was queued this long ago, so the window has stayed closed that long without the clock moving.
  age(ms: number): void;
  remember(text: string, status?: 'purging'): void;
  outbox(): Row[];
  // The job's background run and the scheduler's run row for the occurrence that ran. The heartbeat's interval sits on the
  // clock's half hours, so a test that crosses one also records the occurrence it skipped as missed; that row is left out.
  job(kind: 'heartbeat' | 'reminder'): Readonly<{ run: { status: string; summary: string | null }[]; scheduled: { outcome: string; delivery: string | null }[] }>;
  note(id: string): string | null;
  armed(id: string): boolean;
  cancel(id: string): Promise<void>;
  // Claims the owner's memory still holds, by status.
  claims(status?: 'purging'): string[];
  // Forget topics still waiting for a verified purge.
  heldTopics(): string[];
  // A background task whose brief carries the text, and the status of every task.
  task(text: string): void;
  tasks(): { status: string; cancel_reason: string | null }[];
}>;

// Unless a test writes, the owner last wrote 30 hours ago, so the window is closed. Today's cards are already planned, so the
// runtime's boot neither plans nor arms them: only what a test schedules fires.
const owned = async (name: string, script: (steps: Steps) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    state.storage.kv.put('wa_last_inbound_ms', Date.now() - 30 * HOUR);
    const plans = dayPlanBook(state.storage.sql);
    for (const card of ['card:brief', 'card:midday', 'card:close'] as const) plans.save(today(), { card, time: null, reason: 'planned by the fixture' });
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    const loops = loopBook(state.storage.sql, { newId: () => 'fixture', now: Date.now });
    const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const internals = owner as unknown as { turn(...args: unknown[]): Promise<void>; whatsappInflight: Set<Promise<void>>; serial(work: () => Promise<void>): Promise<void>;
      setup(channel: string): { act(input: { action: 'node.forget' | 'spot.forget'; id: string; value: string }): Promise<boolean | string> } };
    const realTurn = internals.turn.bind(owner);
    let runTurn = false;
    const turns = vi.spyOn(internals, 'turn').mockImplementation(async (...args: unknown[]) => { wire.events.push('turn'); if (runTurn) await realTurn(...args); });
    let seq = 0;
    try {
      await script({
        // A queued record falls due 250 ms after it is written, so each pass waits that out. The wake a pass armed is cleared
        // first, so the platform does not run this object's alarm on its own meanwhile.
        alarms: async passes => { for (let pass = 0; pass < passes; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 300)); } },
        write: async (text, turn = false) => {
          seq += 1; runTurn = turn;
          const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
            method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
            body: JSON.stringify({ messages: [{ from: SUBJECT, id: `wamid.in.${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] }),
          }));
          expect(response.status).toBe(200);
          await Promise.all([...internals.whatsappInflight]);
          await internals.serial(async () => undefined);
          runTurn = false;
        },
        heartbeat: async () => {
          loops.open({ title: 'Send the quarterly numbers', due: new Date(Date.now() - HOUR).toISOString().slice(0, 16) });
          await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', payloadRefs: { id: HEARTBEAT_ID }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000,
            recurrence: { type: 'interval', every_ms: HEARTBEAT_EVERY_MS, phase_ms: 0 } });
        },
        reminder: async repeat => {
          const clock = { timezone: 'UTC', now: () => new Date(Date.now() - HOUR) };
          const set = await reminderBook(state.storage.sql, scheduler, clock, () => `rem-${repeat}`).set({ note: 'send the quarterly numbers', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16), repeat });
          return set.id;
        },
        forget: async (kind, text) => {
          if (kind === 'node') state.storage.sql.exec("INSERT INTO constellation_nodes(domain,label,summary,strength,status,first_seen,last_confirmed,supporting_spots) VALUES ('work',?,'synthetic',0.5,'active','now','now','[]')", text);
          else memory.add({ kind: 'fact', text, source: 'stated', evidence: `"${text}"`, origin: 'owner' }, new Date().toISOString());
          const id = kind === 'node' ? memory.nodes().find(row => row.label === text)!.id : memory.claims().find(row => row.text === text)!.id;
          return internals.setup('whatsapp').act({ action: `${kind}.forget`, id: String(id), value: '' });
        },
        report: async kind => {
          const ids = (state.storage.kv.get<{ status: string; providerMessageIds?: (string | null)[] }[]>('telegram_final_outbox_v1') ?? [])
            .filter(record => record.status === 'accepted').flatMap(record => record.providerMessageIds ?? []).filter((id): id is string => !!id);
          expect(ids.length).toBeGreaterThan(0);
          const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-status', {
            method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT }, body: JSON.stringify({ [kind]: ids.map(id => ({ id, at: Date.now() })) }) }));
          expect(response.status).toBe(200);
          await internals.serial(async () => undefined);
        },
        // The console's controls build the Telegram runtime, which needs a bot token; it is lent for this step only.
        unlink: async () => {
          const settings = (owner as unknown as { env: Record<string, unknown> }).env;
          settings.TELEGRAM_BOT_TOKEN = '123:synthetic';
          try {
            const cookie = { cookie: 'waldo_console=' + await consoleAccess(state.storage).grant() };
            const read = await owner.fetch(new Request('https://telegram-owner' + CONTROLS_PATH + '?view=connections', { headers: cookie }));
            const { csrf, revision } = await read.json() as { csrf: string; revision: string };
            const response = await owner.fetch(new Request('https://telegram-owner' + CONTROL_ACTION_PATH, { method: 'POST', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ csrf, revision, view: 'connections', action: 'whatsapp.unlink', request_id: 'wa-unlink-forget' }) }));
            expect(await response.json()).toMatchObject({ receipt: { state: 'recorded' } });
          } finally { settings.TELEGRAM_BOT_TOKEN = undefined; }
          await internals.serial(async () => undefined);
        },
        age: ms => {
          const rows = state.storage.kv.get<{ createdAt: number; dueAt: number }[]>('telegram_final_outbox_v1') ?? [];
          state.storage.kv.put('telegram_final_outbox_v1', rows.map(row => ({ ...row, createdAt: row.createdAt - ms, dueAt: Date.now() })));
        },
        remember: (text, status) => {
          memory.add({ kind: 'fact', text, source: 'stated', evidence: `"${text}"`, origin: 'owner' }, new Date().toISOString());
          if (status) memory.setStatus(memory.claims().find(row => row.text === text)!.id, status);
        },
        outbox: () => (state.storage.kv.get<Row[]>('telegram_final_outbox_v1') ?? []).map(({ id, status, reason, payload }) => ({ id, status, ...(reason ? { reason } : {}), payload: { text: payload.text } })),
        job: kind => ({
          run: state.storage.sql.exec<{ status: string; summary: string | null }>('SELECT status, summary FROM background_runs WHERE kind = ? ORDER BY started_at', kind).toArray(),
          scheduled: state.storage.sql.exec<{ outcome: string; delivery: string | null }>("SELECT r.outcome, r.delivery FROM schedule_runs r WHERE r.schedule_id LIKE ? AND r.outcome != 'missed' ORDER BY r.id", kind === 'heartbeat' ? HEARTBEAT_ID : 'reminder:%').toArray(),
        }),
        note: id => reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date() }, () => 'unused').note(id),
        armed: id => scheduler.lookup(id).state === 'entry',
        cancel: async id => { expect(await reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date() }, () => 'unused').cancel(id)).toBe(true); },
        claims: status => memory.claims(status).map(claim => claim.text),
        heldTopics: () => memory.pendingTopics(),
        task: text => {
          const brief = { title: 'Quarterly numbers', goal: `Find the latest mail about the ${text}.`, context: `The owner asked about the ${text} draft.`, done_when: 'The newest mail, summarised.', effort: 'standard' as const, timezone: 'UTC', started_at: Date.now() };
          jobBook(state.storage.sql, { now: Date.now, newId: () => 'c0ffee000001', newToken: () => 'token' })
            .create({ kind: 'task', profile: 'reader', idempotencyKey: 'forget-task', origin: 'turn', surface: 'whatsapp', brief, dueAt: Date.now() + HOUR, deadlineAt: Date.now() + 2 * HOUR });
        },
        tasks: () => state.storage.sql.exec<{ status: string; cancel_reason: string | null }>('SELECT status, cancel_reason FROM task_jobs').toArray(),
      });
    } finally { await state.storage.deleteAlarm(); turns.mockRestore(); }
  });
};

const STOPPED_HEARTBEAT = 'heartbeat not sent: it named something you asked me to forget';
const STOPPED_REMINDER = 'reminder not sent: it named something you asked me to forget';

// Each alarm pass waits out the 250 ms a queued record takes to fall due, so these run past the 5 s default.
describe('owner forget reaches a heartbeat check-back waiting for WhatsApp', { timeout: 30_000 }, () => {
  it.each(['node', 'spot'] as const)('cancels and scrubs it from the console (%s), and the reply never sends it', async kind => {
    await owned(`wa-forget-heartbeat-${kind}`, async ({ alarms, write, heartbeat, forget, outbox, job }) => {
      await heartbeat();
      await alarms(3);
      expect(model.checkBacks).toBe(1);
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      expect(outbox()).toEqual([{ id: expect.stringMatching(/^heartbeat:heartbeat-tick:\d+$/), status: 'pending', payload: { text: CHECK_BACK } }]);

      expect(await forget(kind, SECRET)).toBe(true);
      expect(outbox()).toEqual([{ id: expect.stringMatching(/^heartbeat:/), status: 'blocked', reason: 'owner_forget', payload: { text: CHECK_BACK.replace(SECRET, FORGOTTEN) } }]);

      await write('hi');
      // The cancelled record settles on the outbox's next pass, like every other record that ends.
      await alarms(1);
      expect(wire.events).toEqual(['template:waldo_update_ready', 'turn']);
      // The tick ran and its check-back was cancelled by the owner, which is neither a failure nor a failed delivery.
      expect(job('heartbeat')).toEqual({ run: [{ status: 'stopped', summary: STOPPED_HEARTBEAT }], scheduled: [{ outcome: 'ok', delivery: null }] });
      // Nothing writes that occurrence's check-back again.
      await alarms(3);
      expect(model.checkBacks).toBe(1);
      expect(outbox()).toHaveLength(1);
      expect(wire.events).toEqual(['template:waldo_update_ready', 'turn']);
    });
  });

  it('cancels it from the forget tool in the owner\'s turn', async () => {
    await owned('wa-forget-heartbeat-tool', async ({ alarms, write, heartbeat, remember, outbox, job, claims, heldTopics }) => {
      remember(`Chairs the ${SECRET} committee`);
      await heartbeat();
      await alarms(3);
      expect(outbox()).toMatchObject([{ status: 'pending' }]);

      release.held = true;
      await write(`Please forget the ${SECRET}.`, true);
      // The forget completed: the claim is gone and no topic waits for a purge that could not verify clean.
      expect([claims(), heldTopics()]).toEqual([[], []]);
      expect(outbox()).toEqual([{ id: expect.stringMatching(/^heartbeat:/), status: 'blocked', reason: 'owner_forget', payload: { text: CHECK_BACK.replace(SECRET, FORGOTTEN) } }]);
      await alarms(1);
      expect(wire.events.filter(event => event.includes(SECRET) || event === `text:${CHECK_BACK}`)).toEqual([]);
      expect(job('heartbeat').run).toEqual([{ status: 'stopped', summary: STOPPED_HEARTBEAT }]);
    });
  });

  it('cancels it when an unfinished forget is finished at the owner\'s next turn', async () => {
    await owned('wa-forget-heartbeat-retry', async ({ alarms, write, heartbeat, remember, outbox, claims }) => {
      await heartbeat();
      await alarms(3);
      expect(outbox()).toMatchObject([{ status: 'pending' }]);

      remember(SECRET, 'purging');
      release.held = true;
      await write('Good morning.', true);
      expect(claims('purging')).toEqual([]);
      expect(outbox()).toEqual([{ id: expect.stringMatching(/^heartbeat:/), status: 'blocked', reason: 'owner_forget', payload: { text: CHECK_BACK.replace(SECRET, FORGOTTEN) } }]);
      await alarms(1);
      expect(wire.events.filter(event => event.includes(SECRET))).toEqual([]);
    });
  });
});

describe('a heartbeat check-back Meta took, and one whose window never reopens', { timeout: 30_000 }, () => {
  // Forget that reaches a record Meta has already accepted leaves it to arrive: the check-back was sent, so its run says so.
  it('finishes "heartbeat sent" when forget reaches an accepted check-back that then arrives', async () => {
    await owned('wa-forget-heartbeat-accepted-arrived', async ({ alarms, write, heartbeat, forget, report, outbox, job }) => {
      await heartbeat();
      await alarms(3);
      await write('hi');
      expect(outbox()).toMatchObject([{ status: 'accepted' }]);
      expect(await forget('node', SECRET)).toBe(true);
      expect(outbox()).toMatchObject([{ status: 'accepted', payload: { text: CHECK_BACK.replace(SECRET, FORGOTTEN) } }]);
      await report('delivered');
      await alarms(1);
      expect(outbox()).toMatchObject([{ status: 'delivered' }]);
      expect(job('heartbeat')).toEqual({ run: [{ status: 'completed', summary: 'heartbeat sent' }], scheduled: [{ outcome: 'ok', delivery: 'sent' }] });
    });
  });

  it('ends by forget when Meta then refuses the forgotten, accepted check-back', async () => {
    await owned('wa-forget-heartbeat-accepted-refused', async ({ alarms, write, heartbeat, forget, report, outbox, job }) => {
      await heartbeat();
      await alarms(3);
      await write('hi');
      expect(await forget('node', SECRET)).toBe(true);
      await report('refused');
      await alarms(1);
      expect(outbox()).toMatchObject([{ status: 'blocked', reason: 'owner_forget' }]);
      expect(job('heartbeat')).toEqual({ run: [{ status: 'stopped', summary: STOPPED_HEARTBEAT }], scheduled: [{ outcome: 'ok', delivery: null }] });
    });
  });

  // Nothing was attempted, so a lapse is neither a failure nor "delivery unconfirmed": the run stopped, as for a reminder.
  it('a check-back that waited out Meta\'s 30 days for the window ends stopped with the lapse line, not failed as unconfirmed', async () => {
    await owned('wa-heartbeat-lapsed', async ({ alarms, heartbeat, age, outbox, job }) => {
      await heartbeat();
      await alarms(3);
      expect(outbox()).toMatchObject([{ status: 'pending' }]);
      age(31 * 24 * HOUR);
      await alarms(2);
      expect(outbox()).toMatchObject([{ status: 'blocked', reason: 'lapsed' }]);
      expect(job('heartbeat')).toEqual({ run: [{ status: 'stopped', summary: 'heartbeat not sent; your WhatsApp window stayed closed for 30 days' }], scheduled: [{ outcome: 'ok', delivery: null }] });
    });
  });
});

describe('owner forget reaches a reminder waiting for WhatsApp', { timeout: 30_000 }, () => {
  it.each(['node', 'spot'] as const)('cancels a one-off reminder\'s waiting message (%s) and ends the reminder', async kind => {
    await owned(`wa-forget-reminder-${kind}`, async ({ alarms, write, reminder, forget, outbox, job, note }) => {
      const id = await reminder('none');
      await alarms(3);
      expect(model.reminders).toBe(1);
      expect(outbox()).toEqual([{ id: expect.stringMatching(/^reminder:/), status: 'pending', payload: { text: REMINDER } }]);

      expect(await forget(kind, SECRET)).toBe(true);
      expect(outbox()).toEqual([{ id: expect.stringMatching(/^reminder:/), status: 'blocked', reason: 'owner_forget', payload: { text: REMINDER.replace(SECRET, FORGOTTEN) } }]);

      await write('hi');
      await alarms(1);
      expect(wire.events).toEqual(['template:waldo_update_ready', 'turn']);
      expect(job('reminder')).toEqual({ run: [{ status: 'stopped', summary: STOPPED_REMINDER }], scheduled: [{ outcome: 'ok', delivery: null }] });
      // Its one occurrence is over, so the one-off keeps no note behind.
      expect(note(id)).toBeNull();
    });
  });

  it('keeps a cancelled reminder\'s outcome when a later forget scrubs its message', async () => {
    await owned('wa-forget-reminder-cancelled', async ({ alarms, write, reminder, cancel, forget, outbox, job }) => {
      const id = await reminder('none');
      await alarms(3);
      await cancel(id);
      await write('hi');
      expect(job('reminder').run).toEqual([{ status: 'stopped', summary: 'reminder cancelled before delivery' }]);

      expect(await forget('node', SECRET)).toBe(true);
      expect(outbox()).toMatchObject([{ status: 'blocked', reason: 'owner_forget', payload: { text: REMINDER.replace(SECRET, FORGOTTEN) } }]);
      await alarms(1);
      expect(wire.events).toEqual(['template:waldo_update_ready', 'turn']);
      expect(job('reminder')).toEqual({ run: [{ status: 'stopped', summary: 'reminder cancelled before delivery' }], scheduled: [{ outcome: 'ok', delivery: null }] });
    });
  });

  // Forget that reaches a record Meta has already accepted leaves it to arrive: it settles as delivered, and only a refusal
  // ends it by forget. A one-off's note goes with its only occurrence either way.
  it('lets a forgotten, accepted reminder settle as delivered once Meta reports it arrived', async () => {
    await owned('wa-forget-reminder-accepted-arrived', async ({ alarms, write, reminder, forget, report, outbox, job, note }) => {
      const id = await reminder('none');
      await alarms(3);
      await write('hi');
      expect(outbox()).toMatchObject([{ status: 'accepted' }]);
      expect(await forget('node', SECRET)).toBe(true);
      expect(outbox()).toMatchObject([{ status: 'accepted', payload: { text: REMINDER.replace(SECRET, FORGOTTEN) } }]);
      await report('delivered');
      await alarms(1);
      expect(outbox()).toMatchObject([{ status: 'delivered' }]);
      expect(job('reminder')).toEqual({ run: [{ status: 'completed', summary: 'reminder sent' }], scheduled: [{ outcome: 'ok', delivery: 'sent' }] });
      expect(note(id)).toBeNull();
    });
  });

  it('ends a forgotten, accepted reminder by forget when Meta then refuses it', async () => {
    await owned('wa-forget-reminder-accepted-refused', async ({ alarms, write, reminder, forget, report, outbox, job, note }) => {
      const id = await reminder('none');
      await alarms(3);
      await write('hi');
      expect(await forget('node', SECRET)).toBe(true);
      await report('refused');
      await alarms(1);
      expect(outbox()).toMatchObject([{ status: 'blocked', reason: 'owner_forget' }]);
      expect(job('reminder')).toEqual({ run: [{ status: 'stopped', summary: STOPPED_REMINDER }], scheduled: [{ outcome: 'ok', delivery: null }] });
      expect(note(id)).toBeNull();
    });
  });

  it('keeps the forget summary when forget ends a waiting reminder and the number is then unlinked', async () => {
    await owned('wa-forget-reminder-unlinked', async ({ alarms, reminder, forget, unlink, outbox, job }) => {
      await reminder('none');
      await alarms(3);
      expect(await forget('node', SECRET)).toBe(true);
      await unlink();
      await alarms(1);
      expect(outbox()).toMatchObject([{ status: 'blocked', reason: expect.stringMatching(/^(owner_forget|surface_unlinked)$/) }]);
      expect(job('reminder').run).toEqual([{ status: 'stopped', summary: STOPPED_REMINDER }]);
    });
  });

  it('cancels only the waiting occurrence of a repeating reminder; the reminder stays armed', async () => {
    await owned('wa-forget-reminder-daily', async ({ alarms, write, reminder, forget, outbox, job, note, armed }) => {
      const id = await reminder('daily');
      await alarms(3);
      expect(outbox()).toMatchObject([{ status: 'pending' }]);

      expect(await forget('node', SECRET)).toBe(true);
      await write('hi');
      await alarms(1);
      expect(wire.events).toEqual(['template:waldo_update_ready', 'turn']);
      expect(job('reminder').run).toEqual([{ status: 'stopped', summary: STOPPED_REMINDER }]);
      expect(note(id)).toBe('send the quarterly numbers');
      expect(armed(id)).toBe(true);
    });
  });
});

describe('owner forget reaches an open background task', { timeout: 30_000 }, () => {
  it.each(['node', 'spot'] as const)('cancels it from the console (%s), so its worker cannot report the text back', async kind => {
    await owned(`wa-forget-task-${kind}`, async ({ task, tasks, forget }) => {
      task(SECRET);
      expect(await forget(kind, SECRET)).toBe(true);
      expect(tasks()).toEqual([{ status: 'cancelled', cancel_reason: 'forgotten' }]);
    });
  });
});

describe('the job-report redactor covers heartbeat check-backs and reminders', () => {
  it('cancels waiting ones, scrubs delivered ones, leaves replies and notices alone, and counts what it could not scrub', async () => {
    const { TelegramFinalOutbox, redactJobReportEntries, FINAL_OUTBOX_KEY } = await import('../src/channels/telegram-final-outbox');
    const values = new Map<string, unknown>();
    const kv = { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined, put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); } };
    const outbox = new TelegramFinalOutbox(kv, () => 1000);
    const base = { trace: 'fixture', payload: { chat_id: 42, text: `Still open: the ${SECRET}.` }, ownerSubject: '42', doName: 'owner' };
    const heartbeat = { id: HEARTBEAT_ID, occurrence: 900, schedulerRunId: 'run', loops: [{ id: 'o1', due: '2026-10-18T08:00', status: 'open' }] };
    const reminder = { id: 'reminder:r1', occurrence: 900, runId: 'run', schedulerRunId: 'run', once: true };
    await outbox.enqueue({ ...base, id: 'heartbeat', heartbeat });
    await outbox.enqueue({ ...base, id: 'reminder', reminder });
    await outbox.enqueue({ ...base, id: 'delivered-heartbeat', heartbeat: { ...heartbeat, occurrence: 800 } });
    await outbox.enqueue({ ...base, id: 'reply' });
    await outbox.enqueue({ ...base, id: 'notice', scheduleNotice: { scheduleId: 'job', until: 5000 } });
    const rows = outbox.records(); rows[2]!.status = 'delivered'; rows[2]!.settled = true; kv.put(FINAL_OUTBOX_KEY, rows);

    expect(redactJobReportEntries(kv, [SECRET], FORGOTTEN)).toEqual({ rewritten: 3, remaining: 0 });
    expect(new TelegramFinalOutbox(kv).records().map(({ id, status, reason, payload }) => ({ id, status, reason, text: payload.text }))).toEqual([
      { id: 'heartbeat', status: 'blocked', reason: 'owner_forget', text: `Still open: the ${FORGOTTEN}.` },
      { id: 'reminder', status: 'blocked', reason: 'owner_forget', text: `Still open: the ${FORGOTTEN}.` },
      { id: 'delivered-heartbeat', status: 'delivered', reason: undefined, text: `Still open: the ${FORGOTTEN}.` },
      { id: 'reply', status: 'pending', reason: undefined, text: `Still open: the ${SECRET}.` },
      { id: 'notice', status: 'pending', reason: undefined, text: `Still open: the ${SECRET}.` },
    ]);
  });

  // The redactor and the remaining check share one pattern: a Unicode case variant (the Kelvin sign folds to "k") is scrubbed,
  // and a copy the scrub cannot clean, where the marker itself carries the topic, is counted, never reported complete.
  it('scrubs a Unicode case variant and counts a waiting check-back the scrub could not clean', async () => {
    const { TelegramFinalOutbox, redactJobReportEntries } = await import('../src/channels/telegram-final-outbox');
    const values = new Map<string, unknown>();
    const kv = { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined, put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); } };
    await new TelegramFinalOutbox(kv, () => 1000).enqueue({ id: 'heartbeat', trace: 'fixture', payload: { chat_id: 42, text: `Your ${String.fromCharCode(0x212a)}ite lesson is still open.` }, ownerSubject: '42', doName: 'owner',
      heartbeat: { id: HEARTBEAT_ID, occurrence: 900, schedulerRunId: 'run', loops: [{ id: 'o1', due: '2026-10-18T08:00', status: 'open' }] } });
    expect(redactJobReportEntries(kv, ['kite'], FORGOTTEN)).toEqual({ rewritten: 1, remaining: 0 });
    expect(new TelegramFinalOutbox(kv).records()[0]!.payload.text).toBe(`Your ${FORGOTTEN} lesson is still open.`);
    expect(redactJobReportEntries(kv, ['forgotten'], FORGOTTEN)).toEqual({ rewritten: 1, remaining: 1 });
  });
});

// A job whose message waits for WhatsApp keeps its run open, with no summary yet, for as long as the message waits.
describe('a forget while a job\'s run is still open', () => {
  it('scrubs finished runs and settles, instead of failing on the open run\'s empty summary', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('forget-open-run')), async (_instance, state) => {
      const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      const runs = runBook(state.storage.sql, { timezone: 'UTC', now: () => new Date() }, () => crypto.randomUUID());
      runs.start('heartbeat', HEARTBEAT_ID);
      runs.finish(runs.start('standing_order', 'order:o1').id, 'completed', `Checked the ${SECRET}`);
      memory.add({ kind: 'fact', text: SECRET, source: 'stated', evidence: `"${SECRET}"`, origin: 'owner' }, new Date().toISOString());
      const purge = memory.purge([memory.claims()[0]!.id], new Date().toISOString());
      expect({ ready: purge.ready, failed: purge.failed, remaining: purge.remaining }).toEqual({ ready: true, failed: [], remaining: {} });
      expect(state.storage.sql.exec<{ summary: string | null }>('SELECT summary FROM background_runs ORDER BY started_at, kind').toArray().map(row => row.summary).sort())
        .toEqual([`Checked the ${FORGOTTEN}`, null].sort());
    });
  });
});
