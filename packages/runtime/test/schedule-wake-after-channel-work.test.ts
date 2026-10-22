import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { dayPlanBook } from '../src/channels/day-cards';
import { OwnerDO } from '../src/channels/owner-do';
import { macInbox } from '../src/devices/mac-delivery';
import { alarmPass } from '../src/scheduler/alarm-slot';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { remindInTwoHours } from './helpers/reminder-wake';

// Work outside the schedule re-arms the owner's one alarm, and each re-arm keeps the schedule's next entry: a reminder two
// hours out keeps its wake through a WhatsApp status report and a Mac follow-up.
afterEach(() => { vi.unstubAllGlobals(); });

const SUBJECT = '15550001234';
const inObject = (work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`schedule-wake-${crypto.randomUUID()}`)), async (_instance, state) => {
    try { await work(state); } finally { await state.storage.deleteAlarm(); }
  });
// Today's cards are already planned, so the runtime's boot neither plans nor schedules them: the reminder is the schedule's
// next entry.
const owner = (state: DurableObjectState, surface: Record<string, string | undefined>) => {
  const plans = dayPlanBook(state.storage.sql), today = new Date().toISOString().slice(0, 10);
  for (const card of ['card:brief', 'card:midday', 'card:close'] as const) plans.save(today, { card, time: null, reason: 'planned by the fixture' });
  return new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', ...surface } as never);
};
const whatsappOwner = (state: DurableObjectState) => {
  state.storage.kv.put('whatsapp_subject', SUBJECT);
  return owner(state, { WHATSAPP_ACCESS_TOKEN: 'synthetic', WHATSAPP_PHONE_NUMBER_ID: '100000000000001' });
};
// Meta's report that a message reached the phone, for a message this owner has no record of: it changes nothing else.
const delivered = () => new Request('https://telegram-owner/whatsapp-status', { method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
  body: JSON.stringify({ delivered: [{ id: 'wamid.unknown', at: Date.now() }] }) });

it('a WhatsApp status report keeps the alarm for the owner\'s reminder two hours out', async () => {
  await inObject(async state => {
    const whatsapp = whatsappOwner(state), due = await remindInTwoHours(state);
    expect((await whatsapp.fetch(delivered())).status).toBe(200);
    expect(await state.storage.getAlarm()).toBe(due);
  });
});

// The alarm that fired leaves the slot empty, and the pass arms its last recorded re-arm. A report that lands after the pass
// re-armed for its schedule records the last one.
it('a WhatsApp status report that lands inside an alarm pass, after its schedule re-arm, keeps the reminder\'s alarm', async () => {
  await inObject(async state => {
    const whatsapp = whatsappOwner(state), due = await remindInTwoHours(state);
    await state.storage.deleteAlarm();
    await alarmPass(state.storage, async () => {
      await new Scheduler(state.storage.sql, state.storage, productionDeps()).rearm();
      expect((await whatsapp.fetch(delivered())).status).toBe(200);
    });
    expect(await state.storage.getAlarm()).toBe(due);
  });
});

// The drain admitMacDelivery queues runs outside any pass. A row whose device the directory no longer resolves is set aside,
// which leaves no Mac wake, so the drain's own re-arm is all that keeps the reminder's.
it('a Mac follow-up drain that sets aside a row from a revoked device keeps the reminder\'s alarm', async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
    new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith('/device_for_auth_v030') ? Response.json([]) : Response.json(true));
  await inObject(async state => {
    state.storage.kv.put('do_name', 'schedule-wake-mac');
    state.storage.kv.put('telegram_subject', '700000001');
    const telegramOwner = owner(state, { TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: '700000001',
      SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' });
    const due = await remindInTwoHours(state), inbox = macInbox(state.storage);
    expect(await inbox.admit({ kind: 'session_event', request_id: 'event_fixture', device_id: 'revoked_device', owner_id: 'owner_fixture',
      payload: { project: 'fixture', session_id: 'session_fixture', event: 'blocked_on_tool' } })).toBe(true);
    await (telegramOwner as unknown as { drainMacDeliveries(): Promise<void> }).drainMacDeliveries();
    expect(inbox.pending()).toEqual([]);
    expect(await state.storage.getAlarm()).toBe(due);
  });
});
