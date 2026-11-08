// A WhatsApp owner's chain keeps a job's outcome, never its prompt: the owner's next WhatsApp turn reads the Brief they were
// sent, not the transcript and calendar text the Brief was written from. The model is scripted.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

const BRIEF = 'Clear morning, one call at 3.';
const CARD_MARK = '[Scheduled card "The Daily Brief"';
const model = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const reply = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return reply(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}');
    model.asked.push(JSON.stringify(request.messages));
    return reply(String(request.messages.at(-1)?.content ?? '').includes(CARD_MARK) ? BRIEF : 'Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '9e8d7c6b-5a49-4b38-8c27-1f0e9d8c7b6a';
const SUBJECT = '15550005555';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
const wire = vi.hoisted(() => ({ texts: [] as string[] }));

beforeEach(() => {
  model.asked = []; wire.texts = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; text?: { body: string } };
      if (body.type === 'text') wire.texts.push(body.text!.body);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${wire.texts.length}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const withWhatsAppOwner = (name: string, switches: Readonly<Record<string, string>>, run: (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    state.storage.kv.put('wa_last_inbound_ms', Date.now() - 60 * 60_000);
    await state.storage.put('origin', 'https://fixture.invalid');
    const plans = dayPlanBook(state.storage.sql), today = new Date().toISOString().slice(0, 10);
    for (const card of ['card:midday', 'card:close'] as const) plans.save(today, { card, time: null, reason: 'planned by the fixture' });
    plans.save(today, { card: 'card:brief', time: '00:00', reason: 'planned by the fixture' });
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, ...switches, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture',
      WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined } as never);
    try { await run(owner, state); } finally { await state.storage.deleteAlarm(); }
  });
const passes = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState, count: number) => {
  for (let pass = 0; pass < count; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 300)); }
};
const fireBrief = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState) => {
  await new Scheduler(state.storage.sql, state.storage, productionDeps())
    .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: null });
  await passes(owner, state, 3);
  expect(wire.texts).toContain(BRIEF);
};
const ownerSays = async (owner: InstanceType<typeof OwnerDO>, text: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
    method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
    body: JSON.stringify({ messages: [{ from: SUBJECT, id: 'wamid.in.1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] }),
  }));
  expect(response.status).toBe(200);
  await drainWhatsAppTurns(owner);
};
const legacyChain = (state: DurableObjectState) => JSON.stringify([...state.storage.kv.list({ prefix: 'conv:' })]);

describe('a WhatsApp owner\'s chain after a day card', { timeout: 30_000 }, () => {
  it('the owner\'s next turn reads the Brief it was sent and none of the Brief\'s prompt', async () => {
    await withWhatsAppOwner('job-outcome-whatsapp', { WALDO_JOB_OUTCOME_ROWS: '1' }, async (owner, state) => {
      await fireBrief(owner, state);
      await ownerSays(owner, 'Thanks. Anything I should prep?');
      const turn = model.asked.at(-1)!;
      expect(turn).toContain('Anything I should prep?');
      expect(turn).toContain(BRIEF);
      expect(turn).not.toContain(JSON.stringify(CARD_MARK).slice(1, -1));
      expect(legacyChain(state)).not.toContain(JSON.stringify(CARD_MARK).slice(1, -1));
    });
  });

  it('with the switch off, the chain keeps the Brief\'s prompt as it did before', async () => {
    await withWhatsAppOwner('job-outcome-whatsapp-off', {}, async (owner, state) => {
      await fireBrief(owner, state);
      expect(legacyChain(state)).toContain(JSON.stringify(CARD_MARK).slice(1, -1));
    });
  });
});
