import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { reminderBook } from '../src/channels/reminders';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { CURATED_SKILLS } from '../src/skills/curated-owner';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// A due reminder is a machine turn the owner did not type. Through the real owner object, it sees the owner's skill index
// and can load a procedure on its own; the reminder's read-only tool list is otherwise what it was.
const SKILL = CURATED_SKILLS.find(skill => skill.name === 'reminders-and-watches')!;
const REPLY = 'Time to call Sam.';
const model = vi.hoisted(() => ({ systems: [] as string[], tools: [] as string[][], step: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    model.systems.push(request.system ?? '');
    model.tools.push((request.tools ?? []).map(tool => tool.name));
    return model.step++ === 0 ? done('', [{ call_id: 'load', name: 'skills_load', arguments: JSON.stringify({ name: SKILL.name, version: SKILL.version }) }]) : done(REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5b2c3d4e-6f70-4a81-9b2c-3d4e5f607182';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  model.systems = []; model.tools = []; model.step = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

// Staging runs the harness tool loader, where a deferred tool costs a find_tools hop; skills_load is offered directly.
it.each([['default', undefined], ['harness', 'harness']] as const)('a due reminder loads a reviewed skill unprompted through the owner object, and its tools stay the reminder\'s (%s loader)', async (loader, toolLoader) => {
  const name = `proactive-skill-reminder-${loader}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    traceBook(state.storage.sql);
    const earlier = (ms: number) => () => new Date(Date.now() - ms);
    await reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: earlier(3_600_000) }, () => 'rem-1')
      .set({ note: 'call Sam', at: earlier(30 * 60_000)().toISOString().slice(0, 16), repeat: 'none' });
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_TOOL_LOADER: toolLoader });
    try {
      await state.storage.deleteAlarm();
      await owner.alarm();
      expect(model.systems).toHaveLength(2);
      expect(model.systems[0]).toContain('Reviewed skills (metadata only)');
      expect(model.systems[0]).toContain(`- ${SKILL.name}@${SKILL.version}: ${SKILL.trigger_condition}`);
      expect(model.systems[0]).not.toContain(SKILL.body_markdown);
      expect(model.systems[1]).toContain(SKILL.body_markdown);
      expect(model.tools[0]).toContain('skills_load');
      for (const lifecycle of ['skills_install', 'skills_disable', 'set_reminder', 'send_email']) expect(model.tools[0]).not.toContain(lifecycle);
      expect(model.tools[1]).toEqual(model.tools[0]);
      const traced = state.storage.sql.exec<{ hop: string; ok: number }>("SELECT hop, ok FROM trace_log WHERE hop LIKE 'tool_%' AND hop != 'tool_eligibility' ORDER BY rowid").toArray();
      expect(traced.map(row => [row.hop, row.ok])).toEqual([['tool_skills_load', 1]]);
    } finally { await state.storage.deleteAlarm(); }
  });
});
