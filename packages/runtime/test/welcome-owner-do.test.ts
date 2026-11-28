import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { NIGHTLY_ID } from '../src/channels/episodes';
import { HEALTH_MEMORY_KEY } from '../src/channels/health-memory';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { WELCOME_SETUP_GAP_MS } from '../src/onboarding/welcome';

// A fresh app-only owner finishes setup in the app: the build starts on that signal alone, before any chat, runs its model
// calls as the owner's job, writes Waldo's read of the owner's health zone words as spots, and the join draws a constellation
// from them; a second signal starts no second build.
const model = vi.hoisted(() => ({ welcome: [] as string[], joins: [] as string[], hold: false }));
const HEALTH_SPOTS = ['Recovery and Form run low after the weekend', 'Recovery runs good midweek'];
const WELCOME_ANSWER = JSON.stringify({ spots: HEALTH_SPOTS.map((text) => ({ area: 'body', text, source: 'apple_health', pointers: ['recovery', 'form'] })) });
// The join's answer: the two health spots, by the ids its input lists them under.
const JOIN_ANSWER = (body: string) => {
  const spots = HEALTH_SPOTS.map((text) => new RegExp(`<spot id=\\\\"(\\d+)\\\\"[^>]*>${text}<`).exec(body)?.[1]).filter(Boolean).map(Number);
  return JSON.stringify({ constellations: [{ id: null, replaces: [], area: 'body', label: 'Slow starts after weekends', summary: 'You start the week low and pick up by midweek.', strength: 0.6, spots }], links: [], promoted: [] });
};
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const body = JSON.stringify(request);
    // A held join waits on a flag the test clears; a promise made in the test's context would never settle in this one.
    if (model.hold && body.includes('"name":"promotion"')) { model.joins.push(body); while (model.hold) await new Promise((resolve) => setTimeout(resolve, 10)); model.joins.pop(); }
    if (body.includes('onboarding_summary')) { model.welcome.push(body); return { ok: true as const, data: { model: request.model, text: JSON.stringify({ summary: 'You go by Asha and keep long stretches for focused work.', questions: [{ text: 'When do you usually train?' }, { text: 'Who do you plan your week with?' }] }), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } }; }
    const text = body.includes('welcome_nodes') ? (model.welcome.push(body), WELCOME_ANSWER)
      : body.includes('"name":"promotion"') ? (model.joins.push(body), JOIN_ANSWER(body))
      : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}';
    return { ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c1f0d0e-2b7a-4c43-9a51-0d8f5e3b2a77';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const rpc = vi.hoisted(() => ({ called: [] as string[], zones: [] as unknown[], readings: [230, 300], synced: true, consented: true, otlp: [] as string[] }));
const LANGFUSE = { LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'https://langfuse.test', WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'true' };
const LANGFUSE_URL = 'https://langfuse.test/api/public/otel/v1/traces';
// Zone words by day; the plane never sends a reading here, and one planted beside them must reach no prompt and no row.
const zoneDays = () => rpc.synced ? [1, 0].map((back, index) => ({ day: new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10), recovery: index ? 'good' : 'low', form: index ? 'moderate' : 'low', hrv: rpc.readings[index] })) : [];

beforeEach(() => {
  model.welcome = []; model.joins = []; model.hold = false; rpc.called = []; rpc.zones = []; rpc.readings = [230, 300]; rpc.synced = true; rpc.consented = true; rpc.otlp = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input) === LANGFUSE_URL) { rpc.otlp.push(String(init?.body)); return Response.json({}); }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn) rpc.called.push(fn);
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_consent_list') return Response.json({ consents: (rpc.consented ? ['storage_compute', 'model_processing'] : []).map(purpose => ({ source: 'apple', purpose, status: 'granted', epoch: 1 })) });
    if (fn === 'health_zones_read') { rpc.zones.push(JSON.parse(asked.p_payload!)); return Response.json({ zones: { days: zoneDays() } }); }
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('setup done in the app starts one welcome build for an app-only owner who has not chatted, and it writes Waldo\'s read', async () => {
  const name = `welcome-owner-${crypto.randomUUID()}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const app = (path: string, body: unknown) => owner.fetch(new Request(`https://telegram-owner${path}`, { method: 'POST',
      headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const build = () => state.storage.sql.exec<{ finished_at: number | null; stages_json: string; nodes: number }>('SELECT finished_at, stages_json, nodes FROM welcome_builds').toArray();
    try {
      expect(state.storage.kv.get('app_subject')).toBeUndefined();
      const saved = await app('/app/v1/onboarding/answers', { request_id: 'welcome-answers-1', name: 'Asha' });
      expect(saved.status).toBe(200);
      // The setup signal is the owner's own act, so it binds the app as their surface: their jobs, this one included, are admitted.
      expect(state.storage.kv.get('app_subject')).toBe(String(appSubjectFor(name)));
      await vi.waitFor(() => expect(build()[0]?.finished_at).not.toBeNull(), { timeout: 15_000, interval: 25 });
      const [row] = build();
      expect(row!.nodes).toBe(1);
      expect(Object.fromEntries(Object.entries(JSON.parse(row!.stages_json) as Record<string, { state: string }>).map(([stage, value]) => [stage, value.state])))
        .toEqual({ health: 'done', calendar: 'skipped', mail: 'skipped', web: 'skipped', setup: 'done' });
      // One stage call, over zone words; the setup answers are spots already. One join then reads every spot together.
      expect(model.welcome).toHaveLength(1);
      expect(model.welcome[0]).toMatch(/Recovery: \w+ · Form: \w+/);
      expect(model.joins).toHaveLength(1);
      for (const text of ['Wants to be called Asha', ...HEALTH_SPOTS]) expect(model.joins[0]).toContain(text);
      // The gift is the owner's last thirty days of health: today in their zone and the twenty-nine days before it, as zones.
      const today = new Date().toISOString().slice(0, 10), from = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      expect(rpc.zones).toEqual([{ from, to: today }]);
      expect(rpc.called).not.toContain('health_series_read');
      const node = state.storage.sql.exec<{ label: string; supporting_spots: string }>('SELECT label, supporting_spots FROM constellation_nodes').toArray();
      expect(node.map(row => row.label)).toEqual(['Slow starts after weekends']);
      const supports = JSON.parse(node[0]!.supporting_spots) as number[];
      expect(supports.map((id) => state.storage.sql.exec('SELECT origin, source, source_ref FROM claims WHERE id = ?', id).one()))
        .toEqual(supports.map(() => ({ origin: 'agent', source: 'inferred', source_ref: 'welcome:apple_health:recovery,form' })));
      // No DO table holds a number from the health input, and no prompt does. Whole numbers only: a millisecond time or a digest
      // carries the same digits inside a longer run.
      for (const table of ['claims', 'constellation_nodes', 'welcome_builds']) {
        for (const value of state.storage.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${table}`).toArray().flatMap(row => Object.values(row))) {
          if (typeof value !== 'string') continue;
          const numbers = (value.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g) ?? []).map(Number);
          expect(numbers, table).not.toContain(230); expect(numbers, table).not.toContain(300);
        }
      }
      for (const body of [...model.welcome, ...model.joins]) expect(body).not.toMatch(/\b(230|300)\b/);

      // Forgetting the constellation from the app takes Waldo's reads only it rested on, never the owner's own answer, and the
      // joins that new answers set off do not build it again.
      const runtime = (owner as unknown as { setup(channel: string): { act(action: object, current: () => Promise<void>): Promise<unknown> } }).setup('app');
      const nodeId = state.storage.sql.exec<{ id: number }>("SELECT id FROM constellation_nodes WHERE label = 'Slow starts after weekends'").one().id;
      expect(await runtime.act({ action: 'node.forget', id: String(nodeId), value: '' }, async () => {})).toBe(true);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM constellation_nodes').one().n).toBe(0);
      for (const id of supports) expect(state.storage.sql.exec("SELECT status FROM claims WHERE id = ?", id).toArray().map(row => row.status)).not.toContain('active');
      expect(state.storage.sql.exec("SELECT status FROM claims WHERE text = 'Wants to be called Asha'").toArray().map(row => row.status)).toEqual(['active']);

      // The second signal, the first-run complete, starts no second build; a changed answer after the build is joined again.
      await app('/app/v1/onboarding/actions', { request_id: 'welcome-start-01', action: 'start' });
      await app('/app/v1/onboarding/actions', { request_id: 'welcome-complete-1', action: 'complete' });
      // The gap since the setup stage last settled is spent, so the changed answer is joined at once.
      const stages = JSON.parse(state.storage.sql.exec<{ stages_json: string }>('SELECT stages_json FROM welcome_builds').one().stages_json) as Record<string, { at: number }>;
      stages.setup!.at -= WELCOME_SETUP_GAP_MS;
      state.storage.sql.exec('UPDATE welcome_builds SET stages_json = ?', JSON.stringify(stages));
      await app('/app/v1/onboarding/answers', { request_id: 'welcome-answers-2', name: 'Asha K' });
      await vi.waitFor(() => expect(model.joins.some((body) => body.includes('Wants to be called Asha K'))).toBe(true), { timeout: 15_000, interval: 25 });
      expect(model.welcome).toHaveLength(1);
      expect(build()).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM constellation_nodes').one().n).toBe(0);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('health that lands after the welcome build read none is read once more on the next upload, and the build writes Waldo\'s read', async () => {
  const name = `welcome-owner-late-${crypto.randomUUID()}`;
  rpc.synced = false;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const stagesOf = () => {
      const [row] = state.storage.sql.exec<{ finished_at: number | null; stages_json: string }>('SELECT finished_at, stages_json FROM welcome_builds').toArray();
      return row && { finished: row.finished_at !== null, health: (JSON.parse(row.stages_json) as Record<string, { state: string }>).health!.state };
    };
    try {
      await owner.fetch(new Request('https://telegram-owner/app/v1/onboarding/answers', { method: 'POST',
        headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ request_id: 'welcome-answers-late', name: 'Asha' }) }));
      await vi.waitFor(() => expect(stagesOf()).toEqual({ finished: true, health: 'empty' }), { timeout: 15_000, interval: 25 });
      expect(model.welcome).toEqual([]);
      // The first readings land: the upload's notice takes the empty health stage up once.
      rpc.synced = true;
      const runtime = (owner as unknown as { setup(channel: string): { healthSamples(): Promise<void> } }).setup('app');
      await runtime.healthSamples();
      await vi.waitFor(() => expect(stagesOf()).toEqual({ finished: true, health: 'done' }), { timeout: 15_000, interval: 25 });
      await vi.waitFor(() => expect(state.storage.sql.exec<{ label: string }>('SELECT label FROM constellation_nodes').toArray().map((row) => row.label)).toContain('Slow starts after weekends'), { timeout: 15_000, interval: 25 });
      // Once: a later upload reads nothing again.
      const asked = model.welcome.length;
      await runtime.healthSamples();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(model.welcome).toHaveLength(asked);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('with no upload, the night takes an empty health stage up once more', async () => {
  const name = `welcome-owner-night-${crypto.randomUUID()}`;
  rpc.synced = false;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    // The night runs only once the owner's zone is confirmed.
    state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const health = () => (JSON.parse(state.storage.sql.exec<{ stages_json: string }>('SELECT stages_json FROM welcome_builds').toArray()[0]?.stages_json ?? '{}') as Record<string, { state: string }>).health?.state;
    try {
      await owner.fetch(new Request('https://telegram-owner/app/v1/onboarding/answers', { method: 'POST',
        headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ request_id: 'welcome-answers-night', name: 'Asha' }) }));
      await vi.waitFor(() => expect(health()).toBe('empty'), { timeout: 15_000, interval: 25 });
      rpc.synced = true;
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      await scheduler.schedule({ id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 1);
      await owner.alarm();
      await vi.waitFor(() => expect(health()).toBe('done'), { timeout: 15_000, interval: 25 });
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('an owner who keeps health out of memory gets a build that reads no health and builds no health constellation', async () => {
  const name = `welcome-owner-off-${crypto.randomUUID()}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put(HEALTH_MEMORY_KEY, false);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const build = () => state.storage.sql.exec<{ finished_at: number | null; stages_json: string; nodes: number }>('SELECT finished_at, stages_json, nodes FROM welcome_builds').toArray();
    try {
      const saved = await owner.fetch(new Request('https://telegram-owner/app/v1/onboarding/answers', { method: 'POST',
        headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ request_id: 'welcome-answers-off', name: 'Asha' }) }));
      expect(saved.status).toBe(200);
      await vi.waitFor(() => expect(build()[0]?.finished_at).not.toBeNull(), { timeout: 15_000, interval: 25 });
      expect(JSON.parse(build()[0]!.stages_json).health.state).toBe('skipped');
      // Nothing connected and health kept out: the owner's own answer reaches the join with no stage call, no health is read,
      // and one answer is not yet a pattern.
      expect([build()[0]!.nodes, model.welcome.length, model.joins.length]).toEqual([0, 0, 1]);
      expect(model.joins[0]).toContain('Wants to be called Asha');
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM constellation_nodes').one().n).toBe(0);
      expect(rpc.called.filter((fn) => fn.startsWith('health_'))).toEqual([]);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('each welcome stage and the join close their model call\'s trace with a machine root, one trace per run, and the export carries no reading', async () => {
  rpc.readings = [231.37, 307.61];
  const name = `welcome-owner-trace-${crypto.randomUUID()}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, ...LANGFUSE, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    type Span = { name: string; attributes: { key: string; value: { stringValue?: string } }[] };
    const spans = () => rpc.otlp.flatMap(body => (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }).resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans)));
    const key = (span: Span) => span.attributes.find(a => a.key === 'langfuse.observation.metadata.trace_key')?.value.stringValue;
    try {
      const saved = await owner.fetch(new Request('https://telegram-owner/app/v1/onboarding/answers', { method: 'POST',
        headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ request_id: 'welcome-answers-trace', name: 'Asha' }) }));
      expect(saved.status).toBe(200);
      await vi.waitFor(() => expect(state.storage.sql.exec<{ finished_at: number | null }>('SELECT finished_at FROM welcome_builds').one().finished_at).not.toBeNull(), { timeout: 15_000, interval: 25 });
      expect([model.welcome.length, model.joins.length]).toEqual([1, 1]);
      const roots = state.storage.sql.exec<{ trace: string; ok: number }>("SELECT trace, ok FROM trace_log WHERE hop = 'machine_turn'").toArray();
      expect(roots.map(root => root.trace).sort()).toEqual([expect.stringMatching(/^join:welcome:\d+$/), expect.stringMatching(/^welcome:health:\d+$/)]);
      expect(roots.every(root => root.ok === 1)).toBe(true);
      await vi.waitFor(() => expect(spans().filter(span => span.name === 'app.machine').map(key).sort()).toEqual(roots.map(root => root.trace).sort()));
      for (const root of roots) expect(spans().filter(span => key(span) === root.trace && span.name !== 'app.machine').some(span => span.name.startsWith('llm_'))).toBe(true);
      const wire = rpc.otlp.join('\n');
      // The stage call's input (the zone words) is never exported; the join's input is spots, with no reading in it.
      for (const reading of ['231.37', '307.61', 'Recovery: low']) expect(wire, reading).not.toContain(reading);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('an answer sent on its own reaches the join with the others: no stage reads again, health is read once, the same words ask nothing', async () => {
  const name = `welcome-owner-refine-${crypto.randomUUID()}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, WELCOME_V2: '1', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const answer = (body: Record<string, unknown>) => owner.fetch(new Request('https://telegram-owner/app/v1/onboarding/answers', { method: 'POST',
      headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const row = () => state.storage.sql.exec<{ finished_at: number | null; stages_json: string }>('SELECT finished_at, stages_json FROM welcome_builds').toArray()[0];
    // The gap since the setup stage last settled is spent, so the next one runs at once.
    const spendGap = () => {
      const stages = JSON.parse(row()!.stages_json) as Record<string, { at: number }>;
      stages.setup!.at -= WELCOME_SETUP_GAP_MS;
      state.storage.sql.exec('UPDATE welcome_builds SET stages_json = ?', JSON.stringify(stages));
    };
    try {
      expect((await answer({ request_id: 'refine-1', name: 'Asha' })).status).toBe(200);
      await vi.waitFor(() => expect(row()?.finished_at).not.toBeNull(), { timeout: 15_000, interval: 25 });
      expect(model.joins).toHaveLength(1);
      expect(rpc.zones).toHaveLength(1);
      const stageCalls = model.welcome.length;

      spendGap();
      expect((await answer({ request_id: 'refine-2', day: { shape: 'focus', own_words: '' } })).status).toBe(200);
      await vi.waitFor(() => expect(model.joins).toHaveLength(2), { timeout: 15_000, interval: 25 });
      expect(model.joins[1]).toContain('Wants to be called Asha');
      expect(model.joins[1]).toContain('Needs long stretches of focus at work');
      await vi.waitFor(() => expect(row()?.finished_at).not.toBeNull(), { timeout: 15_000, interval: 25 });
      // The answers are spots already: no stage asked the model again, and health was not read again.
      expect(model.welcome).toHaveLength(stageCalls);
      expect(rpc.zones).toHaveLength(1);

      // The same words under a new request change no claim, so nothing is asked.
      spendGap();
      expect((await answer({ request_id: 'refine-3', day: { shape: 'focus', own_words: '' } })).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(model.joins).toHaveLength(2);

      // Answers sent while a join is running reach one more join after it, together. Onboarding requests share the owner's lane
      // with the join, so they wait behind it and are saved once it returns.
      model.hold = true;
      spendGap();
      expect((await answer({ request_id: 'refine-4', slips: { picked: ['replies'], own_words: '' } })).status).toBe(200);
      await vi.waitFor(() => expect(model.joins.some((body) => body.includes('replies and follow-ups'))).toBe(true), { timeout: 15_000, interval: 25 });
      const later = [answer({ request_id: 'refine-5', wearable: 'garmin' }), answer({ request_id: 'refine-6', slips: { picked: ['replies', 'breaks'], own_words: '' } })];
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      model.hold = false;
      expect((await Promise.all(later)).map((saved) => saved.status)).toEqual([200, 200]);
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(WELCOME_SETUP_GAP_MS); expect(model.joins).toHaveLength(4); }, { timeout: 15_000, interval: 25 });
      vi.useRealTimers();
      for (const said of ['Wears a Garmin watch', 'breaks and meals']) expect(model.joins[3]).toContain(said);
      await vi.waitFor(() => expect(row()?.finished_at).not.toBeNull(), { timeout: 15_000, interval: 25 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(model.joins).toHaveLength(4);
      expect(model.welcome).toHaveLength(stageCalls);
      expect(rpc.zones).toHaveLength(1);
    } finally { vi.useRealTimers(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 60_000);

it('health connected after the first answer started the build is read once its first readings land, not left out of the first constellation', async () => {
  const name = `welcome-owner-health-after-${crypto.randomUUID()}`;
  rpc.consented = false;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, WELCOME_V2: '1', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const health = () => (JSON.parse(state.storage.sql.exec<{ stages_json: string }>('SELECT stages_json FROM welcome_builds').toArray()[0]?.stages_json ?? '{}') as Record<string, { state: string }>).health?.state;
    try {
      await owner.fetch(new Request('https://telegram-owner/app/v1/onboarding/answers', { method: 'POST',
        headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ request_id: 'health-after-1', name: 'Asha' }) }));
      await vi.waitFor(() => expect(health()).toBe('skipped'), { timeout: 15_000, interval: 25 });
      rpc.consented = true;
      const runtime = (owner as unknown as { setup(channel: string): { healthSamples(): Promise<void> } }).setup('app');
      await runtime.healthSamples();
      await vi.waitFor(() => expect(health()).toBe('done'), { timeout: 15_000, interval: 25 });
      await vi.waitFor(() => expect(state.storage.sql.exec<{ label: string }>("SELECT label FROM constellation_nodes WHERE status = 'active'").toArray().map((row) => row.label)).toContain('Slow starts after weekends'), { timeout: 15_000, interval: 25 });
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('the goal given at setup reaches the join with the other answers, as the owner\'s words and never a spot', async () => {
  const name = `welcome-owner-goal-${crypto.randomUUID()}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const saved = await owner.fetch(new Request('https://telegram-owner/app/v1/onboarding/answers', { method: 'POST',
        headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json', 'x-waldo-app-contract': 'onboarding=5' },
        body: JSON.stringify({ request_id: 'welcome-goal-1', name: 'Asha', goal: { own_words: 'Finish my first HYROX', by: '2027-03-14' } }) }));
      expect(saved.status).toBe(200);
      await vi.waitFor(() => expect(state.storage.sql.exec<{ finished_at: number | null }>('SELECT finished_at FROM welcome_builds').toArray()[0]?.finished_at).not.toBeNull(), { timeout: 15_000, interval: 25 });
      const join = model.joins.at(-1)!;
      expect(join).toContain('From setup:\\nThe owner\'s goal from setup. Working toward, in their own words: \\"Finish my first HYROX\\", by 2027-03-14.');
      expect(join).toContain('Wants to be called Asha');
      expect(join).not.toMatch(/<spot [^>]*>[^<]*Finish my first HYROX/);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('the onboarding summary is written by one traced owner job over the answers and the join\'s constellations, and an answered question reaches the next join as Waldo\'s question', async () => {
  const name = `welcome-owner-summary-${crypto.randomUUID()}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const post = (path: string, body: unknown) => owner.fetch(new Request(`https://telegram-owner${path}`, { method: 'POST',
      headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const row = () => state.storage.sql.exec<{ finished_at: number | null; stages_json: string }>('SELECT finished_at, stages_json FROM welcome_builds').toArray()[0];
    try {
      expect((await post('/app/v1/onboarding/answers', { request_id: 'summary-answers-1', name: 'Asha', day: { shape: 'focus', own_words: '' } })).status).toBe(200);
      await vi.waitFor(() => expect(row()?.finished_at).not.toBeNull(), { timeout: 15_000, interval: 25 });
      const written = await post('/app/v1/onboarding/summary', { request_id: 'summary-owner-0001' });
      expect(written.status).toBe(200);
      const { summary } = await written.json() as { summary: { summary: string; questions: { id: string; text: string }[] } };
      expect(summary.summary).toBe('You go by Asha and keep long stretches for focused work.');
      const asked = model.welcome.find((body) => body.includes('onboarding_summary'))!;
      expect(asked).toContain('Wants to be called Asha');
      expect(asked).toContain('Needs long stretches of focus at work');
      expect(asked).toContain('Slow starts after weekends');
      const roots = state.storage.sql.exec<{ trace: string; ok: number }>("SELECT trace, ok FROM trace_log WHERE hop = 'machine_turn' AND trace LIKE 'onboarding-summary:%'").toArray();
      expect(roots).toEqual([expect.objectContaining({ ok: 1 })]);
      const stages = JSON.parse(row()!.stages_json) as Record<string, { at: number }>;
      stages.setup!.at -= WELCOME_SETUP_GAP_MS;
      state.storage.sql.exec('UPDATE welcome_builds SET stages_json = ?', JSON.stringify(stages));
      const [train, plan] = summary.questions;
      expect((await post('/app/v1/onboarding/summary/questions', { request_id: 'summary-owner-q1', question_id: train!.id, action: 'answer', text: 'Before work, three days a week.' })).status).toBe(200);
      expect((await post('/app/v1/onboarding/summary/questions', { request_id: 'summary-owner-q2', question_id: plan!.id, action: 'defer' })).status).toBe(200);
      const answered = state.storage.sql.exec<{ id: number; text: string }>("SELECT id, text FROM claims WHERE status = 'active'").toArray().find((claim) => claim.text === 'Answered a question at setup: "Before work, three days a week."');
      expect(answered).toBeDefined();
      expect(state.storage.sql.exec<{ title: string }>("SELECT title FROM loops WHERE status = 'open'").toArray().map((row) => row.title)).toEqual(['Ask the owner when it fits, Waldo\'s question from setup (not the owner\'s words): "Who do you plan your week with?"']);
      await vi.waitFor(() => expect(model.joins.at(-1)).toContain(`Spot ${answered!.id} answers Waldo's setup question (Waldo's words, not the owner's): \\"When do you usually train?\\"`), { timeout: 15_000, interval: 25 });
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
