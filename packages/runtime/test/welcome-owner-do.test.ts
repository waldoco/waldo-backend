import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// A fresh app-only owner finishes setup in the app: the build starts on that signal alone, before any chat, runs its model
// calls as the owner's job, and writes Waldo's read of the owner's health as nodes; a second signal starts nothing.
const model = vi.hoisted(() => ({ welcome: [] as string[], purposes: [] as string[] }));
const WELCOME_ANSWER = JSON.stringify({ nodes: [{ domain: 'health', label: 'Late weekend sleeper', summary: 'Sleeps in on weekends, then starts slowly.', observation: 'Weekend nights end later than weeknights.', source: 'apple_health', pointers: ['sleep_midpoint'] }] });
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const body = JSON.stringify(request);
    const text = body.includes('welcome_nodes') ? (model.welcome.push(body), WELCOME_ANSWER)
      : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}';
    return { ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c1f0d0e-2b7a-4c43-9a51-0d8f5e3b2a77';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const rpc = vi.hoisted(() => ({ called: [] as string[] }));
const sample = (day: string, value: number) => ({ signal: 'sleep_midpoint', day, value, method: null, start_at: null, end_at: `${day}T07:00:00.000Z`, timezone: 'UTC' });

beforeEach(() => {
  model.welcome = []; rpc.called = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn) rpc.called.push(fn);
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_consent_list') return Response.json({ consents: ['storage_compute', 'model_processing'].map(purpose => ({ source: 'apple', purpose, status: 'granted', epoch: 1 })) });
    if (fn === 'health_series_read') return Response.json({ access: 'granted', read_at: new Date().toISOString(), sources: [{ source: 'apple', consent_epoch: 1, samples: [sample('2026-10-18', 230), sample('2026-10-19', 300)] }] });
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
        .toEqual({ health: 'done', calendar: 'skipped', mail: 'skipped', web: 'skipped' });
      expect(model.welcome).toHaveLength(1);
      expect(model.welcome[0]).toContain('sleep_midpoint (apple_health');
      const node = state.storage.sql.exec<{ label: string; supporting_spots: string }>('SELECT label, supporting_spots FROM constellation_nodes').toArray();
      expect(node.map(row => row.label)).toEqual(['Late weekend sleeper']);
      const [support] = JSON.parse(node[0]!.supporting_spots) as number[];
      expect(state.storage.sql.exec('SELECT origin, source, source_ref FROM claims WHERE id = ?', support).one()).toEqual({ origin: 'agent', source: 'inferred', source_ref: 'welcome:apple_health:sleep_midpoint' });
      // No DO table holds a number from the health input.
      for (const table of ['claims', 'constellation_nodes', 'welcome_builds']) {
        for (const value of state.storage.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${table}`).toArray().flatMap(row => Object.values(row))) {
          if (typeof value === 'string') { expect(value).not.toContain('230'); expect(value).not.toContain('300'); }
        }
      }

      // Forgetting the node from the app takes Waldo's read behind it too, and bars the label.
      const runtime = (owner as unknown as { setup(channel: string): { act(action: object, current: () => Promise<void>): Promise<unknown> } }).setup('app');
      const nodeId = state.storage.sql.exec<{ id: number }>('SELECT id FROM constellation_nodes').one().id;
      expect(await runtime.act({ action: 'node.forget', id: String(nodeId), value: '' }, async () => {})).toBe(true);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM constellation_nodes').one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT status FROM claims WHERE id = ?", support).toArray().map(row => row.status)).not.toContain('active');

      // The second signal, the first-run complete, starts nothing new.
      await app('/app/v1/onboarding/actions', { request_id: 'welcome-start-01', action: 'start' });
      await app('/app/v1/onboarding/actions', { request_id: 'welcome-complete-1', action: 'complete' });
      await app('/app/v1/onboarding/answers', { request_id: 'welcome-answers-2', name: 'Asha K' });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(model.welcome).toHaveLength(1);
      expect(build()).toHaveLength(1);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
