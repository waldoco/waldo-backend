import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScheduleEntry } from '@waldo/contracts';
import type { CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { routedDelivery } from '../src/channels/delivery-routes';
import type { OutboxRoute } from '../src/channels/delivery-routes';
import type { FinalRecord, TelegramFinalOutbox } from '../src/channels/telegram-final-outbox';
import { presenceAuthority } from './helpers/directory-presence';

// A prep note goes to the owner's own surface, not only Telegram or the app: on WhatsApp it goes out as text inside the
// 24-hour window and as the approved template knock outside it, and on iMessage its route admits it for the bridge.
const NOTE = 'Design review at 10:30 IST. Bring the onboarding mocks.';
const SUBJECT = '15550001111';
const fixture = vi.hoisted(() => ({ event: null as CalendarItem | null }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => fixture.event ? [fixture.event] : [],
    calendarPage: async () => ({ events: fixture.event ? [fixture.event] : [], next_page_token: null, fetched_count: 1, account, observed_at: new Date().toISOString() }),
    event: async () => fixture.event, changedEvents: async () => [], newMail: async () => [],
  }) };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const prep = request.request.response_format?.name === 'calendar_prep';
    return { ok: true, data: { model: request.request.model, text: prep ? JSON.stringify({ kind: 'notify', text: NOTE }) : 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { events: [] as string[], unlinked: false, presence: 0 };
beforeEach(() => {
  wire.events = []; wire.unlinked = false; wire.presence = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') { wire.presence += 1; return Response.json(!wire.unlinked); }
    if (fn === 'health_context_read') return Response.json(null);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; template?: { name: string }; text?: { body: string } };
      wire.events.push(body.type === 'template' ? `template:${body.template!.name}` : `text:${body.text!.body}`);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, '') }], messages: [{ id: `wamid.out.${wire.events.length}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Runtime = Readonly<{ ready: Promise<void>; briefs(entry: ScheduleEntry): Promise<void>; finalOutbox: TelegramFinalOutbox; settleFinal(record: FinalRecord): Promise<void> }>;
type Internals = Readonly<{ setup(channel: string): Runtime; outboxRoute(surface: string): OutboxRoute; asOwnerJob<T>(job: string, key: string, work: () => Promise<T>): Promise<T> }>;
const whatsappEnv = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };

const onSurface = (name: string, surface: 'whatsapp' | 'imessage', work: (o: Readonly<{ state: DurableObjectState; owner: Internals; runtime: Runtime; now(): number; advance(ms: number): void }>) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    let now = Date.parse('2026-10-03T04:30:00Z');
    Date.now = () => now;
    fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: '2026-10-03T10:30:00+05:30', end: '2026-10-03T11:00:00+05:30', all_day: false, description: 'Bring the onboarding mocks', etag: 'r1' };
    state.storage.kv.put('do_name', name);
    state.storage.kv.put(`${surface}_subject`, SUBJECT);
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    const owner = new OwnerDO(state, { ...env, ...whatsappEnv, ...(name.includes('directory') ? directory : {}), CALENDAR_GROUNDED_PREP: '1', TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_OWNER_TIMEZONE: 'Asia/Kolkata',
      OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' }) as unknown as Internals;
    const runtime = owner.setup(surface);
    try {
      await runtime.ready;
      await work({ state, owner, runtime, now: () => now, advance: ms => { now += ms; } });
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
const sweepAt = (now: number): ScheduleEntry => ({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payload_refs: { id: BRIEF_SWEEP_ID }, occurrence_at: now, due_at: now, status: 'scheduled',
  recurrence: null, attempts: 0, last_fired_at: null, quarantined_until: null, created_at: now, updated_at: now } as unknown as ScheduleEntry);
const prepRecords = (runtime: Runtime) => runtime.finalOutbox.records().filter(record => record.calendarPrep);
const drain = async (owner: Internals, runtime: Runtime, surface: string) => runtime.finalOutbox.drain({ ...routedDelivery([owner.outboxRoute(surface)]), settled: runtime.settleFinal });

it.each([
  { window: 'open', lastInbound: 60 * 60_000, expected: [`text:${NOTE}`] },
  { window: 'closed', lastInbound: 30 * 60 * 60_000, expected: ['template:waldo_update_ready'] },
])('a WhatsApp owner\'s prep note goes out on WhatsApp (window $window)', async ({ window, lastInbound, expected }) => {
  await onSurface(`calendar-prep-whatsapp-${window}`, 'whatsapp', async ({ state, owner, runtime, now, advance }) => {
    state.storage.kv.put('wa_last_inbound_ms', now() - lastInbound);
    await runtime.briefs(sweepAt(now()));
    expect(prepRecords(runtime)).toHaveLength(1);
    expect(prepRecords(runtime)[0]).toMatchObject({ payload: { chat_id: Number(SUBJECT), text: NOTE }, status: 'pending' });
    advance(1000);
    await drain(owner, runtime, 'whatsapp');
    expect(wire.events).toEqual(expected);
    const roots = state.storage.sql.exec<{ note: string }>("SELECT note FROM trace_log WHERE hop = 'machine_turn' AND trace LIKE 'calendar-prep:%'").toArray();
    expect(roots).toEqual([{ note: 'queued' }]);
  });
});

it('an iMessage owner\'s prep note is queued for them, and their route admits it for the bridge', async () => {
  await onSurface('calendar-prep-imessage', 'imessage', async ({ owner, runtime, now }) => {
    await runtime.briefs(sweepAt(now()));
    const [record] = prepRecords(runtime);
    expect(record).toMatchObject({ payload: { chat_id: Number(SUBJECT), text: NOTE }, status: 'pending' });
    const route = owner.outboxRoute('imessage');
    expect(route.addressed(record!)).toBe(true);
    expect(await route.allowed(record!)).toBe(true);
  });
});

// With the directory wired, as in production, the owner's WhatsApp presence is asked again before the note is queued: an owner
// who unlinked WhatsApp gets no note, and the pass says why with a code.
it.each([false, true])('a directory-backed WhatsApp owner\'s prep rechecks their presence (unlinked: %s)', async unlinked => {
  await onSurface(`calendar-prep-whatsapp-directory-${unlinked}`, 'whatsapp', async ({ state, owner, runtime, now }) => {
    state.storage.kv.put('wa_last_inbound_ms', now() - 60 * 60_000);
    wire.unlinked = unlinked;
    await owner.asOwnerJob('pre_activity_spot', `${BRIEF_SWEEP_ID}:${now()}`, () => runtime.briefs(sweepAt(now())));
    expect(wire.presence).toBeGreaterThan(0);
    expect(prepRecords(runtime)).toHaveLength(unlinked ? 0 : 1);
    const root = state.storage.sql.exec<{ note: string; ok: number }>("SELECT note, ok FROM trace_log WHERE hop = 'machine_turn' AND trace LIKE ?", `${BRIEF_SWEEP_ID}:%`).toArray();
    expect(root).toEqual([unlinked ? { note: 'failed', ok: 0 } : { note: 'queued', ok: 1 }]);
  });
});
