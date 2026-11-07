// A task reports where the owner asked for it. An owner with the app and WhatsApp asks on WhatsApp; the jobs lane runs as the
// app (the surface that takes their proactive work), but the report turn runs on WhatsApp's chain and the report reaches the
// WhatsApp chat, never the app's main chat. The model is the only fake.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { dayPlanBook } from '../src/channels/day-cards';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { TASK_JOBS_DUE_KEY } from '../src/scheduler/alarm-slot';
import { jobBook, type JobRow } from '../src/tasks/jobs';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

const ASK = 'Research the five new signups on the public web.';
const REPORT = 'The signups: three founders, one student, one agency.';
const BRIEF = { profile: 'web', title: 'Five signups', goal: 'Look up each new signup on the public web.', context: 'Five names from the owner.', done_when: 'One line each.' };
const model = vi.hoisted(() => ({ reportRequests: [] as string[] }));
const wire = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: LLMGatewayRequest) {
    const reply = (text: string, tool_calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.request.response_format) return reply('{}');
    const asked = JSON.stringify(request.request.messages.at(-1)?.content ?? '');
    if (asked.includes(ASK) && !request.request.tool_turns?.length) return reply('', [{ call_id: 'start', name: 'start_task', arguments: JSON.stringify(BRIEF) }]);
    if (asked.includes('A background task you started has finished')) { model.reportRequests.push(JSON.stringify(request.request.messages)); return reply(REPORT); }
    return reply('Started it; the write-up follows.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '8d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';
const SUBJECT = '15550004444';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  model.reportRequests = []; wire.events = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_log_recent') return Response.json(fn === 'health_log_recent' ? [] : null);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; template?: { name: string }; text?: { body: string } };
      if (body.type) wire.events.push(body.type === 'template' ? `template:${body.template!.name}` : `${body.type}:${body.text?.body ?? ''}`);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${wire.events.length}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('asked on WhatsApp by an owner who also has the app: the task reports in the WhatsApp chat, and the app\'s main chat never shows it', { timeout: 30_000 }, async () => {
  const name = 'task-origin-whatsapp';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    const poolAlarm = vi.spyOn(instance as InstanceType<typeof OwnerDO>, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    const kv = state.storage.kv;
    kv.put('do_name', name);
    kv.put('whatsapp_subject', SUBJECT);
    kv.put('wa_last_inbound_ms', Date.now());
    kv.put('app_subject', String(appSubjectFor(name)));
    kv.put('timezone', 'UTC'); kv.put('timezone_confirmed', true);
    const plans = dayPlanBook(state.storage.sql);
    for (const card of ['card:brief', 'card:midday', 'card:close'] as const) plans.save(today(), { card, time: null, reason: 'planned by the fixture' });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
        body: JSON.stringify({ messages: [{ from: SUBJECT, id: 'wamid.in.1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: ASK } }] }),
      }));
      expect(response.status).toBe(200);
      await drainWhatsAppTurns(owner);

      // The task was asked on WhatsApp, with no card: a web-only task in the owner's own turn.
      const book = jobBook(state.storage.sql, { now: Date.now, newId: () => 'x', newToken: () => 'x' });
      const [job] = state.storage.sql.exec<JobRow>("SELECT * FROM task_jobs WHERE kind = 'task'").toArray();
      expect(job).toMatchObject({ surface: 'whatsapp', profile: 'web', status: 'queued' });
      expect(state.storage.sql.exec("SELECT 1 FROM ledger WHERE kind = 'tainted_action'").toArray()).toEqual([]);

      // Its worker reports; the jobs lane applies the report.
      const ticket = book.startAttempt(job!.id)!;
      expect(book.report(ticket, { status: 'done', summary: 'Five lines.', findings: [{ text: 'Three founders.' }], proposals: [], left: [] }, { rounds: 1, costUsd: 0 })).toBe('accepted');
      await state.storage.put(TASK_JOBS_DUE_KEY, Date.now());
      for (let pass = 0; pass < 4; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 300)); }

      expect(book.get(job!.id)!.status).toBe('applied');
      expect(model.reportRequests).toHaveLength(1);
      // The report turn ran on WhatsApp's chain: it read the WhatsApp exchange where the owner asked.
      expect(model.reportRequests[0]).toContain(ASK);
      expect(wire.events).toContain(`text:${REPORT}`);
      const main = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
      expect(JSON.stringify(await main.json())).not.toContain(REPORT);
    } finally { quiet.mockRestore(); poolAlarm.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
