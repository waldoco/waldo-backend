import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { episodeIndex, NIGHTLY_CATCH_UP_DELAY_MS, NIGHTLY_CATCH_UP_ID, NIGHTLY_ID, NIGHTLY_THROUGH_KEY, OWNER_ROWS_SINCE_KEY } from '../src/channels/episodes';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// The nightly pass consolidates everything since the last pass that finished, so a night that failed or never ran is
// caught up, and a pass that fails leaves a consolidation-only catch-up that the scheduler retries.
const HOUR = 3_600_000, DAY = 24 * HOUR;
const model = vi.hoisted(() => ({ fail: false, asked: [] as string[], nights: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    const format = request.response_format?.name ?? 'reply';
    model.asked.push(format);
    if (format === 'claim_ops') {
      if (model.fail) throw new Error('synthetic provider outage');
      const said = JSON.stringify(request.messages);
      model.nights.push(said);
      const add = [['Swims every Friday before work', 'I swim every Friday before work'], ['Has a sister called Mira', 'my sister is called Mira']]
        .filter(([, quote]) => said.includes(quote!)).map(([text, quote]) => ({ kind: 'fact', text, source: 'stated', evidence: `"${quote}"`, touches_forgotten: false, aliases: [], aliases_touch_forgotten: false }));
      return done(JSON.stringify({ add, corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null }));
    }
    if (format === 'promotion') return done('{"nodes":[],"edges":[],"promoted":[]}');
    return done('{}');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';
const NOW = Date.parse('2026-10-13T03:00:00Z');
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  model.fail = false; model.asked = []; model.nights = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Run = Readonly<{ scheduler: Scheduler; state: DurableObjectState; fire: (id: string) => Promise<void> }>;
const withOwner = (name: string, work: (run: Run) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const realNow = Date.now;
    let now = NOW;
    Date.now = () => now;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      ensureSchema(state.storage); traceBook(state.storage.sql); claimStore(state.storage.sql);
      for (const [key, value] of Object.entries({ do_name: name, app_subject: String(appSubjectFor(name)), timezone: 'UTC', timezone_confirmed: true })) state.storage.kv.put(key, value);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
      await (owner as unknown as { setup(channel: string): { ready: Promise<unknown> } }).setup('app').ready;
      state.storage.sql.exec('DELETE FROM schedule');
      // The rows these tests seed stand for ones an index that splits owner messages wrote.
      state.storage.kv.put(OWNER_ROWS_SINCE_KEY, NOW - 30 * DAY);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const fire = async (id: string) => {
        await scheduler.schedule({ id, kind: 'dreaming', payloadRefs: { id }, occurrenceAt: now - 1000, dueAt: now - 1000, recurrence: null });
        state.storage.kv.put('owner_alarm_last_v1', 1);
        await owner.alarm();
        now += 1000;
      };
      await work({ scheduler, state, fire });
    } finally { Date.now = realNow; quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
const said = (state: DurableObjectState) => {
  const episodes = episodeIndex(state.storage.sql);
  episodes.add('app-1000007', 'owner', 'I swim every Friday before work', NOW - 2.5 * DAY);
  episodes.add('app-1000007-reply', 'waldo', 'Noted.', NOW - 2.5 * DAY + 1);
  episodes.add('app-1000008', 'owner', 'my sister is called Mira', NOW - 2 * HOUR);
};
const learned = (state: DurableObjectState) => claimStore(state.storage.sql).claims().map(claim => [claim.text, claim.source_ref, claim.verification_status]).sort();
const GROUNDED = [['Has a sister called Mira', 'owner, app-1000008', 'owner-grounded'], ['Swims every Friday before work', 'owner, app-1000007', 'owner-grounded']];

it('a night consolidates everything since the last pass that finished, so a missed night is caught up', async () => {
  await withOwner('nightly-catch-up-missed', async ({ state, fire }) => {
    state.storage.kv.put(NIGHTLY_THROUGH_KEY, NOW - 3 * DAY);
    said(state);
    await fire(NIGHTLY_ID);
    expect(model.nights).toHaveLength(1);
    expect(model.nights[0]).toContain('I swim every Friday before work');
    expect(learned(state)).toEqual(GROUNDED);
    expect(state.storage.kv.get(NIGHTLY_THROUGH_KEY)).toBe(NOW - 2 * HOUR);
  });
});

it('a night that cannot consolidate keeps its mark and arms a catch-up, which only consolidates and is retried when it fails', async () => {
  await withOwner('nightly-catch-up-retry', async ({ scheduler, state, fire }) => {
    state.storage.kv.put(NIGHTLY_THROUGH_KEY, NOW - 3 * DAY);
    said(state);
    model.fail = true;
    await fire(NIGHTLY_ID);
    expect(state.storage.kv.get(NIGHTLY_THROUGH_KEY)).toBe(NOW - 3 * DAY);
    expect(learned(state)).toEqual([]);
    const armed = scheduler.read(NIGHTLY_CATCH_UP_ID)!;
    expect([armed.kind, armed.status, armed.recurrence]).toEqual(['dreaming', 'armed', null]);
    expect(armed.due_at).toBe(NOW + NIGHTLY_CATCH_UP_DELAY_MS);

    model.asked = [];
    await fire(NIGHTLY_CATCH_UP_ID);
    expect(new Set(model.asked)).toEqual(new Set(['claim_ops']));
    const retry = scheduler.read(NIGHTLY_CATCH_UP_ID)!;
    expect([retry.status, retry.attempts]).toEqual(['armed', 1]);
    expect(retry.due_at).toBeGreaterThan(Date.now());

    model.fail = false; model.asked = [];
    await fire(NIGHTLY_CATCH_UP_ID);
    expect(new Set(model.asked)).toEqual(new Set(['claim_ops']));
    expect(learned(state)).toEqual(GROUNDED);
    expect(state.storage.kv.get(NIGHTLY_THROUGH_KEY)).toBe(NOW - 2 * HOUR);
  });
});

it('a mark older than the backlog window is logged as clamped, and the night consolidates only the window', async () => {
  await withOwner('nightly-catch-up-clamped', async ({ state, fire }) => {
    const lines = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      state.storage.kv.put(NIGHTLY_THROUGH_KEY, NOW - 10 * DAY);
      const episodes = episodeIndex(state.storage.sql);
      episodes.add('app-1000006', 'owner', 'I swim every Friday before work', NOW - 9 * DAY);
      episodes.add('app-1000008', 'owner', 'my sister is called Mira', NOW - 2 * HOUR);
      await fire(NIGHTLY_ID);
      const nightly = lines.mock.calls.map(call => String(call[0])).filter(line => line.includes('"hop":"nightly_memory"')).map(line => JSON.parse(line) as { code?: string });
      expect(nightly.map(entry => entry.code)).toContain('backlog_clamped');
      expect(model.nights.join('\n')).not.toContain('I swim every Friday');
      expect(learned(state)).toEqual([GROUNDED[0]]);
    } finally { lines.mockRestore(); }
  });
});
