import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { DAY_CARDS, dayCardPrompt } from '../src/prompt/day-cards';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// A day card speaks about the owner's body only from the health context the owner shared for this request.
const BODY_RULE = 'shared health context';
const CARD_TEXT = 'The Brief: a clear morning.';
const fixture = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    fixture.requests.push(JSON.stringify(request.request));
    const content = request.request.messages.at(-1)?.content ?? '';
    const text = request.request.response_format?.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : content.includes('[Scheduled card') ? CARD_TEXT : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4c5d6e7f-8091-4a2b-9c3d-4e5f6a7b8c9d';
const AT = Date.parse('2026-10-03T09:00:00Z');
const DAY = '2026-10-03';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
// Distinct derived descriptors, so their absence from every stored row is a real check.
const HEALTH_WORDS = ['Form zone:', 'Recovery: solid', 'Form steady; recovery solid', 'slept 41 minutes under baseline'];
const consent = { shared: true };

beforeEach(() => {
  fixture.requests = []; consent.shared = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(consent.shared ? { context: { id: 'brief-health', day: DAY, form: { score: 72, zone: 'good' }, recovery: { score: 70, zone: 'good' },
      weight: { score: 45, zone: 'moderate' }, drivers: ['slept 41 minutes under baseline'], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: new Date(AT - 3_600_000).toISOString() }, previous: null }
      : { context: null, previous: null });
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; alarm(): Promise<void>; serial(work: () => Promise<void>): Promise<void> }>;

const briefFor = async (name: string, run: (state: DurableObjectState) => void) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
      await owner.setup('app').ready;
      await owner.serial(async () => undefined);
      state.storage.sql.exec('DELETE FROM schedule');
      fixture.requests = [];
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      run(state);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};
// Every stored copy in the owner DO: KV values (the app transcript among them) and the rows of every table it can read.
const storedText = (state: DurableObjectState) => {
  const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
  return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
};
const briefRequest = () => fixture.requests.find(sent => sent.includes('[Scheduled card'));

describe('the body in a day card', () => {
  it('every card carries the one body rule', () => {
    for (const card of DAY_CARDS) {
      const prompt = dayCardPrompt(card, '2026-10-03T09:00', { calendar: '[]', ledger: '', today: '', updates: '' });
      expect(prompt.split(BODY_RULE)).toHaveLength(2);
    }
  });

  it('with health shared, the Brief request carries the owner\'s shared health and the rule, and no stored row keeps the health', async () => {
    await briefFor('brief-body-shared', state => {
      const request = briefRequest();
      expect(request).toContain(BODY_RULE);
      expect(request).toContain('Form zone:');
      expect(request).toContain('Day summary: Form steady; recovery solid; load moderate.');
      const stored = storedText(state);
      expect(stored).toContain(CARD_TEXT);
      for (const word of HEALTH_WORDS) expect(stored).not.toContain(word);
    });
  });

  it('with health not shared, the Brief request carries the rule and no health', async () => {
    consent.shared = false;
    await briefFor('brief-body-withheld', state => {
      const request = briefRequest();
      expect(request).toContain(BODY_RULE);
      for (const word of HEALTH_WORDS) expect(request).not.toContain(word);
      expect(storedText(state)).toContain(CARD_TEXT);
    });
  });
});
