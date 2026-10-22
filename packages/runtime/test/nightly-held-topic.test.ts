// A forget that has not finished withholds only what carries its topic: the nightly pass still runs and learns from every
// other turn, and neither the consolidation model nor the promotion model ever reads the held topic. A pending topic whose
// stores now verify clean finishes on the next turn with no new forget, and unrelated words survive. Synthetic topics only.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { episodeIndex, NIGHTLY_ID, NIGHTLY_THROUGH_KEY, OWNER_SAID } from '../src/channels/episodes';
import { traceBook } from '../src/channels/harness';
import { redactConversationEntries } from '../src/channels/conversation-store';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { forgetPurge, type ForgetStore } from '../src/memory/forget-purge';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { holdTopic } from './helpers/pending-topic';
import { ownerTyped } from './helpers/owner-typed';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const HELD = 'Green tea after lunch settles me';
const UNRELATED = 'The team holds steady instead of rushing';
// The topic spelled with a JSON escape: the literal purge cannot reach this copy, so the forget genuinely stays pending.
const ESCAPED_COPY = `{"note":"green ${String.fromCharCode(92)}u0074ea"}`;
const model = vi.hoisted(() => ({ nights: [] as string[], promotions: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    const format = request.response_format?.name ?? 'reply';
    const said = JSON.stringify(request.messages);
    if (format === 'claim_ops') {
      model.nights.push(said);
      const add = said.includes('I swim every Friday before work') ? [{ kind: 'fact', text: 'Swims every Friday before work', source: 'stated', evidence: '"I swim every Friday before work"', touches_forgotten: false, aliases: [], aliases_touch_forgotten: false }] : [];
      return done(JSON.stringify({ add, corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null }));
    }
    if (format === 'promotion') { model.promotions.push(said); return done('{"nodes":[],"edges":[],"promoted":[]}'); }
    return done('{}');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const openai = vi.hoisted(() => ({ inputs: [] as string[], promotion: '{"nodes":[],"edges":[],"promoted":[]}' }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const input = JSON.stringify(body);
  openai.inputs.push(input);
  const output_text = input.includes('"name":"promotion"') ? openai.promotion : 'Done';
  return { id: 'fixture', output_text, output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');
const { createOwnerResponder } = await import('../src/channels/owner-turn');

const OWNER_ID = '5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
const NOW = Date.parse('2026-10-22T21:46:00Z');
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  model.nights = []; model.promotions = []; openai.inputs = []; openai.promotion = '{"nodes":[],"edges":[],"promoted":[]}';
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

const withOwner = (name: string, work: (state: DurableObjectState, fire: () => Promise<void>) => Promise<void>) =>
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
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      await work(state, async () => {
        await scheduler.schedule({ id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: now - 1000, dueAt: now - 1000, recurrence: null });
        state.storage.kv.put('owner_alarm_last_v1', 1);
        await owner.alarm();
        now += 1000;
      });
    } finally { Date.now = realNow; quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });

describe('the nightly pass with a forget still pending', () => {
  it('runs, learns from every other turn, and never sends the held turn to the model', async () => {
    await withOwner('nightly-held-topic', async (state, fire) => {
      const sql = state.storage.sql;
      const memory = claimStore(sql);
      holdTopic(sql, 'tea', '2026-10-18T08:00:00Z');
      memory.backup('escaped-copy', { note: 'x' }, '2026-10-18T08:00:00Z');
      sql.exec('UPDATE memory_backups SET payload = ?', ESCAPED_COPY);
      state.storage.kv.put(NIGHTLY_THROUGH_KEY, NOW - DAY);
      const episodes = episodeIndex(sql);
      episodes.add('app-1', OWNER_SAID, 'I swim every Friday before work', NOW - 5 * HOUR);
      episodes.add('app-2', OWNER_SAID, HELD, NOW - 4 * HOUR);
      episodes.add('app-2-reply', 'waldo', 'Green TEA it is.', NOW - 4 * HOUR + 1);
      episodes.add('app-3', OWNER_SAID, UNRELATED, NOW - 3 * HOUR);
      const lines = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      let logged: string[] = [];
      try { await fire(); logged = lines.mock.calls.map(call => String(call[0])); } finally { lines.mockRestore(); }
      // The Patrol line says how many turns waited, never which.
      const nightly = logged.filter(line => line.includes('"hop":"nightly_memory"')).map(line => JSON.parse(line) as { ok: boolean; detail?: string });
      expect(nightly).toMatchObject([{ ok: true, detail: expect.stringMatching(/^2 turns, 2 withheld while a forget finishes; /) }]);
      expect(model.nights).toHaveLength(1);
      const night = model.nights[0]!;
      expect(night).toContain('I swim every Friday before work');
      expect(night).toContain(UNRELATED);
      expect(night).not.toMatch(/green tea/i);
      // The pass finished: what it learned is stored and the mark moved past the withheld turns.
      expect(memory.claims().map(claim => claim.text)).toEqual(['Swims every Friday before work']);
      expect(state.storage.kv.get(NIGHTLY_THROUGH_KEY)).toBe(NOW - 3 * HOUR);
      // A copy the purge cannot reach keeps the forget pending.
      expect(memory.pendingTopics()).toEqual(['tea']);
      expect(model.promotions.join('\n')).not.toMatch(/green tea/i);
    });
  });

  it('a chunk where every turn is withheld makes no model call, says so, and moves the mark', async () => {
    await withOwner('nightly-held-topic-all', async (state, fire) => {
      const sql = state.storage.sql;
      holdTopic(sql, 'tea', '2026-10-18T08:00:00Z');
      state.storage.kv.put(NIGHTLY_THROUGH_KEY, NOW - DAY);
      episodeIndex(sql).add('app-2', OWNER_SAID, HELD, NOW - 4 * HOUR);
      const lines = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      let logged: string[] = [];
      try { await fire(); logged = lines.mock.calls.map(call => String(call[0])); } finally { lines.mockRestore(); }
      expect(model.nights).toEqual([]);
      expect(logged.filter(line => line.includes('"hop":"nightly_memory"')).map(line => JSON.parse(line) as { ok: boolean; detail?: string }))
        .toMatchObject([{ ok: true, detail: '0 turns, 1 withheld while a forget finishes' }]);
      expect(state.storage.kv.get(NIGHTLY_THROUGH_KEY)).toBe(NOW - 4 * HOUR);
    });
  });
});

describe('the owner turn with a forget still pending', () => {
  const timer = <T>(_name: string, work: () => Promise<T>) => work();
  it('promotion never reads a claim or node that carries the held topic', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('promote-held-topic')), async (_i, state) => {
      const memory = claimStore(state.storage.sql);
      memory.add({ kind: 'observation', text: 'Has green tea after lunch', source: 'stated', evidence: 'green tea after lunch', origin: 'owner', source_ref: 'owner, app-1' }, '2026-10-19T08:00:00Z');
      memory.add({ kind: 'observation', text: 'The team holds steady', source: 'stated', evidence: 'The team holds steady', origin: 'owner', source_ref: 'owner, app-2' }, '2026-10-20T08:00:00Z');
      memory.saveNode({ id: null, domain: 'food', label: 'Afternoon tea', summary: 'Tea after lunch', strength: 0.5, status: 'active', supporting_spots: [1] }, '2026-10-20T08:00:00Z');
      holdTopic(state.storage.sql, 'tea', '2026-10-18T08:00:00Z');
      await createOwnerResponder('fixture', undefined, memory).promote('promote-1');
      const promotion = openai.inputs.find(input => input.includes('"name":"promotion"'))!;
      expect(promotion).toContain('The team holds steady');
      expect(promotion).not.toMatch(/\btea\b/i);
    });
  });
  it('promotion cannot build a node on held claims even when it names them', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('promote-held-cited')), async (_i, state) => {
      const memory = claimStore(state.storage.sql);
      memory.add({ kind: 'observation', text: 'Has green tea after lunch', source: 'stated', evidence: 'green tea after lunch', origin: 'owner', source_ref: 'owner, app-1' }, '2026-10-19T08:00:00Z');
      memory.add({ kind: 'observation', text: 'Tea again after dinner', source: 'stated', evidence: 'tea again after dinner', origin: 'owner', source_ref: 'owner, app-2' }, '2026-10-20T08:00:00Z');
      holdTopic(state.storage.sql, 'tea', '2026-10-18T08:00:00Z');
      openai.promotion = JSON.stringify({ nodes: [{ id: null, domain: 'food', label: 'Evening ritual', summary: 'A warm drink after meals', strength: 0.7, status: 'active', supporting_spots: [1, 2], durable: true, reason: 'two days' }], edges: [], promoted: [] });
      expect(await createOwnerResponder('fixture', undefined, memory).promote('promote-2')).toContain('nodes0');
      expect(memory.nodes()).toEqual([]);
    });
  });
  it('a pending short topic whose stores now verify clean is settled by the purge job, and unrelated words survive', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('recover-held-topic')), async (_i, state) => {
      const sql = state.storage.sql;
      const memory = claimStore(sql, work => state.storage.transactionSync(work));
      episodeIndex(sql).add('app-1', OWNER_SAID, UNRELATED, 1);
      memory.add({ kind: 'fact', text: 'Works with a team', source: 'stated', evidence: 'The team holds steady', origin: 'owner', source_ref: 'owner, app-1' }, '2026-10-19T08:00:00Z');
      await state.storage.put('conv:1', { id: 'c1', ownerId: 'o', chatId: 'c', parentId: null, threadAnchorId: null, surface: 'app', modelPayload: UNRELATED, appPayload: UNRELATED, modelProjection: { mode: 'include' }, role: 'user' });
      holdTopic(sql, 'tea', '2026-10-18T08:00:00Z');
      const stores: ForgetStore[] = [{ name: 'conversation', run: async (texts) => (await redactConversationEntries(state.storage, texts, FORGOTTEN)).remaining }];
      expect(await forgetPurge({ sql, store: memory, stores, now: Date.now, arm: async () => undefined }).run()).toEqual({ settled: 1, pending: 0 });
      expect(memory.pendingTopics()).toEqual([]);
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes').one().text).toBe(UNRELATED);
      expect(memory.allClaims().map(claim => [claim.text, claim.evidence])).toEqual([['Works with a team', 'The team holds steady']]);
      expect(await state.storage.get('conv:1')).toMatchObject({ modelPayload: UNRELATED, appPayload: UNRELATED });
    });
  });
});
