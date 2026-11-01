// Where today's cards stand reaches the owner's own turns as one host fact, so a "hello" on WhatsApp knows the Brief
// already reached them in the app, or that it is held, on its way, failed or still due, before deciding what to offer.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { dayCardsLine, dayPlanBook } from '../src/channels/day-cards';
import { OwnerDO } from '../src/channels/owner-do';
import { localIso } from '../src/channels/reminders';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

const ZONE = 'Asia/Kolkata';
// 09:56 in Kolkata.
const NOW = Date.parse('2026-10-31T04:26:00Z');
const DAY = '2026-10-31';

const inObject = (name: string, run: (state: DurableObjectState) => Promise<void> | void) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => { ensureSchema(state.storage); await run(state); });

const lineFor = (state: DurableObjectState, queued: (day: string, card: string) => boolean = () => false) =>
  dayCardsLine({ scheduler: new Scheduler(state.storage.sql, state.storage, productionDeps()), book: dayPlanBook(state.storage.sql), kv: state.storage.kv,
    timezone: ZONE, now: NOW, queued });

it('names each planned card by where it stands: reached the app at a time, still due, held, skipped, failed or on its way', async () => {
  await inObject('day-fact-states', state => {
    const plans = dayPlanBook(state.storage.sql);
    plans.save(DAY, { card: 'card:brief', time: '08:00', reason: 'planned' });
    plans.save(DAY, { card: 'card:midday', time: '14:00', reason: 'planned' });
    plans.save(DAY, { card: 'card:close', time: '21:30', reason: 'planned' });
    plans.delivered(DAY, 'card:brief', 'row-1', Date.parse('2026-10-31T02:32:00Z'));
    plans.sent(DAY, 'card:brief');
    expect(lineFor(state)).toBe("Today's cards: The Brief reached them in the app at 08:02; Check-in is due at 14:00; The Close is due at 21:30.");

    plans.held(DAY, 'card:midday');
    plans.skipped(DAY, 'card:close');
    expect(lineFor(state)).toBe("Today's cards: The Brief reached them in the app at 08:02; Check-in is held for quiet hours; The Close was skipped: nothing worth sending.");
  });
  await inObject('day-fact-elsewhere', state => {
    const plans = dayPlanBook(state.storage.sql);
    plans.save(DAY, { card: 'card:brief', time: '08:00', reason: 'planned' });
    plans.save(DAY, { card: 'card:midday', time: '14:00', reason: 'planned' });
    plans.sent(DAY, 'card:brief');
    // Sent through a surface that keeps no app row: said as sent, never as reaching the app.
    expect(lineFor(state)).toBe("Today's cards: The Brief was sent; Check-in is due at 14:00.");
    // A card released to the outbox is on its way, so the turn does not offer a second copy.
    expect(lineFor(state, (_day, card) => card === 'card:midday')).toBe("Today's cards: The Brief was sent; Check-in is on its way.");
    plans.waitingOnModel(DAY, 'card:midday');
    expect(lineFor(state)).toBe("Today's cards: The Brief was sent; Check-in could not be written (Waldo couldn't reach its model this afternoon).");
  });
});

it('says nothing when no card is planned today', async () => {
  await inObject('day-fact-none', state => { expect(lineFor(state)).toBe(''); });
});

type RequestBody = { tools?: { name?: string }[]; input: string | { type?: string }[]; text?: { format?: { name?: string } } };
const model = vi.hoisted(() => ({ requests: [] as RequestBody[] }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const text = format ? format === 'claim_ops'
      ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
      : format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}'
      : 'Morning. Your Brief is in the app; want the short version here?';
    return { id: `fixture-${model.requests.length}`, output_text: text, output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));
beforeEach(() => { model.requests = []; });

it('a hello on WhatsApp carries where the Brief went today, in the turn context the model reads', async () => {
  const name = 'day-fact-whatsapp';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const subject = '15550003333';
    const mapping = { owner_id: '00000000-0000-4000-8000-0000000000e3', environment: 'fixture', namespace: 'fixture-owner-namespace', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const fixtureEnv = { ...env, OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      WALDO_ENVIRONMENT: mapping.environment, WALDO_OWNER_DO_NAMESPACE: mapping.namespace,
      SUPABASE_PROJECT_URL: 'https://signed-metadata.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret' };
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
        const body = JSON.parse(String(init?.body)) as { status?: string };
        return Response.json(body.status === 'read' ? { success: true } : { messages: [{ id: 'wamid.out' }] });
      }
      if (url === `${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/workspace_owner_binding`) return Response.json({ ...mapping });
      if (url.startsWith(`${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/`)) return Response.json(url.endsWith('health_log_recent') ? [] : url.endsWith('assert_channel_presence') ? true : null);
      throw new Error(`local fixture denies unexpected network: ${url}`);
    });
    try {
      state.storage.kv.put('timezone', ZONE);
      const today = localIso(Date.now(), ZONE).slice(0, 10);
      const plans = dayPlanBook(state.storage.sql);
      plans.save(today, { card: 'card:brief', time: '08:00', reason: 'planned' });
      const deliveredAt = Date.now() - 60_000;
      plans.delivered(today, 'card:brief', 'row-1', deliveredAt);
      plans.sent(today, 'card:brief');
      const instance = new OwnerDO(state, fixtureEnv);
      const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': subject, 'x-waldo-do-name': name, 'x-waldo-origin': 'https://waldo.example' },
        body: JSON.stringify({ messages: [{ from: subject, timestamp: String(Math.floor(Date.now() / 1000)), id: 'wamid.hello', type: 'text', text: { body: 'hello' } }] }),
      }));
      expect(response.status).toBe(200);
      await drainWhatsAppTurns(instance);
      const turn = model.requests.filter(request => !request.text?.format && request.tools?.length).at(-1)!;
      const input = turn.input;
      const message = JSON.stringify(Array.isArray(input) ? input.at(-1) : input);
      expect(message).toContain(`Today's cards: The Brief reached them in the app at ${localIso(deliveredAt, ZONE).slice(11, 16)}.`);
    } finally { network.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
