import { APP_CONTRACT_HEADER, appHistoryResultV1Schema } from '../../contracts/src/app/core';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { approvalDesk, type AskedOptions } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appApprovalLink } from '../src/channels/surfaces/app';
import type { GoogleClient } from '../src/connectors/google';
import { proposalApplied, receiptLine } from '../src/hooks/receipt-line';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { claimStore } from '../src/memory/claims';

// Staging, 14 Nov: with "Just do it" on, the owner typed in the app "Edit today's Waldo session to specify that I'm working on
// agent fixes and health data fixes". The block had started an hour and more before. The turn recalled notes Waldo had saved
// from documents the owner shared, and the model proposed a rename (a move to the same times with rename_to). Through the real
// owner object, with the switches staging runs: the rename is made, with no card, and reported with an undo.
const proof = vi.hoisted(() => ({ outputs: [] as any[][], inputs: [] as any[], moved: [] as any[], event: null as any }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) proof.inputs.push(input);
  return { id: 'jdi-fixture-reply', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : 'Renamed it.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: any) =>
  method === 'sendMessage' ? { message_id: 1, chat: { id: body.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: () => ({
    events: async () => [proof.event],
    event: async () => proof.event,
    moveEvent: async (id: string, start: string, end: string, etag: string, _marker: string, options?: { title?: string }) => {
      proof.moved.push({ id, start, end, etag, title: options?.title });
      proof.event = { ...proof.event, start, end, ...(options?.title ? { title: options.title } : {}), etag: `${etag}-next` };
      return proof.event;
    },
  }) };
});

type Run = Readonly<{ ledger: { id: string; kind: string; status: string; expires_at: number; created_at: number }[]; presentations: { surface: string }[]; result: string; reply: string }>;
// startedAgo/endsIn: where the owner's block stands when they ask, in minutes.
const appTurn = async (label: string, switches: Record<string, string>, startedAgo = 83, endsIn = 37): Promise<Run> => {
  proof.outputs = []; proof.inputs = []; proof.moved = [];
  const now = Date.now();
  // "Waldo work", 8 to 10 pm: by default the owner asked 83 minutes after it began, 37 before it ends. Their own block, no guests.
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  proof.event = { id: 'ev-waldo', etag: 'etag-1', title: 'Waldo work', status: 'confirmed', all_day: false, start: at(-startedAgo), end: at(endsIn) };
  const name = `${label}-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  let out: Run | undefined;
  await runInDurableObject(stub, async (_unused, state) => {
    const DIRECTORY = 'https://jdi.fixture.invalid', OWNER = '10000000-0000-0000-0000-0000000000c1', AUTH = '20000000-0000-0000-0000-0000000000c1', EMAIL = 'owner@example.test';
    let hash: string | undefined, live = false; const created = new Date().toISOString(), expires = Date.now() + 3_600_000;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_inventory') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created, expires_at: new Date(Date.parse(created) + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'jdi-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'assert_channel_presence') return Response.json(false);
      if (fn === 'health_context_read') return Response.json({ context: null, previous: null });
      return Response.json(null);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-webhook-secret', WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined,
      WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'jdi-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key',
      WALDO_ROUTER_HMAC_SECRET: 'fictional-jdi-router-secret-000000000000000', RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined, GOOGLE_CLIENT_ID: 'fictional-client', GOOGLE_CLIENT_SECRET: 'fictional-secret',
      ...switches };
    const instance = new OwnerDO(state, settings as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('origin', 'https://app.fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
    // Notes Waldo saved while reading documents the owner shared (a profile doc, a personal-context doc): Waldo's read, not the
    // owner's stated words, so recall marks them as possibly carrying someone else's words.
    claimStore(state.storage.sql);
    for (const text of ['From the profile doc: the owner co-founded Waldo and works on Waldo in the evenings', 'From the personal-context doc: priority this month is Waldo agent work'])
      state.storage.sql.exec("INSERT INTO claims (kind, text, source, evidence, origin, status, created_at, last_seen_at, seen_count, verification_status) VALUES ('fact', ?, 'inferred', 'synthetic document note', 'agent', 'active', '2026-11-01', '2026-11-01', 1, 'provisional')", text);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    const app = async (path: string, body?: unknown, credential?: string) => {
      const response = await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}), [APP_CONTRACT_HEADER]: 'approvals=8' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    try {
      expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
      const credential = (await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json() as { credential: string }).credential;
      proof.outputs.push(
        [{ type: 'function_call', call_id: 'rename', name: 'propose_calendar_change', arguments: JSON.stringify({ action: 'move', event_id: 'ev-waldo', title: 'Waldo work',
          rename_to: 'Waldo work: agent fixes and health data fixes', start: proof.event.start, end: proof.event.end, reason: 'Says what tonight is for' }) }],
        [],
      );
      const sent = await (await app('/chat/main/messages', { client_message_id: 'jdi-rename-client-0001', text: "Edit today's Waldo session to specify that I'm working on agent fixes and health data fixes" }, credential)).json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<any>(`app:inbox-record:${sent.message_id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      const ledger = state.storage.sql.exec<{ id: string; kind: string; status: string; created_at: number }>("SELECT id, kind, status, created_at FROM ledger WHERE kind = 'calendar_change'").toArray()
        .map(row => ({ ...row, expires_at: 0 }));
      const listed = (await (await app('/approvals', undefined, credential)).json() as { approvals: { approval_id: string; expires_at: number }[] }).approvals;
      for (const row of ledger) row.expires_at = listed.find(item => item.approval_id === row.id)?.expires_at ?? 0;
      const history = appHistoryResultV1Schema.parse(await (await app('/chat/main', undefined, credential)).json());
      const reply = history.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '';
      const presentations = state.storage.sql.exec<{ surface: string }>('SELECT surface FROM approval_presentations').toArray();
      const result = JSON.stringify(proof.inputs.flatMap(input => Array.isArray(input.input) ? input.input : []).filter((item: any) => item?.type === 'function_call_output' && item.call_id === 'rename').map((item: any) => item.output));
      out = { ledger, presentations, result, reply };
    } finally { (instance as any).ownerBrowser.stop(); await (instance as any).ownerBrowser.maintain(); await state.storage.deleteAlarm(); fetcher.mockRestore(); }
  });
  return out!;
};

const STAGING = { AUTONOMOUS_BY_DEFAULT: '1', AUTONOMY_OWNER_TURNS: '1', HEALTH_EASE_WORKOUT: '1', CALENDAR_UNDO_CANCEL: '1', AUTONOMY_OWN_CALENDAR: '1', APPROVE_IN_CHAT: '1' };

it('an app turn: the owner renames their own block that began an hour ago, after recalling notes from shared documents: made with no card, with an undo', async () => {
  const run = await appTurn('jdi-rename', STAGING);
  expect(proof.moved).toEqual([{ id: 'ev-waldo', start: proof.event.start, end: proof.event.end, etag: 'etag-1', title: 'Waldo work: agent fixes and health data fixes' }]);
  expect(run.ledger).toEqual([expect.objectContaining({ kind: 'calendar_change', status: 'done' })]);
  expect(run.presentations.map(p => p.surface)).toEqual(['asked']);
  expect(run.result).toContain('The owner can undo it');
  expect(run.result).not.toContain('expired');
  // The reply's last line says it was done; it never asks for a yes the owner does not need to give.
  expect(run.reply.endsWith('Done: calendar change')).toBe(true);
  expect(run.reply).not.toContain('Needs your yes');
}, 30_000);

// The 2078 rule alone (AUTONOMY_OWNER_TURNS 0) holds recalled notes Waldo saved from a document as possibly someone else's
// words, so it cards; with the owner rule on, they are what the turn read, not what started it. The card it raises still
// waits for the rest of the event instead of expiring as it is made.
it('the same turn under the 2078 rule alone is a card, and that card stays open until the block ends', async () => {
  const run = await appTurn('jdi-rename-narrow', { ...STAGING, AUTONOMY_OWNER_TURNS: '0' });
  expect(proof.moved).toEqual([]);
  expect(run.ledger).toEqual([expect.objectContaining({ kind: 'calendar_change', status: 'open' })]);
  expect(run.ledger[0]!.expires_at).toBe(Date.parse(proof.event.end));
  expect(run.result).not.toContain('expired');
  expect(run.reply).toContain('Needs your yes: calendar change');
}, 30_000);

it('a rename of a block that has already ended is not made, under any rule', async () => {
  const run = await appTurn('jdi-rename-ended', STAGING, 150, -30);
  expect(proof.moved).toEqual([]);
  expect(run.ledger).toEqual([expect.objectContaining({ kind: 'calendar_change', status: 'expired' })]);
}, 30_000);

// The approval desk on its own, as the owner object wires it, on each surface: the same request is decided the same way.
const NOW = Date.UTC(2026, 10, 14, 15, 53, 0);
const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const deskHarness = (state: DurableObjectState, surface: 'whatsapp' | 'imessage' | 'app', options: Readonly<{ choice?: boolean; startedAgo?: number; endsIn?: number }> = {}) => {
  const moved: string[] = [], cards: string[] = [];
  let n = 0, clock = NOW;
  let event = { id: 'ev-waldo', title: 'Waldo work', start: minutes(-(options.startedAgo ?? 83)), end: minutes(options.endsIn ?? 37), all_day: false, etag: 'v1', status: 'confirmed' };
  const client = {
    account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
    event: async () => event,
    moveEvent: async (_id: string, start: string, end: string, _etag: string, _marker: string, o?: { title?: string }) => { moved.push(o?.title ?? ''); event = { ...event, start, end, title: o?.title ?? event.title, etag: 'v2' }; return event; },
  } as unknown as GoogleClient;
  const desk = approvalDesk(state.storage.sql, {
    owner: 447700900123, surface, appIdentity: () => true, appLink: appApprovalLink, renames: true,
    autonomous: () => options.choice !== false, ownerTurns: () => true, ownerMessageAt: () => NOW,
    call: async (method: string, body: object) => { if (method === 'sendMessage') cards.push((body as { text: string }).text); return { messages: [{ id: `${surface}.card-${cards.length}` }] }; },
    google: async () => client, newId: () => `${++n}`, now: () => clock, timezone: 'UTC', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => clock),
  });
  const rename = (how: AskedOptions) => desk.propose({ action: 'move', event_id: 'ev-waldo', title: 'Waldo work', rename_to: 'Waldo work: agent fixes', start: event.start as never, end: event.end as never, reason: 'what tonight is for' }, `turn-${++n}`, `op-${n}`, how);
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  return { desk, rename, status, moved, cards, at: (ms: number) => { clock = ms; } };
};
const inDesk = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));
// A turn the owner started that has read outside text since (recalled notes from a document); and one outside content started.
const ownerTurnRead: AskedOptions = { asked: false, ownerTurn: { words: "Edit today's Waldo session to say agent fixes", ref: 'msg-1' } };
const mailStarted: AskedOptions = { asked: false };

describe('every surface decides an owner-asked rename of a block under way the same way', () => {
  for (const surface of ['whatsapp', 'imessage', 'app'] as const) {
    it(`${surface}: the owner's turn renames it with no card; a turn mail started gets a card that stays open until the block ends`, () => inDesk(`desk-${surface}`, async state => {
      const f = deskHarness(state, surface);
      const ran = await f.rename(ownerTurnRead);
      expect([f.status(ran), f.moved, f.cards]).toEqual(['done', ['Waldo work: agent fixes'], []]);
      expect(f.desk.askedOutcome(ran)?.undo).toBe(true);
      const carded = await f.rename(mailStarted);
      expect(f.status(carded)).toBe('open');
      // A chat surface sends the card as a message; the app lists it.
      expect(f.cards).toHaveLength(surface === 'app' ? 0 : 1);
      expect(f.desk.pending(NOW).map(item => item.id)).toContain(carded);
      expect(f.moved).toHaveLength(1);
    }));
  }
});

describe('a card about an event already under way', () => {
  it('stays open for the rest of the event, can be approved then, and closes when the event ends', () => inDesk('desk-window', async state => {
    const f = deskHarness(state, 'whatsapp', { choice: false });
    const id = await f.rename(ownerTurnRead);
    expect(f.status(id)).toBe('open');
    f.at(NOW + 36 * 60_000);
    expect(f.desk.pending(NOW + 36 * 60_000).map(item => item.id)).toEqual([id]);
    const later = await f.rename(ownerTurnRead);
    f.at(NOW + 38 * 60_000);
    expect((await f.desk.decide(later, 'a', 'trace')).toast).toBe('This proposal expired');
    expect(f.moved).toEqual([]);
    f.at(NOW + 30 * 60_000);
    expect((await f.desk.decide(id, 'a', 'trace')).toast).toBe('Done');
    expect(f.moved).toEqual(['Waldo work: agent fixes']);
  }));

  it('a move of an event that has not started still closes when it starts, as before', () => inDesk('desk-future', async state => {
    const f = deskHarness(state, 'whatsapp', { choice: false, startedAgo: -60, endsIn: 120 });
    const id = await f.rename(ownerTurnRead);
    f.at(NOW + 61 * 60_000);
    expect((await f.desk.decide(id, 'a', 'trace')).toast).toBe('This proposal expired');
    expect(f.moved).toEqual([]);
  }));
});

describe('the reply\'s receipt line', () => {
  const call = (name: string, seq = 1) => ({ seq, call: { name, args: {} }, ok: true });
  it('a proposal that ran with no card reads as done; one waiting on a card still needs a yes', () => {
    expect(receiptLine([{ ...call('propose_calendar_change'), applied: true }])).toBe('Done: calendar change');
    expect(receiptLine([{ ...call('send_message'), applied: true }, call('propose_calendar_change', 2)])).toBe('Done: message send. Needs your yes: calendar change');
  });
  it('reads applied only from a proposing tool\'s own result', () => {
    expect(proposalApplied('propose_calendar_change', JSON.stringify({ ok: true, data: { applied: true } }))).toBe(true);
    expect(proposalApplied('send_email', JSON.stringify({ ok: true, data: { sent: true } }))).toBe(true);
    expect(proposalApplied('propose_calendar_change', JSON.stringify({ ok: true, data: { applied: false } }))).toBe(false);
    expect(proposalApplied('remember', JSON.stringify({ ok: true, data: { applied: true } }))).toBe(false);
    expect(proposalApplied('propose_calendar_change', 'not json')).toBe(false);
  });
});
