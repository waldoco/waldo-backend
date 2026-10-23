// The nightly promotion reads the owner's whole memory. A night after which that memory reads the same as when it was last
// promoted makes no promotion call; an edited claim, or a promotion that never applied, makes one. Synthetic claims only.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { CONSTELLATION_DIGEST_KEY, NIGHTLY_ID } from '../src/channels/episodes';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

const openai = vi.hoisted(() => ({ promotions: 0, promotion: '{"nodes":[],"edges":[],"promoted":[]}' }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const input = JSON.stringify(body);
  const promoting = input.includes('"name":"promotion"');
  if (promoting) openai.promotions += 1;
  return { id: 'fixture', output_text: promoting ? openai.promotion : 'Done', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c5b4a3d-2e1f-4b0a-9d8e-7f6a5b4c3d2e';
const NOW = Date.parse('2026-10-22T03:00:00Z');
const DAY = 86_400_000;
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  openai.promotions = 0; openai.promotion = '{"nodes":[],"edges":[],"promoted":[]}';
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

type Hop = Readonly<{ hop: string; ok: boolean; detail?: string }>;
const withOwner = (name: string, work: (state: DurableObjectState, night: () => Promise<readonly Hop[]>) => Promise<void>) =>
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
        const lines = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
          await owner.alarm();
          return lines.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Hop)
            .filter(line => line.hop === 'constellation');
        } finally { lines.mockRestore(); now += DAY; }
      });
    } finally { Date.now = realNow; quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });

const seed = (state: DurableObjectState) => {
  const memory = claimStore(state.storage.sql);
  memory.add({ kind: 'preference', text: 'Prefers calls after ten', source: 'stated', evidence: 'calls after ten', origin: 'owner', source_ref: 'owner, app-1' }, '2026-10-19T08:00:00Z');
  memory.add({ kind: 'fact', text: 'Works with a small team', source: 'stated', evidence: 'a small team', origin: 'owner', source_ref: 'owner, app-2' }, '2026-10-20T08:00:00Z');
  return memory;
};

describe('the nightly promotion gate', () => {
  it('a night with the same memory makes no promotion call', async () => {
    await withOwner('promote-gate-unchanged', async (state, night) => {
      seed(state);
      expect((await night()).map(hop => hop.ok)).toEqual([true]);
      expect(openai.promotions).toBe(1);
      expect(state.storage.kv.get(CONSTELLATION_DIGEST_KEY)).toMatch(/^[0-9a-f]{64}$/);
      expect((await night()).map(hop => hop.ok)).toEqual([true]);
      expect(state.storage.sql.exec<{ note: string }>("SELECT note FROM trace_log WHERE hop = 'constellation' ORDER BY rowid").toArray().map(row => row.note).at(-1)).toBe('unchanged');
      expect(openai.promotions).toBe(1);
    });
  });
  it('an edited claim makes one promotion call', async () => {
    await withOwner('promote-gate-edited', async (state, night) => {
      const memory = seed(state);
      await night();
      const [first] = memory.claims();
      state.storage.sql.exec('UPDATE claims SET text = ? WHERE id = ?', 'Prefers calls after eleven', first!.id);
      await night();
      expect(openai.promotions).toBe(2);
      await night();
      expect(openai.promotions).toBe(2);
    });
  });
  it('a promotion that failed leaves no digest, so the next night promotes again', async () => {
    await withOwner('promote-gate-failed', async (state, night) => {
      seed(state);
      openai.promotion = 'not json';
      expect((await night()).map(hop => hop.ok)).toEqual([false]);
      expect(state.storage.kv.get(CONSTELLATION_DIGEST_KEY)).toBeUndefined();
      openai.promotion = '{"nodes":[],"edges":[],"promoted":[]}';
      expect((await night()).map(hop => hop.ok)).toEqual([true]);
      expect(openai.promotions).toBe(2);
      expect(state.storage.kv.get(CONSTELLATION_DIGEST_KEY)).toMatch(/^[0-9a-f]{64}$/);
    });
  });
  it('a promotion that changed memory stores the digest of what it left, so the next night is quiet', async () => {
    await withOwner('promote-gate-applied', async (state, night) => {
      const memory = claimStore(state.storage.sql);
      memory.add({ kind: 'observation', text: 'Took calls after ten on Monday', source: 'stated', evidence: 'calls after ten', origin: 'owner', source_ref: 'owner, app-1' }, '2026-10-19T08:00:00Z');
      memory.add({ kind: 'observation', text: 'Took calls after ten on Tuesday', source: 'stated', evidence: 'calls after ten again', origin: 'owner', source_ref: 'owner, app-2' }, '2026-10-20T08:00:00Z');
      const spots = memory.claims().map(claim => claim.id);
      openai.promotion = JSON.stringify({ nodes: [{ id: null, domain: 'work', label: 'Late mornings', summary: 'Calls land after ten', strength: 0.6, status: 'active', supporting_spots: spots, durable: true, reason: 'two days' }], edges: [], promoted: [] });
      await night();
      expect(claimStore(state.storage.sql).nodes()).toHaveLength(1);
      await night();
      expect(openai.promotions).toBe(1);
    });
  });
});
