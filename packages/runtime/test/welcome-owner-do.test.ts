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

// A fresh app-only owner finishes setup in the app: the build starts on that signal alone, before any chat, runs its model
// calls as the owner's job, and writes Waldo's read of the owner's health as nodes; a second signal starts nothing.
const model = vi.hoisted(() => ({ welcome: [] as string[], purposes: [] as string[] }));
// The setup stage cites the owner's own answers by their claim ids, as its input lists them.
const SETUP_ANSWER = (pointer: string | undefined) => JSON.stringify({ nodes: [{ domain: 'people', label: 'Goes by a chosen name', summary: 'Asked Waldo to use the name they go by.', observation: 'Named how Waldo should address them.', source: 'setup', pointers: pointer ? [pointer] : [] }] });
const WELCOME_ANSWER = JSON.stringify({ nodes: [{ domain: 'health', label: 'Late weekend sleeper', summary: 'Sleeps in on weekends, then starts slowly.', observation: 'Weekend nights end later than weeknights.', source: 'apple_health', pointers: ['sleep_midpoint'] }] });
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const body = JSON.stringify(request);
    const text = body.includes('welcome_nodes') ? (model.welcome.push(body), body.includes('Source: what the owner told Waldo') ? SETUP_ANSWER(/\[(c\d+)\] /.exec(body)?.[1]) : WELCOME_ANSWER)
      : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}';
    return { ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c1f0d0e-2b7a-4c43-9a51-0d8f5e3b2a77';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const rpc = vi.hoisted(() => ({ called: [] as string[], series: [] as unknown[], readings: [230, 300], synced: true, otlp: [] as string[] }));
const LANGFUSE = { LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'https://langfuse.test', WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'true' };
const LANGFUSE_URL = 'https://langfuse.test/api/public/otel/v1/traces';
const sample = (day: string, value: number) => ({ signal: 'sleep_midpoint', day, value, method: null, start_at: null, end_at: `${day}T07:00:00.000Z`, timezone: 'UTC' });

beforeEach(() => {
  model.welcome = []; rpc.called = []; rpc.series = []; rpc.readings = [230, 300]; rpc.synced = true; rpc.otlp = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input) === LANGFUSE_URL) { rpc.otlp.push(String(init?.body)); return Response.json({}); }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn) rpc.called.push(fn);
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_consent_list') return Response.json({ consents: ['storage_compute', 'model_processing'].map(purpose => ({ source: 'apple', purpose, status: 'granted', epoch: 1 })) });
    if (fn === 'health_series_read') rpc.series.push(JSON.parse(asked.p_payload!));
    if (fn === 'health_series_read') return Response.json({ access: 'granted', read_at: new Date().toISOString(), sources: [{ source: 'apple', consent_epoch: 1, samples: rpc.synced ? [sample('2026-10-18', rpc.readings[0]!), sample('2026-10-19', rpc.readings[1]!)] : [] }] });
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
      expect(row!.nodes).toBe(2);
      expect(Object.fromEntries(Object.entries(JSON.parse(row!.stages_json) as Record<string, { state: string }>).map(([stage, value]) => [stage, value.state])))
        .toEqual({ health: 'done', calendar: 'skipped', mail: 'skipped', web: 'skipped', setup: 'done' });
      expect(model.welcome).toHaveLength(2);
      expect(model.welcome[0]).toContain('sleep_midpoint (apple_health');
      expect(model.welcome[1]).toContain('Wants to be called Asha');
      // The gift is the owner's last thirty days of health: today in their zone and the twenty-nine days before it.
      const today = new Date().toISOString().slice(0, 10), from = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      expect(rpc.series).toEqual([expect.objectContaining({ from, to: today })]);
      const node = state.storage.sql.exec<{ label: string; supporting_spots: string }>('SELECT label, supporting_spots FROM constellation_nodes').toArray();
      expect(node.map(row => row.label)).toEqual(['Late weekend sleeper', 'Goes by a chosen name']);
      const [support] = JSON.parse(node[0]!.supporting_spots) as number[];
      expect(state.storage.sql.exec('SELECT origin, source, source_ref FROM claims WHERE id = ?', support).one()).toEqual({ origin: 'agent', source: 'inferred', source_ref: 'welcome:apple_health:sleep_midpoint' });
      // No DO table holds a number from the health input. Whole numbers only: a millisecond time or a digest carries the same
      // digits inside a longer run.
      for (const table of ['claims', 'constellation_nodes', 'welcome_builds']) {
        for (const value of state.storage.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${table}`).toArray().flatMap(row => Object.values(row))) {
          if (typeof value !== 'string') continue;
          const numbers = (value.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g) ?? []).map(Number);
          expect(numbers, table).not.toContain(230); expect(numbers, table).not.toContain(300);
        }
      }

      // Forgetting the node from the app takes Waldo's read behind it too, and bars the label.
      const runtime = (owner as unknown as { setup(channel: string): { act(action: object, current: () => Promise<void>): Promise<unknown> } }).setup('app');
      const nodeId = state.storage.sql.exec<{ id: number }>("SELECT id FROM constellation_nodes WHERE label = 'Late weekend sleeper'").one().id;
      expect(await runtime.act({ action: 'node.forget', id: String(nodeId), value: '' }, async () => {})).toBe(true);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM constellation_nodes').one().n).toBe(1);
      expect(state.storage.sql.exec("SELECT status FROM claims WHERE id = ?", support).toArray().map(row => row.status)).not.toContain('active');
      // Forgetting the node drawn from the setup answers takes Waldo's read, never the owner's own answer.
      const setupNode = state.storage.sql.exec<{ id: number; supporting_spots: string }>("SELECT id, supporting_spots FROM constellation_nodes WHERE label = 'Goes by a chosen name'").one();
      const [read] = JSON.parse(setupNode.supporting_spots) as number[];
      expect(await runtime.act({ action: 'node.forget', id: String(setupNode.id), value: '' }, async () => {})).toBe(true);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM constellation_nodes').one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT status FROM claims WHERE id = ?", read).toArray().map(row => row.status)).not.toContain('active');
      expect(state.storage.sql.exec("SELECT status FROM claims WHERE text = 'Wants to be called Asha'").toArray().map(row => row.status)).toEqual(['active']);

      // The second signal, the first-run complete, starts nothing new.
      await app('/app/v1/onboarding/actions', { request_id: 'welcome-start-01', action: 'start' });
      await app('/app/v1/onboarding/actions', { request_id: 'welcome-complete-1', action: 'complete' });
      await app('/app/v1/onboarding/answers', { request_id: 'welcome-answers-2', name: 'Asha K' });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(model.welcome).toHaveLength(2);
      expect(build()).toHaveLength(1);
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
      expect(model.welcome.some((body) => body.includes('apple_health'))).toBe(false);
      // The first readings land: the upload's notice takes the empty health stage up once.
      rpc.synced = true;
      const runtime = (owner as unknown as { setup(channel: string): { healthSamples(): Promise<void> } }).setup('app');
      await runtime.healthSamples();
      await vi.waitFor(() => expect(stagesOf()).toEqual({ finished: true, health: 'done' }), { timeout: 15_000, interval: 25 });
      expect(state.storage.sql.exec<{ label: string }>('SELECT label FROM constellation_nodes').toArray().map((row) => row.label)).toContain('Late weekend sleeper');
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

it('an owner who keeps health out of memory gets a build that reads no health and writes no health node', async () => {
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
      // Nothing connected and health kept out: the owner's own answers still give the first node, and no health is read.
      expect([build()[0]!.nodes, model.welcome.length]).toEqual([1, 1]);
      expect(model.welcome[0]).toContain('Wants to be called Asha');
      expect(state.storage.sql.exec<{ domain: string }>('SELECT domain FROM constellation_nodes').toArray()).toEqual([{ domain: 'people' }]);
      expect(rpc.called.filter((fn) => fn.startsWith('health_'))).toEqual([]);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('each welcome stage closes its model call\'s trace with a machine root, one trace per run, and the export carries no reading', async () => {
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
      expect(model.welcome).toHaveLength(2);
      const roots = state.storage.sql.exec<{ trace: string; ok: number }>("SELECT trace, ok FROM trace_log WHERE hop = 'machine_turn'").toArray();
      expect(roots.map(root => root.trace).sort()).toEqual([expect.stringMatching(/^welcome:health:\d+$/), expect.stringMatching(/^welcome:setup:\d+$/)]);
      expect(roots.every(root => root.ok === 1)).toBe(true);
      await vi.waitFor(() => expect(spans().filter(span => span.name === 'app.machine').map(key).sort()).toEqual(roots.map(root => root.trace).sort()));
      for (const root of roots) expect(spans().filter(span => key(span) === root.trace && span.name !== 'app.machine').some(span => span.name.startsWith('llm_'))).toBe(true);
      const wire = rpc.otlp.join('\n');
      for (const reading of ['231.37', '307.61', 'sleep_midpoint (apple_health', 'Wants to be called Asha']) expect(wire, reading).not.toContain(reading);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
