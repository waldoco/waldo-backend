// The planning Brief (PLANNING_BRIEF) for an owner whose only surface is WhatsApp, through the real owner object, outbox and
// window layer. WhatsApp shows no answers to tap here, so the Brief is not offered them and asks in words; a change it raises
// goes out as WhatsApp's own approval card, and the calendar changes only when the owner approves it. The model is scripted.
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

const BRIEF = 'The Brief\nBack to back until 4:45, with Team sync on top of your deck time. Want me to move Team sync to 5?';
const model = vi.hoisted(() => ({ briefTools: [] as string[][], briefRounds: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const reply = (text: string, tool_calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return reply(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    if (!asked.includes('[Scheduled card "The Brief"')) return reply('Noted.');
    model.briefTools.push((request.tools ?? []).map(tool => tool.name));
    if (model.briefRounds++ === 0) return reply('', [{ call_id: 'move-sync', name: 'propose_calendar_change', arguments: JSON.stringify(MOVE) }]);
    return reply(BRIEF);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const calendar = vi.hoisted(() => ({ moved: [] as string[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (...args: Parameters<typeof original.googleClient>) => args[0].clientId !== 'planning-wa-fixture' ? original.googleClient(...args) : ({
    account: { connection_id: null, email: 'owner@example.test' },
    events: async () => [SYNC],
    event: async () => ({ ...SYNC, etag: 'etag-1' }),
    moveEvent: async (id: string) => { calendar.moved.push(id); return { id, etag: 'etag-2' }; },
  }) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '8d7c6b5a-4938-4a27-9b16-0f5e4d3c2b1a';
const SUBJECT = '15550004444';
const today = () => new Date().toISOString().slice(0, 10);
// Hours from now, not fixed clock times: a move to a time already past is refused, so fixed times fail late in the day.
const hoursAhead = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SYNC = { id: 'ev-sync', title: 'Team sync', start: hoursAhead(1), end: hoursAhead(3.5), status: 'confirmed' };
const MOVE = { action: 'move', event_id: 'ev-sync', title: 'Team sync', start: hoursAhead(5), end: hoursAhead(6), reason: 'Free the afternoon for the deck' };
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
const google = { GOOGLE_CLIENT_ID: 'planning-wa-fixture', GOOGLE_CLIENT_SECRET: 'fictional-secret', WALDO_OAUTH_STATE_SECRET: 'fictional-state-secret' };
const wire = vi.hoisted(() => ({ texts: [] as string[], other: [] as string[] }));

beforeEach(() => {
  model.briefTools = []; model.briefRounds = 0; calendar.moved = []; wire.texts = []; wire.other = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; text?: { body: string } };
      if (body.type === 'text') wire.texts.push(body.text!.body); else wire.other.push(body.type);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${wire.texts.length + wire.other.length}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the planning Brief on WhatsApp', { timeout: 30_000 }, () => {
  it('asks in words with no answers to tap, sends its change as an approval card, and moves the event only on approval', async () => {
    const name = 'planning-brief-whatsapp';
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('whatsapp_subject', SUBJECT);
      state.storage.kv.put('wa_last_inbound_ms', Date.now() - 60 * 60_000);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'fictional-not-a-token', scopes: null }]);
      const plans = dayPlanBook(state.storage.sql);
      for (const card of ['card:midday', 'card:close'] as const) plans.save(today(), { card, time: null, reason: 'planned by the fixture' });
      plans.save(today(), { card: 'card:brief', time: '00:00', reason: 'planned by the fixture' });
      const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, ...google, PLANNING_BRIEF: '1', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture',
        WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined } as never);
      const passes = async (count: number) => { for (let pass = 0; pass < count; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 300)); } };
      try {
        await new Scheduler(state.storage.sql, state.storage, productionDeps())
          .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: null });
        await passes(4);

        expect(model.briefTools[0]).toContain('propose_calendar_change');
        expect(model.briefTools[0]).not.toContain('offer_replies');
        const [approval] = state.storage.sql.exec<{ id: string; kind: string; status: string }>('SELECT id, kind, status FROM ledger ORDER BY created_at').toArray();
        expect(approval).toMatchObject({ kind: 'calendar_change', status: 'open' });
        // Both reached WhatsApp as text: the card first, as a card raised during a turn always is, then the Brief that asks.
        const card = wire.texts.findIndex(text => text.includes(`a:${approval!.id}`)), brief = wire.texts.indexOf(BRIEF);
        expect(card).toBeGreaterThanOrEqual(0);
        expect(brief).toBeGreaterThan(card);
        expect(wire.other).toEqual([]);
        expect(calendar.moved).toEqual([]);

        const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
          method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
          body: JSON.stringify({ messages: [{ from: SUBJECT, id: 'wamid.in.1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: `a:${approval!.id}` } }] }),
        }));
        expect(response.status).toBe(200);
        await drainWhatsAppTurns(owner);
        await passes(2);
        expect(calendar.moved).toEqual(['ev-sync']);
      } finally { await state.storage.deleteAlarm(); }
    });
  });
});
