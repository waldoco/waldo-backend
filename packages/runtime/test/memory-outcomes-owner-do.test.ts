import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { episodeIndex, NIGHTLY_ID } from '../src/channels/episodes';
import { traceBook } from '../src/channels/harness';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// MEMORY_OUTCOME_LEARNING on the owner object, over three days. On the first two mornings Waldo's Brief suggests a 07:00 run
// and a card offers to put it in the calendar; the owner lets the first card expire, declines the second and never writes back.
// The nightly pass reads that record and the model (scripted here) keeps a read of it; the third morning's Brief, a run Waldo
// starts, reads that read. A scripted model proves the plumbing, not that a real model plans around it. Synthetic values only.
const OUTCOME_HEADING = 'What Waldo did on its own initiative';
const model = vi.hoisted(() => ({ outcomes: [] as string[], outcomeReply: '{"add":[]}', cards: [] as string[], formats: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    const sent = JSON.stringify(request.messages);
    if (request.response_format) model.formats.push(request.response_format.name);
    if (request.response_format?.name === 'source_claims' && sent.includes(OUTCOME_HEADING)) { model.outcomes.push(sent); return done(model.outcomeReply); }
    if (request.response_format?.name === 'day_plan') return done('{"cards":[]}');
    if (request.response_format) return done('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    if (String(request.messages.at(-1)?.content ?? '').includes('[Scheduled card "')) { model.cards.push(JSON.stringify(request)); return done('Morning. Your day is clear until 10:00.'); }
    return done('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c';
const DAY = '2030-03-05';
const AT = Date.parse(`${DAY}T08:00:00Z`);
const HOUR = 3_600_000, D1 = AT - 48 * HOUR, D2 = AT - 24 * HOUR;
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const BRIEF = (day: string) => `Morning. A clear start on ${day}: a 07:00 run before the 10:00 standup would fit. Resting heart rate 52 bpm overnight.`;
const READ = 'Has let both of Waldo\'s suggested 07:00 morning runs pass this week, one card left to expire and one declined, with no word back';
const add = (text: string, evidence: string, kind = 'routine') => ({ kind, text, source: 'inferred', evidence, touches_forgotten: false, aliases: [], aliases_touch_forgotten: false });

beforeEach(() => {
  model.outcomes = []; model.cards = []; model.formats = [];
  model.outcomeReply = JSON.stringify({ add: [add(READ, '"Then it expired with no answer from the owner." "Then the owner declined it."'), add('Resting heart rate 52 bpm on run mornings', '"Resting heart rate 52 bpm overnight."', 'health')] });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json({ context: null, previous: null });
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; alarm(): Promise<void>; serial(work: () => Promise<void>): Promise<void> }>;
type Steps = Readonly<{ state: DurableObjectState; nightly(): Promise<void>; brief(): Promise<void> }>;

const owned = async (name: string, settings: Readonly<Record<string, string>>, run: (steps: Steps) => Promise<void>, before?: (state: DurableObjectState) => void) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      before?.(state);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_TOOL_OFFLOAD: '0', ...settings } as never) as unknown as Owner;
      await owner.setup('app').ready;
      await owner.serial(async () => undefined);
      const fire = async (id: string, kind: 'brief' | 'dreaming') => {
        state.storage.sql.exec('DELETE FROM schedule');
        await new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id, kind, payloadRefs: { id }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
        state.storage.kv.put('owner_alarm_last_v1', 1);
        await owner.alarm();
        await state.storage.deleteAlarm();
      };
      await run({
        state,
        nightly: () => fire(NIGHTLY_ID, 'dreaming'),
        brief: async () => { dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '08:00', reason: 'planned' }); await fire('card:brief', 'brief'); },
      });
    } finally { Date.now = originalNow; quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
};

// Two mornings of Waldo's own suggestion: the Brief in the chat and a card, with no word from the owner after either.
const twoMornings = (state: DurableObjectState) => {
  const sql = state.storage.sql, episodes = episodeIndex(sql), plans = dayPlanBook(sql);
  for (const [day, at, status, decided] of [['2030-03-03', D1, 'expired', D1 + 3 * HOUR], ['2030-03-04', D2, 'rejected', D2 + HOUR]] as const) {
    plans.delivered(day, 'card:brief', `brief-${day}`, at - HOUR);
    episodes.add(`brief-${day}`, 'waldo', BRIEF(day), at - HOUR);
    sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at, decided_at, raised_outside) VALUES (?, 'calendar_change', ?, ?, '{}', ?, ?, 0)",
      `run-${day}`, status, `Add a 07:00 run to ${day === '2030-03-03' ? 'Tuesday' : 'Wednesday'} morning`, at - HOUR, decided);
  }
};
const kept = (state: DurableObjectState) => JSON.stringify([claimStore(state.storage.sql).allClaims(), [...state.storage.kv.list()],
  state.storage.sql.exec('SELECT * FROM trace_log').toArray()]);

describe('outcome learning on the owner object', { timeout: 30_000 }, () => {
  it('two skipped morning-run suggestions reach the nightly pass, and the third morning\'s Brief reads what it learned', async () => {
    await owned('outcomes-three-days', { MEMORY_OUTCOME_LEARNING: '1' }, async ({ state, nightly, brief }) => {
      twoMornings(state);
      await nightly();
      expect(model.outcomes).toHaveLength(1);
      const read = model.outcomes[0]!;
      for (const day of ['2030-03-03', '2030-03-04']) expect(read).toContain(`A clear start on ${day}: a 07:00 run before the 10:00 standup would fit.`);
      expect(read).toContain('Then it expired with no answer from the owner.');
      expect(read).toContain('Then the owner declined it.');
      expect(read).toContain('The owner has not written to Waldo since');
      // The pass runs before the day is planned, so tomorrow's plan can use it.
      expect(model.formats.indexOf('source_claims')).toBeLessThan(model.formats.indexOf('day_plan'));
      const stored = claimStore(state.storage.sql).claims().find(claim => claim.text === READ);
      expect(stored).toMatchObject({ source: 'inferred', origin: 'agent' });
      // A health reading in Waldo's own Brief is never kept: not in memory, the owner object's KV, or a trace.
      expect(kept(state)).not.toContain('52 bpm');
      await brief();
      expect(model.cards).toHaveLength(1);
      expect(model.cards[0]).toContain(READ);
      expect(model.cards[0]).toContain('not the owner\'s words and not rules');
    });
  });

  it('with the switch off, the night makes no outcomes call and the Brief reads nothing of it', async () => {
    await owned('outcomes-off', { MEMORY_OUTCOME_LEARNING: '0' }, async ({ state, nightly, brief }) => {
      twoMornings(state);
      await nightly();
      expect(model.outcomes).toEqual([]);
      await brief();
      expect(model.cards[0]).not.toContain('not the owner\'s words and not rules');
    });
  });

  it('an outcomes pass that throws is logged and the night still plans the day', async () => {
    // An update_cards table of another shape makes the outcome read itself throw, outside the pass's own model-call guard.
    await owned('outcomes-throws', { MEMORY_OUTCOME_LEARNING: '1' }, async ({ state, nightly }) => {
      await nightly();
      expect(model.outcomes).toEqual([]);
      expect(model.formats).toContain('day_plan');
      expect(state.storage.sql.exec<{ ok: number }>("SELECT ok FROM trace_log WHERE hop = 'nightly_memory'").toArray().map(row => row.ok)).toContain(0);
    }, state => state.storage.sql.exec('CREATE TABLE update_cards (id INTEGER PRIMARY KEY, at INTEGER, day TEXT, changes TEXT, pushed INTEGER, folded INTEGER, delivered_at INTEGER)'));
  });
});
