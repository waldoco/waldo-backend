// An approval card raised for an owner whose only surface is WhatsApp, by a standing order that runs while the 24-hour window
// is closed, through the real scheduler, desk, window layer and webhook admission. The card is not held as text and not recorded
// as presented: it waits, and goes out on the owner's next message, which is when its presentation is recorded and the approval
// opens. Approving it then sends the email once.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { reminderBook } from '../src/channels/reminders';
import { standingOrderBook } from '../src/channels/standing-orders';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

const REPORT = 'Drafted the weekly numbers email to Sam for your approval.';
const OWNER_SAYS = 'Morning, Waldo.';
const EMAIL = { to: ['sam@example.test'], subject: 'Weekly numbers', body_markdown: 'Hi Sam, the weekly numbers are attached below.' };
// The order's turn proposes the email, then reports; the owner's own turns answer 'Noted.'. Each tool result the order's turn
// got back is kept, so a test can read what the proposing tool told the model.
const model = vi.hoisted(() => ({ orders: 0, toolResults: [] as string[] }));
// Every message that reached WhatsApp, in order, with the id WhatsApp gave it; 'turn' marks where the owner's own turn ran.
const wire = vi.hoisted(() => ({ events: [] as string[], ids: new Map<string, string>(), wamid: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: LLMGatewayRequest) {
    const reply = (text: string, tool_calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.request.response_format) return reply('{}');
    const asked = JSON.stringify(request.request.messages.at(-1)?.content ?? '');
    const results = request.request.tool_turns ?? [];
    if (asked.includes('[Standing order due now')) {
      if (!results.length) { model.orders += 1; return reply('', [{ call_id: 'propose-email', name: 'send_email', arguments: JSON.stringify(EMAIL) }]); }
      model.toolResults.push(...results.map(turn => turn.output));
      return reply(REPORT);
    }
    if (asked.includes(OWNER_SAYS)) wire.events.push('turn');
    return reply('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const mail = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (...args: Parameters<typeof original.googleClient>) => args[0].clientId !== 'approval-fixture' ? original.googleClient(...args) : ({
    sendRaw: async (raw: string) => { mail.sent.push(raw); return { message_id: 'gmail-1' }; },
    findSentByMessageId: async (messageId: string) => mail.sent.length ? { message_id: 'gmail-1', thread_id: 'thread-1', rfc822_message_id: messageId, label_ids: ['SENT'] } : false,
  }) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const SUBJECT = '15550003333';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
const google = { GOOGLE_CLIENT_ID: 'approval-fixture', GOOGLE_CLIENT_SECRET: 'fictional-secret' };
const HOUR = 60 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  model.orders = 0; model.toolResults = []; mail.sent = []; wire.events = []; wire.ids = new Map(); wire.wamid = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; template?: { name: string }; text?: { body: string } };
      const event = body.type === 'template' ? `template:${body.template!.name}` : `text:${body.text!.body}`;
      wire.wamid += 1;
      wire.events.push(event); wire.ids.set(event, `wamid.out.${wire.wamid}`);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, '') }], messages: [{ id: `wamid.out.${wire.wamid}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Approval = { id: string; kind: string; status: string };
type Shown = { surface: string; message_ref: string; approvable: number; presented_at: number };
const isCard = (id: string) => (event: string) => event.startsWith('text:Send this email?') && event.includes(`reply "a:${id}"`);

// Unless a test says otherwise the owner last wrote 30 hours ago, so the window is closed. Today's cards are already planned, so
// the runtime's boot neither plans nor arms them: only the standing order fires.
const owned = async (name: string, script: (steps: Readonly<{
  alarms(passes: number): Promise<void>;
  // A daily order set an hour ago for half an hour ago, so its first run is due now.
  order(): Promise<void>;
  reply(text: string): Promise<void>;
  // Runs the step with the clock moved forward, as when the owner next writes much later.
  later<T>(ms: number, step: () => Promise<T>): Promise<T>;
  approvals(): Approval[];
  shown(id: string): Shown[];
  held(): string[];
  // A console forget of a memory that names the text, as a stated fact (spot) or a pattern (node).
  forget(kind: 'node' | 'spot', text: string): Promise<boolean | string>;
  // A forget the purge has not finished: a fact naming the text, still waiting to be cleaned from every store.
  purging(text: string): void;
  // A reminder due now: its turn is the next owner turn that finishes an unfinished forget, with the card still waiting.
  reminder(): Promise<void>;
  // The owner's WhatsApp is bound to another number, as a confirmed link, a reconciled admission or an unlink and relink do.
  rebind(subject: string): void;
  // The owner writes from the given number.
  replyFrom(subject: string, text: string): Promise<void>;
}>) => Promise<void>, wrote = 30 * HOUR) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    state.storage.kv.put('wa_last_inbound_ms', Date.now() - wrote);
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'fictional-not-a-token', scopes: null }]);
    const plans = dayPlanBook(state.storage.sql);
    for (const card of ['card:brief', 'card:midday', 'card:close'] as const) plans.save(today(), { card, time: null, reason: 'planned by the fixture' });
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, ...google, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    let seq = 0;
    const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const internals = owner as unknown as { bindWhatsApp(subject: string | null): void; runtimes: Record<string, unknown>; whatsappInflight: Set<Promise<void>>;
      setup(channel: string): { act(input: { action: 'node.forget' | 'spot.forget'; id: string; value: string }): Promise<boolean | string> } };
    const replyFrom = async (subject: string, text: string) => {
      seq += 1;
      const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': subject },
        body: JSON.stringify({ messages: [{ from: subject, id: `wamid.in.${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] }),
      }));
      expect(response.status).toBe(200);
      await Promise.all([...internals.whatsappInflight]);
    };
    try {
      await script({
        // A queued record falls due 250 ms after it is written, so each pass waits that out. The wake a pass armed is cleared
        // first, so the platform does not run this object's alarm on its own meanwhile.
        alarms: async passes => { for (let pass = 0; pass < passes; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 300)); } },
        order: async () => {
          const clock = { timezone: 'UTC', now: () => new Date(Date.now() - HOUR) };
          const at = new Date(Date.now() - 30 * 60_000).toISOString().slice(11, 16);
          await standingOrderBook(state.storage.sql, scheduler, clock, () => 'ord1').set({ scope: 'email Sam the weekly numbers', trigger: 'daily', at, gate: 'act_and_report', escalation: 'log_only' });
        },
        reply: text => replyFrom(SUBJECT, text),
        replyFrom: (subject, text) => replyFrom(subject, text),
        forget: async (kind, text) => {
          if (kind === 'node') state.storage.sql.exec("INSERT INTO constellation_nodes(domain,label,summary,strength,status,first_seen,last_confirmed,supporting_spots) VALUES ('work',?,'synthetic',0.5,'active','now','now','[]')", text);
          else memory.add({ kind: 'fact', text, source: 'stated', evidence: `"${text}"`, origin: 'owner' }, new Date().toISOString());
          const id = kind === 'node' ? memory.nodes().find(row => row.label === text)!.id : memory.claims().find(row => row.text === text)!.id;
          return internals.setup('whatsapp').act({ action: `${kind}.forget`, id: String(id), value: '' });
        },
        purging: text => {
          memory.add({ kind: 'fact', text, source: 'stated', evidence: `"${text}"`, origin: 'owner' }, new Date().toISOString());
          memory.setStatus(memory.claims().find(row => row.text === text)!.id, 'purging');
        },
        reminder: async () => {
          const clock = { timezone: 'UTC', now: () => new Date(Date.now() - HOUR) };
          await reminderBook(state.storage.sql, scheduler, clock, () => 'rem-1').set({ note: 'stretch', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
        },
        rebind: subject => { state.storage.transactionSync(() => internals.bindWhatsApp(subject)); internals.runtimes = {}; },
        later: async (ms, step) => {
          const now = Date.now;
          Date.now = () => now() + ms;
          try { return await step(); } finally { Date.now = now; }
        },
        approvals: () => state.storage.sql.exec<Approval>('SELECT id, kind, status FROM ledger ORDER BY created_at').toArray(),
        shown: id => state.storage.sql.exec<Shown>('SELECT surface, message_ref, approvable, presented_at FROM approval_presentations WHERE approval_id = ?', id).toArray(),
        held: () => [...state.storage.kv.list<{ body: { text: string } }>({ prefix: 'wa_held:' })].map(([, record]) => record.body.text),
      });
    } finally { await state.storage.deleteAlarm(); }
  });
};

// Each alarm pass waits out the 250 ms a queued record takes to fall due, so these run past the 5 s default.
describe('an approval card for a WhatsApp-only owner raised while the 24-hour window is closed', { timeout: 30_000 }, () => {
  it('is neither held nor recorded as presented; it goes out on the next message, opens then, and is decided once', async () => {
    await owned('wa-held-approval', async ({ alarms, order, reply, approvals, shown, held }) => {
      await order();
      await alarms(4);
      expect(model.orders).toBe(1);
      const [approval] = approvals();
      expect(approval).toMatchObject({ kind: 'email_send', status: 'card_unconfirmed' });
      const id = approval!.id;
      expect(shown(id)).toEqual([]);
      // Only the knock reached WhatsApp; the card is not waiting as held text either.
      expect(wire.events).toEqual(['template:waldo_update_ready']);
      expect(held().some(text => text.includes('Send this email?'))).toBe(false);
      // The proposing tool told the model the card waits, not that it is in the chat.
      expect(model.toolResults.join('\n')).toContain('goes out here when the owner next writes');
      expect(model.toolResults.join('\n')).not.toContain('review card requested in chat');

      const replied = Date.now();
      await reply(OWNER_SAYS);
      const cards = wire.events.filter(isCard(id));
      expect(cards).toHaveLength(1);
      // The card goes out before the reply's own turn, after the report the order queued.
      expect(wire.events.slice(0, 4)).toEqual(['template:waldo_update_ready', `text:${REPORT}`, cards[0], 'turn']);
      expect(approvals()).toMatchObject([{ id, status: 'open' }]);
      const [presentation] = shown(id);
      expect(shown(id)).toHaveLength(1);
      expect(presentation).toMatchObject({ surface: 'whatsapp', message_ref: wire.ids.get(cards[0]!), approvable: 1 });
      expect(presentation!.presented_at).toBeGreaterThanOrEqual(replied);

      await reply(`a:${id}`);
      expect(mail.sent).toHaveLength(1);
      expect(approvals()).toMatchObject([{ id, status: 'done' }]);
      expect(wire.events.filter(event => event.startsWith('text:Sent: Send email from owner@example.test to sam@example.test'))).toHaveLength(1);
      await reply(`a:${id}`);
      expect(mail.sent).toHaveLength(1);
      expect(wire.events.filter(event => event === 'text:Already handled.')).toHaveLength(1);
      expect(wire.events.filter(event => event.startsWith('text:Sent: '))).toHaveLength(1);
      // A later message sends nothing that waited, and the card never went out twice.
      await reply(OWNER_SAYS);
      expect(wire.events.filter(isCard(id))).toHaveLength(1);
    });
  });

  it('goes out at once with its WhatsApp id while the window is open', async () => {
    await owned('wa-open-approval', async ({ alarms, order, approvals, shown }) => {
      await order();
      await alarms(4);
      const [approval] = approvals();
      expect(approval).toMatchObject({ kind: 'email_send', status: 'open' });
      const cards = wire.events.filter(isCard(approval!.id));
      expect(cards).toHaveLength(1);
      expect(shown(approval!.id)).toMatchObject([{ surface: 'whatsapp', message_ref: wire.ids.get(cards[0]!), approvable: 1 }]);
      expect(wire.events).not.toContain('template:waldo_update_ready');
    }, HOUR);
  });

  it('expires unseen, and is never sent, when the owner writes only after the approval expired', async () => {
    await owned('wa-held-approval-stale', async ({ alarms, order, reply, later, approvals, shown }) => {
      await order();
      await alarms(4);
      const [approval] = approvals();
      expect(approval).toMatchObject({ status: 'card_unconfirmed' });

      await later(13 * HOUR, () => reply(OWNER_SAYS));
      expect(wire.events.some(isCard(approval!.id))).toBe(false);
      expect(approvals()).toMatchObject([{ id: approval!.id, status: 'expired' }]);
      expect(shown(approval!.id)).toEqual([]);
    });
  });
});

describe('a waiting approval card the owner may no longer be shown', { timeout: 30_000 }, () => {
  it.each(['spot', 'node'] as const)('is never sent after a console forget (%s) that names it', async kind => {
    await owned(`wa-held-approval-forget-${kind}`, async ({ alarms, order, reply, forget, approvals }) => {
      await order();
      await alarms(4);
      const [approval] = approvals();
      expect(approval).toMatchObject({ kind: 'email_send', status: 'card_unconfirmed' });
      expect(await forget(kind, 'Weekly numbers')).toBe(true);
      expect(approvals()).toMatchObject([{ id: approval!.id, status: 'skipped' }]);
      await reply(OWNER_SAYS);
      expect(wire.events.some(event => event.includes('Weekly numbers'))).toBe(false);
      expect(wire.events.some(isCard(approval!.id))).toBe(false);
      expect(wire.events).toContain('turn');
      expect(mail.sent).toEqual([]);
    });
  });

  it('is never sent after an unfinished forget that names it is finished by a later turn, even a scheduled one', async () => {
    await owned('wa-held-approval-forget-retry', async ({ alarms, order, reminder, purging, approvals }) => {
      await order();
      await alarms(4);
      const [approval] = approvals();
      expect(approval).toMatchObject({ kind: 'email_send', status: 'card_unconfirmed' });
      purging('Weekly numbers');
      await reminder();
      await alarms(3);
      expect(approvals()).toMatchObject([{ id: approval!.id, status: 'skipped' }]);
      expect(wire.events.some(event => event.includes('Weekly numbers'))).toBe(false);
      expect(mail.sent).toEqual([]);
    });
  });

  it('is never sent to a number linked after it was made', async () => {
    const NEW = '15550004444';
    await owned('wa-held-approval-rebind', async ({ alarms, order, rebind, replyFrom, approvals, shown }) => {
      await order();
      await alarms(4);
      const [approval] = approvals();
      expect(approval).toMatchObject({ status: 'card_unconfirmed' });
      rebind(NEW);
      await replyFrom(NEW, OWNER_SAYS);
      expect(wire.events.some(isCard(approval!.id))).toBe(false);
      expect(shown(approval!.id)).toEqual([]);
      expect(approvals()).toMatchObject([{ id: approval!.id, status: 'card_unconfirmed' }]);
    });
  });
});
