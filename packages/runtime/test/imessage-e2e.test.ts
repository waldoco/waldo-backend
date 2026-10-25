import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { IMessageBridgeDO, iMessageBridgeName } from '../src/channels/imessage/bridge-do';
import { sha256Hex } from '../src/channels/imessage/crypto';
import { IMessageFinalOutbox, targetOf } from '../src/channels/imessage/final-outbox';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { ProgressPacer } from '../src/channels/progress-pacer';
import { BridgeStore } from '../src/channels/imessage/bridge-store';
import { gmailPushBook } from '../src/channels/gmail-push';
import { PROPOSED_LOCAL_TEST_POLICY } from '../src/channels/imessage/policy';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost, type Delivery } from './helpers/imessage-sim-host';
import { appSubjectFor } from '../src/channels/app-api';
import { consoleAuth } from '../src/identity/console-auth';
import { PROACTIVE_SURFACE_KEY } from '../src/channels/proactive-surface';
import { reminderBook } from '../src/channels/reminders';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import type { ScheduleEntry } from '@waldo/contracts';
import { reminderDue, remindInTwoHours, scheduleNext } from './helpers/reminder-wake';
import { dayPlanBook } from '../src/channels/day-cards';
import { HEARTBEAT_EVERY_MS, HEARTBEAT_ID } from '../src/channels/heartbeat';
import { loopBook } from '../src/channels/loops';
import { ensureSchema } from '../src/tracer/schema';
import { TelegramFinalOutbox, outboxRunNotes } from '../src/channels/telegram-final-outbox';
import { observeIMessageReports } from '../src/channels/imessage/scheduled-route';
import { OwnerDO } from '../src/channels/owner-do';
import type { OwnerHost } from '../src/channels/imessage/owner-runtime';
import { reconnectNoticeText } from '../src/connectors/google-reconnect';
import { CONNECT_BUTTON_SENT } from '../src/tools/live/connect-text';

// Scripted model: every non-structured responses.create call is one owner turn.
// A progress_note call is the progress writer: it answers the next scripted note, after progressHold if one is set.
const proof = vi.hoisted(() => ({ turns: [] as string[], systems: [] as string[], reply: 'Scripted owner reply.', hold: null as null | (() => Promise<void>), outputs: [] as any[][],
  notes: [] as (string | null)[], progressInputs: [] as string[], progressHold: null as null | (() => Promise<void>), googleDead: false }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) { proof.turns.push(JSON.stringify(input.input ?? '')); proof.systems.push(String(input.instructions ?? '')); if (proof.hold) { const h = proof.hold; proof.hold = null; await h(); } }
  if (format === 'progress_note') {
    proof.progressInputs.push(JSON.stringify(input.input ?? ''));
    if (proof.progressHold) { const h = proof.progressHold; proof.progressHold = null; await h(); }
    return { id: 'scripted', output: [], output_text: JSON.stringify({ note: proof.notes.length ? proof.notes.shift() : 'Working through your request now.' }), usage: { input_tokens: 1, output_tokens: 1 } };
  }
  return { id: 'scripted', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.reply, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
// A dead grant, when a test asks for one: the calendar read reports invalid_grant to the host and fails 401.
vi.mock('../src/connectors/google', async load => { const original = await load<typeof import('../src/connectors/google')>(); return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, health?: (error: string) => void) => ({
  event: async (id: string) => ({ id, etag: 'etag-3pm', title: 'Design review', status: 'confirmed', start: '2030-01-02T15:00:00Z', end: '2030-01-02T16:00:00Z' }),
  ...(proof.googleDead ? { calendarPage: async () => { health?.('google token failed: invalid_grant'); throw new original.GoogleError(401, 'google token failed: invalid_grant'); } } : {}),
}) }; });

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
const forbiddenEgress: string[] = [];
let addresses = 0;

afterEach(() => { vi.restoreAllMocks(); proof.turns = []; proof.systems = []; proof.hold = null; proof.outputs = []; proof.notes = []; proof.progressInputs = []; proof.progressHold = null; proof.googleDead = false; });

async function world(ownerName = `imsg-owner-${crypto.randomUUID()}`, ownerId = '10000000-0000-4000-8000-000000000001') {
  // Each world counts only its own test's egress.
  forbiddenEgress.length = 0;
  const owners: FixtureOwner[] = [{ do_name: ownerName, owner_id: ownerId, state: 'active', state_version: 1, admission_revision: 1 }];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners, extra: (fn) => {
    if (fn === 'console_session_touch' || fn === 'console_session_open' || fn === 'console_session_open_for') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane') return Response.json(null);
    if (fn === 'admin_overview') return Response.json(null);
    return null;
  } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    const url = String(input instanceof Request ? input.url : input);
    // Google is down here: the scheduled watch upkeep of an owner with a seeded account fails closed without leaving the isolate.
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
    forbiddenEgress.push(url);
    throw new Error(`forbidden egress ${new URL(url).origin}`);
  });
  const ownerStub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(ownerName));
  let session = '', csrf = '';
  await runInDurableObject(ownerStub, async (_i, state) => {
    state.storage.kv.put('do_name', ownerName);
    session = await consoleAccess(state.storage).grant();
    csrf = (await consoleAccess(state.storage).session(session))!.csrf;
  });
  const cookie = `waldo_console=${session}; waldo_owner=${ownerName}.session_fixture.${await routerSignature(SECRET, 0, `cookie.${ownerName}.session_fixture`)}`;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  // Each world's host has its own address, as each paired Mac does, so the edge limit counts this test's requests only.
  const address = `2001:db8::${(++addresses).toString(16)}`;
  const call = (request: Request) => {
    if (!request.headers.has('cf-connecting-ip')) request.headers.set('cf-connecting-ip', address);
    return worker.fetch(request, env, ctx);
  };
  const action = (name: string, fields: Record<string, string> = {}, token = csrf) => {
    const form = new FormData(); form.set('action', name); form.set('csrf', token);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return call(new Request('https://imessage.fixture.invalid/console/action', { method: 'POST', body: form, headers: { cookie, origin: HOST_ORIGIN }, redirect: 'manual' }));
  };
  const host = new SimulatedHost(call, HOST_ORIGIN);
  const bridgeStub = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  const settle = async () => { while (pending.length) await pending.shift(); };
  /** Drives both DOs' persisted wakes until no work is left (alarms are run explicitly). */
  const pump = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) { await runDurableObjectAlarm(bridgeStub()); await settle(); await runDurableObjectAlarm(ownerStub); await settle(); }
  };
  const pairAndActivate = async () => {
    const issued = await action('imessage.pair'); expect(issued.status).toBe(200); expect(issued.headers.get('cache-control')).toBe('no-store');
    const code = (await issued.text()).split('\n')[0]!;
    expect((await host.redeem(code)).status).toBe(200);
    const challenge = (await (await action('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
    expect((await host.send(host.message(challenge))).status).toBe(200);
    expect((await action('imessage.activate', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
    expect((await host.heartbeat()).status).toBe(200);
    expect((await host.capabilities()).status).toBe(200);
    return { code, challenge };
  };
  // The new console's read-then-act, as the dashboard sends it.
  const dashboard = async (name: string, fields: Record<string, string> = {}) => {
    const read = await call(new Request(`${HOST_ORIGIN}/console/dashboard/api/v1/controls?view=imessage`, { headers: { cookie, accept: 'application/json' } }));
    const controls = await read.json() as { csrf: string; revision: string };
    const body = new URLSearchParams({ csrf: controls.csrf, revision: controls.revision, view: 'imessage', action: name, request_id: `e2e-${crypto.randomUUID()}`, ...fields });
    const response = await call(new Request(`${HOST_ORIGIN}/console/dashboard/api/v1/actions`, { method: 'POST', headers: { cookie, origin: HOST_ORIGIN, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }));
    return { status: response.status, body: await response.json() };
  };
  return { fx, ownerName, ownerStub, action, dashboard, host, bridgeStub, call, pump, settle, pairAndActivate, csrf };
}

it('pairs with an owner-confirmed challenge; pending credentials reach no owner turn or command', async () => {
  const w = await world();
  expect((await w.action('imessage.pair', {}, 'wrong-csrf')).status).toBe(403);
  const code = (await (await w.action('imessage.pair')).text()).split('\n')[0]!;
  expect(code).toMatch(/^wim_[a-f0-9]{48}$/);
  const redeemed = await w.host.redeem(code);
  expect(redeemed.status).toBe(200);
  expect(redeemed.headers.get('cache-control')).toBe('no-store');
  expect(await redeemed.json()).toMatchObject({ version: 1, state: 'pending_verification', credential: { kind: 'hmac-sha256' } });
  expect((await w.host.redeem(code)).status).toBe(401); // one use
  // Pending scope: heartbeat/capability evidence only; no private turns or commands.
  expect((await w.host.heartbeat()).status).toBe(200);
  expect((await w.host.pull()).status).toBe(401);
  expect((await w.host.send(w.host.message('Hello before verification'))).status).toBe(401);
  const challenge = (await (await w.action('imessage.verify', { id: w.host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
  expect(challenge).toMatch(/^wic_[a-f0-9]{48}$/);
  expect((await w.host.send(w.host.message(challenge, { senderHandle: 'alias@example.invalid' }))).status).toBe(401);
  expect((await w.host.send(w.host.message(challenge, { chatGuid: 'iMessage;+;group' , isGroup: true }))).status).toBe(401);
  expect((await w.host.send(w.host.message('wic_' + 'a'.repeat(48)))).status).toBe(401);
  expect((await w.action('imessage.activate', { id: w.host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(400); // nothing observed yet
  expect((await w.host.send(w.host.message(challenge))).status).toBe(200);
  expect((await w.action('imessage.activate', { id: w.host.bridgeId, subject: 'alias@example.invalid', chat: CHAT })).status).toBe(400);
  expect((await w.action('imessage.activate', { id: w.host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
  expect(proof.turns).toHaveLength(0);
  expect(w.fx.bridges.get(w.host.bridgeId)?.state).toBe('active');
});

it('a signed direct message runs one genuine owner turn and its frozen reply reaches the host exactly once', async () => {
  const w = await world();
  await w.pairAndActivate();
  const event = w.host.message('What should I focus on today?');
  const body = JSON.stringify(event);
  const ack = await w.host.send(event);
  expect(ack.status).toBe(200);
  expect(await ack.json()).toEqual({ admitted: true, eventId: event.eventId, digest: await sha256Hex(body) });
  await w.pump();
  expect(proof.turns).toHaveLength(1);
  const { delivery } = await w.host.pull();
  expect(delivery).not.toBeNull();
  const command = JSON.parse(delivery!.body);
  expect(command).toMatchObject({ operation: 'send', text: proof.reply, allowSMSFallback: false, service: 'iMessage', attachments: [],
    target: { bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT }, binding: { subject: SUBJECT, chatGuid: CHAT, conversationKind: 'direct' } });
  const result = await w.host.execute(delivery!);
  expect(result.state).toBe('local_recorded');
  expect((await w.host.postResult(delivery!, result)).status).toBe(200);
  expect((await w.host.postResult(delivery!, result)).status).toBe(200); // identical terminal repeat
  await w.pump(2);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    const rows = new IMessageFinalOutbox(state.storage).records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'settled', text: '', result: { state: 'local_recorded' } }); // settled: identity and result kept, reply text pruned
    expect(new IMessageOwnerInbox(state.storage).records()[0]).toMatchObject({ state: 'completed', closedReason: 'final_committed', text: '' });
  });
  expect(w.host.nativeSends).toHaveLength(1);
  // Lost ACK: identical body, fresh nonce/timestamp -> same receipt, no second turn or reply.
  const retried = await w.host.send(event);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ admitted: true, eventId: event.eventId, digest: await sha256Hex(body) });
  // Changed bytes at the same identity conflict.
  expect((await w.host.send({ ...event, text: 'changed' })).status).toBe(409);
  await w.pump(2);
  expect(proof.turns).toHaveLength(1);
  expect((await w.host.pull()).delivery).toBeNull();
  expect(forbiddenEgress).toEqual([]);
});

it('an approval proposed on an iMessage turn is shown only in the app; the iMessage reply stays plain text', async () => {
  const w = await world();
  await w.pairAndActivate();
  await runInDurableObject(w.ownerStub, async (_i, state) => { await state.storage.put('origin', 'https://imessage.fixture.invalid'); await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]); });
  proof.outputs.push([{ type: 'function_call', call_id: 'move-3pm', name: 'propose_calendar_change', arguments: JSON.stringify({ action: 'move', event_id: 'ev-3pm', title: 'Design review', start: '2030-01-02T16:00:00Z', end: '2030-01-02T17:00:00Z', reason: 'Owner asked to move it to 4' }) }], []);
  expect((await w.host.send(w.host.message('Move my 3pm to 4'))).status).toBe(200);
  await w.pump();
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    const shown = state.storage.sql.exec<{ surface: string }>('SELECT surface FROM approval_presentations').toArray();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.map(row => row.surface)).toEqual(shown.map(() => 'app'));
  });
  const { delivery } = await w.host.pull();
  const command = JSON.parse(delivery!.body);
  expect(command).toMatchObject({ operation: 'send', attachments: [] });
  expect(command.text.startsWith(proof.reply)).toBe(true);
  expect(command.text).not.toMatch(/approve|Design review|waldo:\/\//i); // no card text, buttons or app link went to iMessage
  expect(forbiddenEgress).toEqual([]);
});

const outbox = async (stub: DurableObjectStub) => runInDurableObject(stub, async (_i, state) => new IMessageFinalOutbox(state.storage).records());
const inbox = async (stub: DurableObjectStub) => runInDurableObject(stub, async (_i, state) => new IMessageOwnerInbox(state.storage).records());
const replyFor = async (w: Awaited<ReturnType<typeof world>>, text: string) => {
  expect((await w.host.send(w.host.message(text))).status).toBe(200);
  await w.pump();
};
// An owner whose only surface is iMessage arms their own scheduled work (day cards, memory, follow-up ticks) on their first
// turn, and it runs on the clock. A test that moves the faked clock forward holds that work first, so a card whose time the
// jump crosses doesn't run inside a test about something else. Reminders the test set stay armed, and so does any job it names.
const moveClock = async (w: Awaited<ReturnType<typeof world>>, at: number, alsoKeep: readonly string[] = []) => {
  const kept = ['reminder', ...alsoKeep];
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    if (state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule'").toArray().length) {
      state.storage.sql.exec(`DELETE FROM schedule WHERE kind NOT IN (${kept.map(() => '?').join(', ')})`, ...kept);
    }
  });
  vi.setSystemTime(at);
};

it('lost pull and result ACKs, bridge/owner eviction and terminal repeats never produce a second native send', async () => {
  const w = await world();
  await w.pairAndActivate();
  await replyFor(w, 'Remind me what I asked.');
  const first = (await w.host.pull()).delivery!;
  // Lost pull response: the same signed bytes, deliveryId and commitment come back as attempt 2.
  const again = (await w.host.pull()).delivery!;
  expect(again).toMatchObject({ deliveryId: first.deliveryId, attempt: first.attempt + 1, body: first.body, headers: first.headers, commitment: first.commitment });
  await evictDurableObject(w.bridgeStub());
  await evictDurableObject(w.ownerStub);
  const third = (await w.host.pull()).delivery!;
  expect(third).toMatchObject({ deliveryId: first.deliveryId, body: first.body, commitment: first.commitment });
  const r1 = await w.host.execute(first), r2 = await w.host.execute(third);
  expect(r2).toEqual(r1); // host journal deduplicates; no second native effect
  expect(w.host.nativeSends).toHaveLength(1);
  // Lost result ACK: the identical terminal result is accepted again; a different one is a retained conflict.
  expect((await w.host.postResult(first, r1)).status).toBe(200);
  expect((await w.host.postResult(first, r1)).status).toBe(200);
  expect((await w.host.postResult(first, { version: 1, commandId: r1.commandId, target: r1.target, state: 'rejected', disposition: 'not_started', reason: 'late_change' })).status).toBe(409);
  await w.pump(2);
  expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { state: 'local_recorded' } });
  expect((await w.host.pull()).delivery).toBeNull();
  expect(proof.turns).toHaveLength(1);
});

it('deadlines and races keep proved not_started distinct from uncertain, and quarantine is permanent', async () => {
  const w = await world();
  await w.pairAndActivate();
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  try {
    // Never pulled within the delivery deadline -> withdrawn as proved not_started.
    await replyFor(w, 'First question');
    await moveClock(w, t0 + 21_000);
    expect((await w.host.heartbeat()).status).toBe(200); expect((await w.host.capabilities()).status).toBe(200);
    await w.pump(3);
    expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'host_not_pulled' } });
    expect((await w.host.pull()).delivery).toBeNull();
    // Pulled but no terminal result within the mutation deadline -> unknown, lane quarantined.
    await replyFor(w, 'Second question');
    const d = (await w.host.pull()).delivery!;
    const r = await w.host.execute(d);
    expect((await w.host.postResult(d, r, '0'.repeat(64))).status).toBe(409); // wrong digest never accepted
    expect((await w.host.postResult(d, { ...r, target: { ...r.target, chatGuid: 'iMessage;-;other@example.invalid' } })).status).toBe(409); // wrong target
    await moveClock(w, t0 + 21_000 + 31_000);
    expect((await w.host.heartbeat()).status).toBe(200); expect((await w.host.capabilities()).status).toBe(200);
    await w.pump(3);
    const rows = await outbox(w.ownerStub);
    expect(rows[1]).toMatchObject({ state: 'settled', result: { state: 'unknown', disposition: 'still_in_flight', reason: 'mutation_deadline' } });
    // A late valid result cannot clear quarantine or rewrite the authoritative outcome.
    expect((await w.host.postResult(d, r)).status).toBe(409);
    await evictDurableObject(w.bridgeStub());
    await replyFor(w, 'Third question');
    expect((await outbox(w.ownerStub))[2]).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'mutation_lane_poisoned' } });
    const status = await w.bridgeStub().status();
    expect(status).toMatchObject({ quarantine: 'mutation_deadline', online: true });
    expect(w.host.nativeSends).toHaveLength(1);
    // Expired commitment: a host that checks it immediately before mutation refuses as not_started.
    expect((await w.host.execute({ ...d, deliveryId: d.deliveryId }, { now: d.commitment.expiresAtMs + 1 })).state).toBe('local_recorded'); // journaled: same result, no resend
    expect(w.host.nativeSends).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it('stale capabilities hold a frozen reply and then prove it not_started; nothing is resent', async () => {
  const w = await world();
  await w.pairAndActivate();
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  try {
    await moveClock(w, t0 + 91_000); // heartbeat and capability reports are now stale
    expect((await w.host.send(w.host.message('Are you there?'))).status).toBe(200);
    await w.pump(3);
    expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'frozen' });
    expect((await w.host.pull()).delivery).toBeNull();
    await moveClock(w, t0 + 91_000 + 600_001);
    await w.pump(2);
    expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'bridge_unavailable' } });
    expect((await w.host.heartbeat()).status).toBe(200); expect((await w.host.capabilities()).status).toBe(200);
    expect((await w.host.pull()).delivery).toBeNull();
    expect(proof.turns).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

const DID_NOT_FINISH = 'This run did not finish. In-flight changes may still finish. Please check before retrying changes.';
// Every model call fails, so a retry inside the responder cannot rescue the turn.
const modelDown = () => { const fail = async () => { proof.hold = fail; throw new Error('provider exploded: upstream-detail-9f2'); }; proof.hold = fail; };
const failureRows = async (w: Awaited<ReturnType<typeof world>>) => (await outbox(w.ownerStub)).filter(row => row.replyRef.startsWith('failure:'));
const expectNotice = (delivery: Delivery) => {
  const text = JSON.parse(delivery.body).text as string;
  expect(text.startsWith(`${DID_NOT_FINISH}\n\nRequest received: `)).toBe(true);
  expect(text).not.toContain('upstream-detail-9f2');
  expect(text).not.toContain('Plan my afternoon');
};

it('an iMessage turn the model fails tells the owner once, with a fixed notice and no error text; a replay sends nothing more', async () => {
  const w = await world();
  await w.pairAndActivate();
  modelDown();
  const event = w.host.message('Plan my afternoon');
  expect((await w.host.send(event)).status).toBe(200);
  await w.pump();
  expectNotice(await sendNext(w));
  await w.pump(2);
  expect((await inbox(w.ownerStub)).map(r => [r.state, r.effectsUnconfirmed, r.text])).toEqual([['interrupted', true, '']]);
  expect((await failureRows(w)).map(r => [r.state, r.result?.state])).toEqual([['settled', 'local_recorded']]);
  // The bridge hands the same event again and the owner drains again: no second turn, no second notice.
  expect((await w.host.send(event)).status).toBe(200);
  await w.pump(3);
  expect((await w.host.pull()).delivery).toBeNull();
  expect(w.host.nativeSends).toHaveLength(1);
  // The next turn that succeeds gets its reply and no notice.
  proof.hold = null;
  await replyFor(w, 'What time is it?');
  await sendNext(w);
  expect(sentTexts(w).slice(1)).toEqual(['Scripted owner reply.']);
  expect(await failureRows(w)).toHaveLength(1);
  expect(forbiddenEgress).toEqual([]);
}, 30_000);

it('an iMessage turn whose model writes nothing tells the owner once', async () => {
  const w = await world();
  await w.pairAndActivate();
  const reply = proof.reply;
  proof.reply = '   ';
  try {
    await replyFor(w, 'Plan my afternoon');
    expectNotice(await sendNext(w));
  } finally { proof.reply = reply; }
  await w.pump(2);
  expect((await inbox(w.ownerStub)).map(r => r.state)).toEqual(['interrupted']);
  expect((await outbox(w.ownerStub)).map(r => r.replyRef.split(':')[0])).toEqual(['failure']);
  expect(w.host.nativeSends).toHaveLength(1);
}, 30_000);

// The claimed turn's deadline is `offsetMs` from its claim instead of the full window.
const shortDeadline = (offsetMs: number) => {
  const claim = IMessageOwnerInbox.prototype.claim;
  vi.spyOn(IMessageOwnerInbox.prototype, 'claim').mockImplementation(function (this: IMessageOwnerInbox, id: string, current: boolean) {
    return claim.call(this, id, current, Date.now() + offsetMs);
  });
};

it('an iMessage turn that runs out of time while the model works answers with its own reply and no notice on top', async () => {
  const w = await world();
  await w.pairAndActivate();
  shortDeadline(300);
  proof.hold = () => new Promise(resolve => setTimeout(resolve, 1_000));
  await replyFor(w, 'Plan my afternoon');
  expect(JSON.parse((await sendNext(w)).body).text).toMatch(/^I ran out of time before finishing this\./);
  await w.pump(2);
  expect((await inbox(w.ownerStub)).map(r => r.state)).toEqual(['completed']);
  expect((await outbox(w.ownerStub)).map(r => r.replyRef.split(':')[0])).toEqual(['reply']);
  expect(w.host.nativeSends).toHaveLength(1);
}, 30_000);

it('an iMessage turn whose deadline passes before it can run tells the owner once', async () => {
  const w = await world();
  await w.pairAndActivate();
  shortDeadline(-1);
  await replyFor(w, 'Plan my afternoon');
  expectNotice(await sendNext(w));
  await w.pump(2);
  expect((await inbox(w.ownerStub)).map(r => [r.state, r.effectsUnconfirmed])).toEqual([['interrupted', true]]);
  expect((await outbox(w.ownerStub)).map(r => [r.replyRef.split(':')[0], r.state])).toEqual([['failure', 'settled']]);
  expect(w.host.nativeSends).toHaveLength(1);
  expect(proof.turns).toEqual([]);
}, 30_000);

it('an iMessage turn whose owner object was evicted mid-turn tells the owner once, when the next drain recovers it', async () => {
  const w = await world();
  await w.pairAndActivate();
  modelDown();
  // The instance dies before it can close the row: the row stays running under an attempt nobody holds any more.
  const settle = vi.spyOn(IMessageOwnerInbox.prototype, 'settle').mockImplementation(() => { throw new Error('instance gone'); });
  expect((await w.host.send(w.host.message('Plan my afternoon'))).status).toBe(200);
  await runDurableObjectAlarm(w.bridgeStub()); await w.settle();
  await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1), { timeout: 10_000, interval: 50 });
  expect((await inbox(w.ownerStub)).map(r => r.state)).toEqual(['running']);
  expect(await failureRows(w)).toEqual([]);
  settle.mockRestore();
  const calls = proof.turns.length;
  await evictDurableObject(w.ownerStub);
  await w.pump(2);
  expect((await inbox(w.ownerStub)).map(r => [r.state, r.effectsUnconfirmed])).toEqual([['interrupted', true]]);
  expectNotice(await sendNext(w));
  await w.pump(3);
  expect(w.host.nativeSends).toHaveLength(1);
  expect(proof.turns).toHaveLength(calls); // recovery never reruns the turn
}, 30_000);

it('a failure notice that cannot be queued still settles the turn, loops nowhere, and the next message runs', async () => {
  const w = await world();
  await w.pairAndActivate();
  modelDown();
  const freeze = vi.spyOn(IMessageFinalOutbox.prototype, 'freezeFailure').mockImplementation(() => { throw new Error('imessage_outbox_capacity'); });
  await replyFor(w, 'Plan my afternoon');
  const calls = proof.turns.length;
  await w.pump(3);
  expect(freeze).toHaveBeenCalledTimes(1);
  expect((await inbox(w.ownerStub)).map(r => r.state)).toEqual(['interrupted']);
  expect(await outbox(w.ownerStub)).toEqual([]);
  expect(proof.turns).toHaveLength(calls);
  proof.hold = null; freeze.mockRestore();
  await replyFor(w, 'What time is it?');
  await sendNext(w);
  expect(sentTexts(w)).toEqual(['Scripted owner reply.']);
}, 30_000);

it('revocation during the model await blocks publication and pull; revoked hosts are rejected; evidence is retained', async () => {
  const w = await world();
  await w.pairAndActivate();
  proof.hold = async () => { expect((await w.action('imessage.revoke', { id: w.host.bridgeId })).status).toBe(303); };
  expect((await w.host.send(w.host.message('Start something long'))).status).toBe(200);
  await w.pump();
  expect(proof.turns).toHaveLength(1);
  expect(await outbox(w.ownerStub)).toEqual([]); // no frozen reply after revoke
  expect((await inbox(w.ownerStub))[0]).toMatchObject({ state: 'revoked', closedReason: 'authority_revoked', effectsUnconfirmed: true });
  for (const r of [await w.host.heartbeat(), await w.host.send(w.host.message('after revoke')), await w.host.capabilities()]) expect(r.status).toBe(401);
  expect((await w.host.pull()).status).toBe(401);
  expect(await w.bridgeStub().status()).toMatchObject({ revoked: true });
  expect(w.host.nativeSends).toHaveLength(0);
  expect(w.fx.presences.size).toBe(1);
  expect([...w.fx.presences.values()][0]!.active).toBe(false);
});

it('a revoke from the new console during the model await does not wait for the turn: it stops that turn and the next queued text never runs', async () => {
  const w = await world();
  await w.pairAndActivate();
  // The hold runs inside the owner DO, where runInDurableObject is unavailable, so admissions are counted at the inbox.
  const admitted: string[] = [], admit = IMessageOwnerInbox.prototype.admit;
  vi.spyOn(IMessageOwnerInbox.prototype, 'admit').mockImplementation(async function (this: IMessageOwnerInbox, ...args: Parameters<typeof admit>) {
    const result = await admit.apply(this, args); admitted.push(result.kind); return result;
  });
  let revoked: unknown;
  proof.hold = async () => {
    await vi.waitFor(() => expect(admitted).toEqual(['admitted', 'admitted']), { timeout: 5_000 });
    revoked = await w.dashboard('imessage.revoke', { id: w.host.bridgeId });
  };
  expect((await w.host.send(w.host.message('Start something long'))).status).toBe(200);
  expect((await w.host.send(w.host.message('And then this'))).status).toBe(200);
  await w.pump();
  expect(revoked).toEqual({ status: 200, body: { receipt: { state: 'recorded', message: 'Mac host revoked. It can no longer send or receive for your Waldo.' }, duplicate: false } });
  expect(proof.turns).toHaveLength(1);
  const records = await inbox(w.ownerStub);
  expect(records).toHaveLength(2);
  for (const record of records) expect(record).toMatchObject({ state: 'revoked', closedReason: 'authority_revoked' });
  expect(records.filter((record) => record.effectsUnconfirmed)).toHaveLength(1);
  expect(await outbox(w.ownerStub)).toEqual([]);
  for (const r of [await w.host.heartbeat(), await w.host.send(w.host.message('after revoke')), await w.host.capabilities(), await w.host.pull()]) expect(r.status).toBe(401);
  expect(w.host.nativeSends).toHaveLength(0);
  expect(forbiddenEgress).toEqual([]);
}, 15_000);

it('revocation after a reply is queued withdraws it as not_started; a delivered reply stays uncertain evidence', async () => {
  const w = await world();
  await w.pairAndActivate();
  await replyFor(w, 'Queued then revoked');
  const queued = (await outbox(w.ownerStub))[0]!;
  expect(queued.state).toBe('queued');
  expect((await w.action('imessage.revoke', { id: w.host.bridgeId })).status).toBe(303);
  await w.pump(2);
  expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'binding_revoked' } });
  expect((await w.host.pull()).status).toBe(401);
  expect(w.host.nativeSends).toHaveLength(0);
});

it('groups, SMS/RCS, echoes, media, reactions, receipts and unknown senders are retained evidence, never owner turns', async () => {
  const w = await world();
  await w.pairAndActivate();
  const base = w.host.message('x');
  const events = [
    w.host.message('group text', { isGroup: true, chatGuid: 'iMessage;+;fixture-group', senderHandle: 'other@example.invalid' }),
    w.host.message('sms text', { service: 'SMS', chatGuid: 'SMS;-;+15550000001', senderHandle: '+15550000001' }),
    w.host.message('rcs text', { service: 'RCS', chatGuid: 'RCS;-;+15550000002', senderHandle: '+15550000002' }),
    w.host.message('my own echo', { isFromMe: true }),
    w.host.message('photo caption', { attachments: [{ reference: 'att-1', sourceMessageGuid: 'placeholder', filename: 'photo.png', mimeType: 'image/png', byteLength: 4, sha256: '0'.repeat(64), kind: 'image', nativeVoice: false }] }),
    w.host.message('stranger text', { senderHandle: 'stranger@example.invalid' }),
    { ...base, eventId: 'sim-reaction', kind: 'reaction', action: 'add', actorHandle: SUBJECT, reaction: { kind: 'standard', type: 'love' }, text: undefined, attachments: undefined,
      target: { bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT, messageGuid: 'sim-guid-1', partIndex: 0 } },
    { ...base, eventId: 'sim-receipt', kind: 'receipt', state: 'delivered', text: undefined, attachments: undefined,
      target: { bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT, messageGuid: 'sim-sent-unknown', partIndex: 0 } },
  ].map((e: any) => { if (e.attachments) e.attachments = e.attachments.map((a: any) => ({ ...a, sourceMessageGuid: e.messageGuid })); for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]; return e; });
  for (const e of events) expect((await w.host.send(e)).status, e.eventId).toBe(200);
  await w.pump();
  expect(proof.turns).toHaveLength(0);
  expect(await inbox(w.ownerStub)).toEqual([]);
  const counts = (await w.bridgeStub().status()).events;
  expect(counts).toMatchObject({ pending: 0, handed: 0 });
  expect((counts.acknowledged ?? 0) + (counts.held ?? 0)).toBe(events.length + 1); // + the setup challenge
  expect(w.fx.calls.filter(c => c === 'route_presence')).toHaveLength(0); // unknown senders never reach directory lookup
});

it('authentication: wrong key, foreign account, replay, stale and future signatures and malformed headers are refused before state', async () => {
  const a = await world(`imsg-owner-a-${crypto.randomUUID()}`, '10000000-0000-4000-8000-0000000000aa');
  await a.pairAndActivate();
  const body = JSON.stringify(a.host.message('hello'));
  expect((await a.host.signed('/events', body, { key: 'b'.repeat(64) })).status).toBe(401);
  expect((await a.host.signed('/events', body, { atMs: Date.now() + 60_000 })).status).toBe(401);
  expect((await a.host.signed('/events', body, { atMs: Date.now() - 61_000 })).status).toBe(401);
  expect((await a.host.signed('/heartbeat', JSON.stringify({ ...a.host.scope(), databaseGeneration: a.host.generation, status: 'online' }), { nonce: 'fixed-nonce' })).status).toBe(200);
  expect((await a.host.signed('/commands/pull', JSON.stringify(a.host.scope()), { nonce: 'fixed-nonce' })).status).toBe(401); // nonce replay
  // A foreign bridge id with this key: routes to a different DO whose canonical authority does not exist.
  expect((await a.host.signed('/commands/pull', JSON.stringify(a.host.scope()), { bridgeId: 'imb_' + '0'.repeat(32) })).status).toBe(401);
  const raw = (headers: Record<string, string>, path = '/events', method = 'POST', b: string | null = body) => a.call(new Request(`${HOST_ORIGIN}/channels/imessage/v1${path}`, { method, headers, ...(b === null ? {} : { body: b }) }));
  expect((await raw({ 'content-type': 'application/json', 'x-waldo-imessage-s2': '{"version":1}' })).status).toBe(401);
  expect((await raw({ 'content-type': 'application/json', 'x-waldo-imessage-s2': 'not json' })).status).toBe(401);
  expect((await raw({ 'content-type': 'text/plain' })).status).toBe(415);
  expect((await raw({ 'content-type': 'application/json' }, '/events', 'GET', null)).status).toBe(405);
  expect((await raw({ 'content-type': 'application/json' }, '/events?code=leak')).status).toBe(401);
  expect((await raw({ 'content-type': 'application/json' }, '/unknown')).status).toBe(404);
  expect((await raw({ 'content-type': 'application/json' }, '/events', 'POST', 'x'.repeat(128 * 1024 + 1))).status).toBe(413);
  expect(proof.turns).toHaveLength(0);
});

it('two owners on two bridges are isolated: keys, commands, replies and status never cross', async () => {
  const a = await world(`imsg-owner-a-${crypto.randomUUID()}`, '10000000-0000-4000-8000-0000000000a1');
  await a.pairAndActivate();
  // Second owner in the same directory, its own console session and simulated host.
  const bName = `imsg-owner-b-${crypto.randomUUID()}`;
  a.fx.owners.push({ do_name: bName, owner_id: '10000000-0000-4000-8000-0000000000b1', state: 'active', state_version: 1, admission_revision: 1 });
  const bStub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(bName));
  let bSession = '', bCsrf = '';
  await runInDurableObject(bStub, async (_i, state) => { state.storage.kv.put('do_name', bName); bSession = await consoleAccess(state.storage).grant(); bCsrf = (await consoleAccess(state.storage).session(bSession))!.csrf; });
  const bCookie = `waldo_console=${bSession}; waldo_owner=${bName}.session_fixture.${await routerSignature(SECRET, 0, `cookie.${bName}.session_fixture`)}`;
  const bAction = (name: string, fields: Record<string, string> = {}) => { const f = new FormData(); f.set('action', name); f.set('csrf', bCsrf); for (const [k, v] of Object.entries(fields)) f.set(k, v); return a.call(new Request(`${HOST_ORIGIN}/console/action`, { method: 'POST', body: f, headers: { cookie: bCookie, origin: HOST_ORIGIN }, redirect: 'manual' })); };
  const hostB = new SimulatedHost(a.call, HOST_ORIGIN);
  const code = (await (await bAction('imessage.pair')).text()).split('\n')[0]!;
  expect((await hostB.redeem(code)).status).toBe(200);
  // Owner B cannot verify, activate or revoke owner A's bridge.
  expect((await bAction('imessage.verify', { id: a.host.bridgeId, subject: 'b@example.invalid', chat: 'iMessage;-;b@example.invalid' })).status).toBe(400);
  expect((await bAction('imessage.revoke', { id: a.host.bridgeId })).status).toBe(400);
  // The same Apple sender already bound to owner A cannot be bound to owner B (conflict, not transfer).
  const challenge = (await (await bAction('imessage.verify', { id: hostB.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
  expect((await hostB.send(hostB.message(challenge))).status).toBe(200);
  expect((await bAction('imessage.activate', { id: hostB.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(400);
  // A reply for owner A is only ever pulled by A's credential.
  await replyFor(a, 'Only for owner A');
  expect((await hostB.signed('/commands/pull', JSON.stringify({ version: 1, bridgeId: a.host.bridgeId, accountId: hostB.accountId }), { bridgeId: a.host.bridgeId })).status).toBe(401);
  expect((await hostB.pull()).status).toBe(401); // B is still pending: no commands at all
  const d = (await a.host.pull()).delivery!;
  expect(JSON.parse(d.body).binding.ownerId).toBe('10000000-0000-4000-8000-0000000000a1');
  expect(await inbox(bStub)).toEqual([]);
  expect(await outbox(bStub)).toEqual([]);
});

it('a host that sees an expired commitment returns not_started; the lane stays usable', async () => {
  const w = await world();
  await w.pairAndActivate();
  await replyFor(w, 'Late pull');
  const d = (await w.host.pull()).delivery!;
  const r = await w.host.execute(d, { now: d.commitment.expiresAtMs + 1 });
  expect(r).toMatchObject({ state: 'rejected', disposition: 'not_started', reason: 'commitment_expired' });
  expect((await w.host.postResult(d, r)).status).toBe(200);
  await w.pump(2);
  expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { reason: 'commitment_expired' } });
  expect((await w.bridgeStub().status()).quarantine).toBeNull();
  await replyFor(w, 'Next one');
  expect((await w.host.pull()).delivery).not.toBeNull();
  expect(w.host.nativeSends).toHaveLength(0);
});

// ---- review rev3 follow-ups: pre-DO hardening, revoke at the cap, quarantine recovery ----------------------
const forged = (w: Awaited<ReturnType<typeof world>>, bridgeId: string, accountId: string, ip: string) => w.call(new Request(`${HOST_ORIGIN}/channels/imessage/v1/heartbeat`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip,
    'x-waldo-imessage-s2': JSON.stringify({ version: 1, bridgeId, accountId, atMs: Date.now(), nonce: crypto.randomUUID(), signature: '0'.repeat(64) }) },
  body: JSON.stringify({ version: 1, bridgeId, accountId, databaseGeneration: 'g', status: 'online' }) }));

it('non-minted ids never reach a bridge; an unknown tuple leaves no storage; one address is limited at the edge', async () => {
  const w = await world();
  await w.pairAndActivate();
  const lookups = () => w.fx.calls.filter((c) => c === 'imessage_bridge_authority').length, before = lookups();
  for (const [b, a] of [['not-minted', w.host.accountId], [w.host.bridgeId, 'ima_short'], [`IMB_${'a'.repeat(32)}`, w.host.accountId], [w.host.bridgeId, `${w.host.accountId}x`]])
    expect((await forged(w, b!, a!, '192.0.2.10')).status).toBe(401);
  expect(lookups()).toBe(before); // refused before any directory lookup or Durable Object
  const ghost = { bridgeId: `imb_${'a'.repeat(32)}`, accountId: `ima_${'b'.repeat(32)}` };
  expect((await forged(w, ghost.bridgeId, ghost.accountId, '192.0.2.11')).status).toBe(401);
  await runInDurableObject(env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', ghost.bridgeId, ghost.accountId))), async (_i, state) => {
    const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map((r) => r.name).filter((n) => !n.startsWith('_cf'));
    expect(tables).toEqual([]); // the unsigned request created no bridge tables
  });
  const ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
  // The local limiter counts an address in fixed wall-clock minutes, 120 a minute. A burst that crosses a minute is split
  // between two windows, and twice the limit plus one always fills one of them; a burst inside one minute is cut off by 130.
  const minute = (ms: number) => Math.floor(ms / 60_000), start = Date.now();
  const statuses: number[] = [];
  while (statuses.length < 241 && statuses.at(-1) !== 429) statuses.push((await forged(w, ghost.bridgeId, ghost.accountId, ip)).status);
  expect(statuses.at(-1)).toBe(429);
  if (minute(start - 1_000) === minute(Date.now() + 1_000)) expect(statuses.length).toBeLessThanOrEqual(130);
  expect(statuses.filter((s) => s !== 401 && s !== 429)).toEqual([]);
  expect((await w.host.heartbeat()).status).toBe(200); // another address is unaffected
});

it('a revoke on a full bridge store is still recorded and the host gets 401, not 503', async () => {
  const w = await world();
  await w.pairAndActivate();
  await runInDurableObject(w.bridgeStub(), async (_i, state) => {
    const now = Date.now(); // held evidence is never pruned early, so this store cannot recover by pruning
    for (let i = 0; i < PROPOSED_LOCAL_TEST_POLICY.maxRecords + 10; i++)
      state.storage.sql.exec("INSERT INTO events(generation,event_id,digest,body,kind,state,created_at) VALUES('fill',?,?,'','message','held',?)", `fill-${i}`, '0'.repeat(64), now);
  });
  expect((await w.host.heartbeat()).status).toBe(503); // backpressure while bound
  expect((await w.action('imessage.revoke', { id: w.host.bridgeId })).status).toBe(303);
  expect((await w.host.heartbeat()).status).toBe(401);
  expect((await w.host.pull()).status).toBe(401);
  await runInDurableObject(w.bridgeStub(), async (_i, state) => { expect(new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY).revokedRevision()).not.toBeNull(); });
});

it('quarantine recovery is revoke + re-pair: the new bridge has a clean lane and replies flow again', async () => {
  const w = await world();
  await w.pairAndActivate();
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 }); // one forward-only clock for the whole recovery
  try {
  await replyFor(w, 'Before the quarantine');
  expect((await w.host.pull()).delivery).not.toBeNull(); // pulled, never resulted
  await moveClock(w, t0 + PROPOSED_LOCAL_TEST_POLICY.mutationDeadlineMs + 2_000);
  expect((await w.host.heartbeat()).status).toBe(200);
  await w.pump(3);
  expect((await w.bridgeStub().status()).quarantine).toBe('mutation_deadline');
  await replyFor(w, 'Still quarantined');
  expect((await outbox(w.ownerStub)).at(-1)).toMatchObject({ state: 'settled', result: { reason: 'mutation_lane_poisoned' } });
  const old = { bridgeId: w.host.bridgeId, stub: w.bridgeStub() };
  expect((await w.action('imessage.revoke', { id: old.bridgeId })).status).toBe(303);
  // Fresh invitation -> new host identity -> new bridge Durable Object with an empty lane.
  const host = new SimulatedHost(w.call, HOST_ORIGIN);
  const code = (await (await w.action('imessage.pair')).text()).split('\n')[0]!;
  expect((await host.redeem(code)).status).toBe(200);
  expect(host.bridgeId).not.toBe(old.bridgeId);
  const challenge = (await (await w.action('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
  expect((await host.send(host.message(challenge))).status).toBe(200);
  expect((await w.action('imessage.activate', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
  expect((await host.heartbeat()).status).toBe(200); expect((await host.capabilities()).status).toBe(200);
  const stub = env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  expect((await stub.status()).quarantine).toBeNull();
  expect((await host.send(host.message('After the re-pair'))).status).toBe(200);
  for (let i = 0; i < 6; i++) { await runDurableObjectAlarm(stub); await w.settle(); await runDurableObjectAlarm(w.ownerStub); await w.settle(); }
  const { delivery } = await host.pull();
  expect(delivery).not.toBeNull();
  const result = await host.execute(delivery!);
  expect(result.state).toBe('local_recorded');
  expect((await host.postResult(delivery!, result)).status).toBe(200);
  for (let i = 0; i < 3; i++) { await runDurableObjectAlarm(stub); await w.settle(); await runDurableObjectAlarm(w.ownerStub); await w.settle(); }
  expect((await outbox(w.ownerStub)).at(-1)).toMatchObject({ state: 'settled', result: { state: 'local_recorded' } });
  expect((await old.stub.status()).quarantine).toBe('mutation_deadline'); // the old lane keeps its evidence
  expect(forbiddenEgress).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('an iMessage owner\'s own request queues the console link on the same bridge, ahead of the reply; the model never sees it', async () => {
  const w = await world();
  await w.pairAndActivate();
  await runInDurableObject(w.ownerStub, async (_i, state) => { await state.storage.put('origin', HOST_ORIGIN); });
  proof.outputs.push([{ type: 'function_call', call_id: 'console', name: 'send_console_link', arguments: '{}' }], []);
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  try {
  await replyFor(w, 'Send me my console link');
  // The link goes first and the reply waits behind it: the bridge holds one outstanding command at a time. The reply polls
  // the slot for a few seconds, then its handoff is retried once the link's delivery has settled.
  const first = (await w.host.pull()).delivery!;
  const link = JSON.parse(first.body);
  expect(link).toMatchObject({ operation: 'send', allowSMSFallback: false, attachments: [], target: { bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT }, binding: { subject: SUBJECT, chatGuid: CHAT } });
  expect(link.text.startsWith(`Console (link works once, for 10 minutes): ${HOST_ORIGIN}/console?t=c1.`)).toBe(true);
  expect((await w.host.postResult(first, await w.host.execute(first))).status).toBe(200);
  await moveClock(w, t0 + 6_000);
  await w.pump(3);
  const second = (await w.host.pull()).delivery!;
  const reply = JSON.parse(second.body);
  expect(reply).toMatchObject({ operation: 'send', text: proof.reply, target: link.target, binding: link.binding });
  expect(reply.commandId).not.toBe(link.commandId);
  // One server-originated record beside the reply: same bridge, owner, revision and binding, its own command id.
  const [inbound] = await inbox(w.ownerStub);
  const rows = await outbox(w.ownerStub);
  const consoleRow = rows.find(row => row.replyRef === `console:${inbound!.id}`)!, replyRow = rows.find(row => row.replyRef === `reply:${inbound!.id}`)!;
  expect(consoleRow).toMatchObject({ bridgeDoName: replyRow.bridgeDoName, ownerDoName: replyRow.ownerDoName, revision: replyRow.revision, bindingDigest: replyRow.bindingDigest, commandId: link.commandId, state: 'settled', text: '' });
  expect(replyRow.commandId).toBe(reply.commandId);
  const ticket = new URL(link.text.slice(link.text.indexOf('https://'))).searchParams.get('t')!;
  const seen = proof.turns.join('\n').replaceAll('\\"', '"');
  expect(seen).toContain('"sent":true,"surface":"imessage"');
  expect(seen).not.toContain(ticket);
  // The ticket is the issuing owner's, and it opens the console once.
  const redeem = async () => (await w.call(new Request(`${HOST_ORIGIN}/console`, { method: 'POST', redirect: 'manual', headers: { origin: HOST_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: ticket }) }))).status;
  expect(await redeem()).toBe(303);
  expect(await redeem()).toBe(403);
  expect(w.host.nativeSends).toHaveLength(1);
  expect(forbiddenEgress).toEqual([]);
  } finally { vi.useRealTimers(); }
}, 15_000);

it('an iMessage turn with no public origin on record mints nothing, says so, and still replies', async () => {
  const w = await world();
  await w.pairAndActivate();
  proof.outputs.push([{ type: 'function_call', call_id: 'console', name: 'send_console_link', arguments: '{}' }], []);
  await replyFor(w, 'Send me my console link');
  const only = (await w.host.pull()).delivery!;
  expect(JSON.parse(only.body).text).toBe(proof.reply);
  expect(proof.turns.join('\n').replaceAll('\\"', '"')).toContain('"sent":false,"reason":"unavailable"');
  await runInDurableObject(w.ownerStub, async (_i, state) => { expect(state.storage.kv.get('console:link')).toBeUndefined(); });
  expect((await outbox(w.ownerStub)).map(row => row.replyRef.split(':')[0])).toEqual(['reply']);
});

it('an iMessage forget whose topic matches nothing completes the turn, replies, and the next turn loads the message as the forget left it', async () => {
  const w = await world();
  await w.pairAndActivate();
  proof.outputs.push([{ type: 'function_call', call_id: 'forget', name: 'forget_memory', arguments: JSON.stringify({ topic: 'zebra stripes', scope_note: 'zebras' }) }], []);
  await replyFor(w, 'Forget zebra stripes');
  expect((await inbox(w.ownerStub))[0]).toMatchObject({ state: 'completed', closedReason: 'final_committed' });
  expect(proof.turns.join('\n')).toContain('No stored memory carries that topic or span');
  const first = (await w.host.pull()).delivery!;
  expect(JSON.parse(first.body).text.startsWith(proof.reply)).toBe(true);
  expect((await w.host.postResult(first, await w.host.execute(first))).status).toBe(200);
  await w.pump(2);
  await replyFor(w, 'What is on today?');
  expect((await inbox(w.ownerStub)).map(record => record.state)).toEqual(['completed', 'completed']);
  const next = proof.turns.at(-1)!;
  expect(next).toContain('Forget [forgotten]');
  expect(next).not.toContain('zebra stripes');
});

it('an iMessage owner turn carries the host fact about a Gmail watch that failed to start', async () => {
  const w = await world();
  await w.pairAndActivate();
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    await state.storage.put('google:accounts', [{ id: 'conn-1', email: 'mail-owner@example.invalid', scopes: ['gmail.readonly', 'gmail.send', 'gmail.compose'].map(scope => `https://www.googleapis.com/auth/${scope}`) }]);
    gmailPushBook(state.storage.kv).fail(Date.now());
  });
  await replyFor(w, 'Did my new email come in?');
  expect(proof.systems).toHaveLength(1);
  // The fact is current for this message, so it rides the owner's message as turn context, never the system prompt.
  expect(proof.systems[0]).not.toContain('New emails are not pushed to Waldo');
  expect(proof.turns[0]!.split('New emails are not pushed to Waldo').length - 1).toBe(1);
  for (const sent of [proof.systems[0]!, proof.turns[0]!]) expect(sent).not.toContain('mail-owner@example.invalid');
  expect(forbiddenEgress).toEqual([]);
});

// Proactive work for an owner admitted on the app who chose the app and iMessage: the app takes it, and its delivery is what
// settles the job, so a bridge that is asleep or refuses loses nothing; iMessage gets one copy of that app message, frozen
// into the iMessage outbox under the app message's id and handed to the bridge, which re-checks the sender before it sends.
// The owner writes once and Waldo's reply is sent and reported, so the bridge holds nothing else.
const answered = async (w: Awaited<ReturnType<typeof world>>, text: string) => {
  await replyFor(w, text);
  const { delivery } = await w.host.pull();
  await w.host.postResult(delivery!, await w.host.execute(delivery!));
  await w.pump(2);
};
const dueReminder = async (w: Awaited<ReturnType<typeof world>>, surface: string) => {
  const directory = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/rpc/owner_runtime_authority')) return Response.json({ owner_id: '10000000-0000-4000-8000-000000000001', auth_user_id: '10000000-0000-4000-8000-000000000001', do_name: w.ownerName, state_version: 1, admission_revision: '5' });
    if (url.endsWith('/rpc/health_log_recent')) return Response.json([]);
    return directory(input, init);
  });
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    state.storage.kv.put('app_subject', String(appSubjectFor(w.ownerName)));
    state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true);
    state.storage.kv.put(PROACTIVE_SURFACE_KEY, surface);
    state.storage.sql.exec('DELETE FROM schedule');
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    await reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date(Date.now() - 3_600_000) }, () => 'rem-1')
      .set({ note: 'call Sam', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
    state.storage.kv.put('owner_alarm_last_v1', 1);
  });
};
const REMINDER = 'Time to call Sam, as you asked.';
const copies = (state: DurableObjectState) => new IMessageFinalOutbox(state.storage).records().filter((row) => row.replyRef.startsWith('proactive:'));
const reminderRuns = (state: DurableObjectState) => state.storage.sql.exec<{ status: string }>("SELECT status FROM background_runs WHERE kind = 'reminder'").toArray().map((row) => row.status);
const reminderRunSummaries = (state: DurableObjectState) => state.storage.sql.exec<{ status: string; summary: string | null }>("SELECT status, summary FROM background_runs WHERE kind = 'reminder'").toArray();
// What the console's day view reports as iMessage's link state, read the way it does.
const imessageLinked = (w: Awaited<ReturnType<typeof world>>) => runInDurableObject(w.ownerStub, async (instance) =>
  (instance as unknown as { imessageLinked(auth: unknown): Promise<boolean | null> }).imessageLinked(consoleAuth(env)!));
const fireDue = async (w: Awaited<ReturnType<typeof world>>) => {
  proof.reply = REMINDER;
  try { await runDurableObjectAlarm(w.ownerStub); await w.settle(); } finally { proof.reply = 'Scripted owner reply.'; }
};

it('with the app and iMessage chosen, the app takes a due reminder and settles it, and iMessage gets one copy of that app message', async () => {
  const w = await world();
  await w.pairAndActivate();
  await answered(w, 'Morning');
  await dueReminder(w, 'app_imessage');
  await fireDue(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    // Settled by the app's delivery before the bridge has said anything about the copy.
    expect(reminderRuns(state)).toEqual(['completed']);
    const [copy, ...rest] = copies(state);
    expect(rest).toEqual([]);
    expect(copy!.replyRef).toMatch(/^proactive:imessage-copy:scheduled-/);
  });
  expect(await imessageLinked(w)).toBe(true);
  await w.pump();
  const { delivery } = await w.host.pull();
  expect(delivery, 'the copy reached the bridge').not.toBeNull();
  expect(JSON.parse(delivery!.body)).toMatchObject({ operation: 'send', text: REMINDER, binding: { subject: SUBJECT, chatGuid: CHAT } });
});

it('an iMessage copy keeps the alarm for the next reminder, and the copy goes out on the next pass', async () => {
  const w = await world();
  await w.pairAndActivate();
  await answered(w, 'Morning');
  await dueReminder(w, 'app_imessage');
  const laterDue = await runInDurableObject(w.ownerStub, async (_i, state) => {
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    await reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date() }, () => 'rem-2')
      .set({ note: 'book the dentist', at: new Date(Date.now() + 119 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
    return state.storage.sql.exec<{ due: number }>("SELECT MAX(due_at) AS due FROM schedule WHERE kind = 'reminder'").one().due;
  });
  await fireDue(w);
  await w.pump();
  const { delivery } = await w.host.pull();
  expect(delivery, 'the copy reached the bridge').not.toBeNull();
  expect(JSON.parse(delivery!.body)).toMatchObject({ operation: 'send', text: REMINDER });
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    expect(reminderRuns(state)).toEqual(['completed']);
    const alarm = await state.storage.getAlarm();
    expect(alarm, 'the next reminder still has its wake').not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(laterDue);
  });
});

it('once the owner unlinks iMessage, proactive work goes to the app alone and iMessage reads as not linked', async () => {
  const w = await world();
  await w.pairAndActivate();
  await answered(w, 'Morning');
  expect((await w.action('imessage.unlink')).status).toBe(303);
  await dueReminder(w, 'app_imessage');
  await fireDue(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    expect(reminderRuns(state)).toEqual(['completed']);
    expect(copies(state)).toEqual([]);
  });
  expect(await imessageLinked(w)).toBe(false);
});

it('copying one app message to iMessage again freezes the same record, whatever the retry', async () => {
  const w = await world();
  await w.pairAndActivate();
  await answered(w, 'Morning');
  await runInDurableObject(w.ownerStub, async (instance, state) => {
    const copy = (instance as unknown as { queueIMessageCopy(id: string, text: string): Promise<void> }).queueIMessageCopy.bind(instance);
    await copy('imessage-copy:scheduled-1', REMINDER);
    await copy('imessage-copy:scheduled-1', REMINDER);
    expect(copies(state).map((row) => row.replyRef)).toEqual(['proactive:imessage-copy:scheduled-1']);
  });
});

// A loop's check-back or a mail follow-up that reached the app through the outbox gets its iMessage copy as it settles, under
// the record's own id, as its WhatsApp copy does; meeting prep stays in the app.
it('a follow-up that reached the app is copied to iMessage once as it settles; meeting prep is not', async () => {
  const w = await world();
  await w.pairAndActivate();
  await answered(w, 'Morning');
  await runInDurableObject(w.ownerStub, async (instance, state) => {
    const owner = instance as unknown as { setup(channel: 'app'): { owner: number }; copiedFollowups(settle: (record: unknown) => Promise<void>, copies: readonly string[]): (record: unknown) => Promise<void> };
    const settled: string[] = [];
    const settle = owner.copiedFollowups(async (record) => { settled.push((record as { id: string }).id); }, ['imessage']);
    const record = (id: string, marker: object) => ({ id, trace: id, status: 'delivered', payload: { chat_id: owner.setup('app').owner, text: 'Did the visa form go in?' }, createdAt: Date.now(), deliveredAt: Date.now(), ...marker });
    await settle(record('final-1', { heartbeat: { loopId: 'l1' } }));
    await settle(record('final-1', { heartbeat: { loopId: 'l1' } }));
    await settle(record('final-2', { calendarPrep: { eventId: 'e1' } }));
    expect(settled).toEqual(['final-1', 'final-1', 'final-2']);
    expect(copies(state).map((row) => [row.replyRef, row.text])).toEqual([['proactive:imessage-copy:final-1', 'Did the visa form go in?']]);
  });
});

// iMessage work re-arms the owner's one alarm, and each re-arm keeps the schedule's next entry: a reminder two hours out keeps
// its wake, or an owner job due sooner keeps its own. These read the alarm once the owner's serial queue has run everything
// queued, the reply's drain included.
const ownerIdle = (stub: DurableObjectStub) => runInDurableObject(stub, async instance => {
  const owner = instance as unknown as { queue: Promise<unknown> };
  for (let tail = owner.queue; ; tail = owner.queue) { await tail; if (tail === owner.queue) return; }
});
const ownerAlarm = (stub: DurableObjectStub) => runInDurableObject(stub, async (_i, state) => ({ alarm: await state.storage.getAlarm(), next: scheduleNext(state), reminder: reminderDue(state) }));
const clearOwnerAlarm = (stub: DurableObjectStub) => runInDurableObject(stub, async (_i, state) => { await state.storage.deleteAlarm(); });
// A turn from the host's message: the bridge hands it over in its pass, and the owner runs it outside any pass of its own.
const handedTurn = async (w: Awaited<ReturnType<typeof world>>, text: string) => {
  const before = (await inbox(w.ownerStub)).length;
  expect((await w.host.send(w.host.message(text))).status).toBe(200);
  await runDurableObjectAlarm(w.bridgeStub());
  await w.settle();
  await vi.waitFor(async () => expect((await inbox(w.ownerStub)).map(record => record.state)).toEqual(Array(before + 1).fill('completed')), { timeout: 8_000, interval: 50 });
  await ownerIdle(w.ownerStub);
};
// One full turn whose reply the host delivered, so the owner has a binding on record and no reply in flight.
const afterOneReply = async (w: Awaited<ReturnType<typeof world>>) => {
  await w.pairAndActivate();
  await replyFor(w, 'Morning');
  const { delivery } = await w.host.pull();
  await w.host.postResult(delivery!, await w.host.execute(delivery!));
  await w.pump(2);
};

it('an iMessage turn keeps the alarm for the owner\'s reminder two hours out', async () => {
  const w = await world();
  await afterOneReply(w);
  const due = await runInDurableObject(w.ownerStub, (_i, state) => remindInTwoHours(state));
  try {
    await handedTurn(w, 'Second message');
    expect(proof.turns).toHaveLength(2);
    const { alarm, next, reminder } = await ownerAlarm(w.ownerStub);
    expect(reminder).toBe(due);
    expect(alarm).toBe(next);
  } finally { await clearOwnerAlarm(w.ownerStub); }
}, 15_000);

it('an iMessage turn that sets a reminder two hours out leaves the alarm at that reminder', async () => {
  const w = await world();
  await afterOneReply(w);
  // The owner also has the app.
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true); state.storage.kv.put('app_subject', String(appSubjectFor(w.ownerName)));
  });
  proof.outputs.push([{ type: 'function_call', call_id: 'remind', name: 'set_reminder',
    arguments: JSON.stringify({ note: 'water plants', at: new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 16), repeat: 'none' }) }], []);
  try {
    await handedTurn(w, 'Remind me to water the plants in two hours');
    const { alarm, next, reminder } = await ownerAlarm(w.ownerStub);
    expect(reminder).toBeGreaterThan(Date.now() + 3_600_000);
    expect(alarm).toBe(next);
  } finally { await clearOwnerAlarm(w.ownerStub); }
}, 15_000);

// A message's drain can find its turn already run, by an alarm pass that held the queue when the message arrived. It then has
// no turn and no reply, so its own re-arm is the last one.
it('an iMessage drain that finds no turn left keeps the reminder\'s alarm', async () => {
  const w = await world();
  await afterOneReply(w);
  await runInDurableObject(w.ownerStub, async (instance, state) => {
    const due = await remindInTwoHours(state);
    try {
      await (instance as unknown as { drainIMessage(): Promise<void> }).drainIMessage();
      expect(reminderDue(state)).toBe(due);
      expect(await state.storage.getAlarm()).toBe(scheduleNext(state));
    } finally { await state.storage.deleteAlarm(); }
  });
});

// An owner whose only surface is iMessage: no app, Telegram or WhatsApp binding. Scheduled work reaches them on iMessage,
// through the delivery outbox: a job settles only once the bridge reports what became of its message.
const iMessageOnly = async (w: Awaited<ReturnType<typeof world>>) => {
  await afterOneReply(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => { state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true); });
};
const DAY = () => new Date().toISOString().slice(0, 10);
// One alarm pass runs the due job; once the outbox's quarter-second hold on a new record passes, the next passes hand it to the
// bridge. Answers what the host pulled.
const scheduledOnIMessage = async (w: Awaited<ReturnType<typeof world>>, text: string) => {
  proof.reply = text;
  try { await runDurableObjectAlarm(w.ownerStub); await w.settle(); } finally { proof.reply = 'Scripted owner reply.'; }
  await new Promise(resolve => setTimeout(resolve, 300));
  await w.pump();
  const { delivery } = await w.host.pull();
  expect(delivery, 'the message reached the bridge').not.toBeNull();
  expect(JSON.parse(delivery!.body)).toMatchObject({ operation: 'send', text, binding: { subject: SUBJECT, chatGuid: CHAT } });
  return delivery!;
};
const hostReports = async (w: Awaited<ReturnType<typeof world>>, delivery: NonNullable<Awaited<ReturnType<SimulatedHost['pull']>>['delivery']>, at?: number) => {
  await w.host.postResult(delivery, await w.host.execute(delivery, at === undefined ? {} : { now: at }));
  await w.pump(2);
};
const deliveryRecords = (state: DurableObjectState) => new TelegramFinalOutbox(state.storage.kv).records();
const runsOf = (state: DurableObjectState, kind: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM background_runs WHERE kind = ?', kind).toArray().map((row) => row.status);
const seedDueReminder = (state: DurableObjectState) => {
  ensureSchema(state.storage);
  return reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: () => new Date(Date.now() - 3_600_000) }, () => 'rem-1')
    .set({ note: 'call Sam', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
};

// A Google grant that stops working: iMessage carries no connect button, so the notice is plain text through the delivery
// outbox, sent once per failure episode, and no connect link is minted (a new one would revoke the owner's open ones).
const deadGrantRead = async (w: Awaited<ReturnType<typeof world>>) => {
  proof.googleDead = true;
  await runInDurableObject(w.ownerStub, async (instance, state) => {
    await state.storage.put('origin', HOST_ORIGIN);
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
    const runtime = (instance as unknown as { setup(channel: string): { ready: Promise<unknown>; google: { client(feature: string): Promise<{ calendarPage(): Promise<unknown> } | null> } } }).setup('imessage');
    await runtime.ready;
    await (await runtime.google.client('calendar'))!.calendarPage().catch(() => undefined);
    await vi.waitFor(async () => expect(Object.keys(await state.storage.get<Record<string, number>>('google:reauth-noticed') ?? {})).toEqual(['local:owner@example.test']), { timeout: 5_000, interval: 20 });
  });
};

it('an iMessage-only owner whose Google grant stops working gets one plain reconnect notice on iMessage, and no link is minted', async () => {
  const w = await world();
  await iMessageOnly(w);
  await deadGrantRead(w);
  expect(w.fx.calls).not.toContain('connect_session_issue');
  await new Promise(resolve => setTimeout(resolve, 300));
  await w.pump();
  const { delivery } = await w.host.pull();
  expect(delivery, 'the notice reached the bridge').not.toBeNull();
  expect(JSON.parse(delivery!.body)).toMatchObject({ operation: 'send', text: reconnectNoticeText('console', 'owner@example.test'), binding: { subject: SUBJECT, chatGuid: CHAT } });
  await w.host.postResult(delivery!, await w.host.execute(delivery!));
  await w.pump(2);
  // The probe the circuit lets through fails again in the same episode, and says nothing more.
  await runInDurableObject(w.ownerStub, async (instance) => {
    const runtime = (instance as unknown as { setup(channel: string): { google: { client(feature: string): Promise<{ calendarPage(): Promise<unknown> } | null> } } }).setup('imessage');
    await (await runtime.google.client('calendar'))!.calendarPage().catch(() => undefined);
    expect(await runtime.google.client('calendar'), 'then the circuit keeps the dead grant out').toBeNull();
  });
  await w.pump(2);
  expect((await w.host.pull()).delivery).toBeNull();
  expect(forbiddenEgress).toEqual([]);
}, 15_000);

it('an iMessage turn that needs Google is told no button can be sent there, and mints no link', async () => {
  const w = await world();
  await iMessageOnly(w);
  proof.outputs.push([{ type: 'function_call', call_id: 'connect', name: 'connect_service', arguments: JSON.stringify({ service: 'google', feature: 'calendar' }) }], []);
  await handedTurn(w, 'Connect my Google calendar');
  const told = proof.turns.at(-1) ?? '';
  expect(told).toContain('No connect button was sent');
  expect(told).toContain('console');
  expect(told).not.toContain(CONNECT_BUTTON_SENT);
  expect(w.fx.calls).not.toContain('connect_session_issue');
});

it('an iMessage-only owner who asks for a reminder two hours out has it scheduled, and the alarm keeps the schedule\'s next entry', async () => {
  const w = await world();
  await iMessageOnly(w);
  proof.outputs.push([{ type: 'function_call', call_id: 'remind', name: 'set_reminder',
    arguments: JSON.stringify({ note: 'water plants', at: new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 16), repeat: 'none' }) }], []);
  try {
    await handedTurn(w, 'Remind me to water the plants in two hours');
    expect(proof.turns.join('\n')).not.toContain('Waldo cannot message this owner first here');
    const { alarm, next, reminder } = await ownerAlarm(w.ownerStub);
    expect(reminder).toBeGreaterThan(Date.now() + 110 * 60_000);
    expect(alarm).toBe(next);
  } finally { await clearOwnerAlarm(w.ownerStub); }
}, 15_000);

it('an iMessage-only owner\'s due reminder goes out on iMessage and settles once the bridge reports it', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => { await seedDueReminder(state); });
  // Each step leaves a wake for the next one: the fire queues the record, the transport pass freezes it for the bridge.
  const wakesSoon = () => runInDurableObject(w.ownerStub, async (_i, state) => expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1_000));
  proof.reply = REMINDER;
  try { await runDurableObjectAlarm(w.ownerStub); await w.settle(); } finally { proof.reply = 'Scripted owner reply.'; }
  await wakesSoon();
  await new Promise(resolve => setTimeout(resolve, 300));
  await runDurableObjectAlarm(w.ownerStub); await w.settle();
  // The part is in Waldo's custody for the bridge: frozen here, waking the owner to hand it over, or already handed over by a
  // platform alarm that fired meanwhile.
  const custody = await runInDurableObject(w.ownerStub, async (_i, state) => {
    const records = deliveryRecords(state).filter((row) => row.reminder);
    expect(records.map((row) => row.status)).toEqual(['accepted']);
    // Until the bridge reports, the console says only that the reminder is queued: nothing claims it was sent.
    expect(outboxRunNotes(records).get(records[0]!.reminder!.runId)).toBe('queued for delivery; waiting to hear it arrived');
    return new IMessageFinalOutbox(state.storage).records().filter((row) => row.replyRef.startsWith('proactive:reminder:')).map((row) => row.state);
  });
  expect(custody).toHaveLength(1);
  expect(['frozen', 'queued']).toContain(custody[0]);
  if (custody[0] === 'frozen') await wakesSoon();
  await w.pump();
  const { delivery } = await w.host.pull();
  expect(delivery, 'the reminder reached the bridge').not.toBeNull();
  expect(JSON.parse(delivery!.body)).toMatchObject({ operation: 'send', text: REMINDER, binding: { subject: SUBJECT, chatGuid: CHAT } });
  await runInDurableObject(w.ownerStub, async (_i, state) => expect(reminderRuns(state)).toEqual(['running']));
  // The bridge's report, which it makes on its own once the host posts the result, ends the delivery record and wakes the
  // owner to settle the job.
  await w.host.postResult(delivery!, await w.host.execute(delivery!));
  await w.settle();
  await vi.waitFor(async () => expect(await runInDurableObject(w.ownerStub, async (_i, state) =>
    deliveryRecords(state).filter((row) => row.reminder).map((row) => row.status))).toEqual(['delivered']), { timeout: 5_000, interval: 50 });
  await runInDurableObject(w.ownerStub, async (_i, state) => expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1_000));
  await w.pump(2);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    expect(reminderRuns(state)).toEqual(['completed']);
    expect(state.storage.sql.exec("SELECT id FROM schedule WHERE kind = 'reminder'").toArray()).toEqual([]);
  });
});

it('an iMessage-only owner\'s reminder that the bridge proves it never sent fails its run and keeps its note', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => { await seedDueReminder(state); });
  const delivery = await scheduledOnIMessage(w, REMINDER);
  await hostReports(w, delivery, Date.now() + 24 * 3_600_000);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    expect(reminderRunSummaries(state)).toEqual([{ status: 'failed', summary: 'reminder could not be delivered' }]);
    expect(state.storage.sql.exec<{ note: string }>('SELECT note FROM reminder_notes').toArray().map((row) => row.note)).toEqual(['call Sam']);
  });
});

// The Mac host is offline when a scheduled message falls due: the bridge refuses every hand-off, and once the hand-off age
// passes the owner side proves the message never went. No bridge report comes for it, so the alarm pass is what carries that
// result to the delivery record, and wakes the owner straight away to settle the job: the reminder fails just past the
// hand-off age, not a day later as unconfirmed.
it('an iMessage-only owner\'s reminder whose host stays offline fails just past the hand-off age', async () => {
  const w = await world();
  await iMessageOnly(w);
  expect((await w.host.heartbeat('offline')).status).toBe(200);
  await runInDurableObject(w.ownerStub, async (_i, state) => { await seedDueReminder(state); });
  const t0 = Date.now(), maxAge = PROPOSED_LOCAL_TEST_POLICY.replyHandoffMaxAgeMs;
  const reminderParts = (state: DurableObjectState) => new IMessageFinalOutbox(state.storage).records().filter((row) => row.replyRef.startsWith('proactive:reminder:'));
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  try {
    proof.reply = REMINDER;
    try { await runDurableObjectAlarm(w.ownerStub); await w.settle(); } finally { proof.reply = 'Scripted owner reply.'; }
    await moveClock(w, t0 + 1_000);
    await w.pump(2);
    const frozenAt = await runInDurableObject(w.ownerStub, async (_i, state) => {
      const records = deliveryRecords(state).filter((row) => row.reminder);
      expect(records.map((row) => row.status)).toEqual(['accepted']);
      expect(outboxRunNotes(records).get(records[0]!.reminder!.runId)).toBe('queued for delivery; waiting to hear it arrived');
      expect(reminderParts(state).map((row) => row.state)).toEqual(['frozen']);
      expect(reminderRuns(state)).toEqual(['running']);
      // The owner keeps a wake for the next hand-off try, well inside the hand-off age.
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 60_000);
      return reminderParts(state)[0]!.frozenAt;
    });
    expect((await w.host.pull()).delivery).toBeNull();
    await moveClock(w, frozenAt + maxAge + 1);
    await runDurableObjectAlarm(w.ownerStub); await w.settle();
    await runInDurableObject(w.ownerStub, async (_i, state) => {
      expect(reminderParts(state)).toMatchObject([{ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'bridge_unavailable' } }]);
      expect(deliveryRecords(state).filter((row) => row.reminder)).toMatchObject([{ status: 'blocked', reason: 'provider_failed' }]);
    });
    // The job settles on the transport lane, which the passes take in turn: in this pass, or on a wake due at once.
    for (let pass = 0; pass < 3 && await runInDurableObject(w.ownerStub, async (_i, state) => reminderRuns(state)[0] === 'running'); pass++) {
      await runInDurableObject(w.ownerStub, async (_i, state) => expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1_000));
      await runDurableObjectAlarm(w.ownerStub); await w.settle();
    }
    await runInDurableObject(w.ownerStub, async (_i, state) => {
      expect(reminderRunSummaries(state)).toEqual([{ status: 'failed', summary: 'reminder could not be delivered' }]);
      expect(state.storage.sql.exec<{ note: string }>('SELECT note FROM reminder_notes').toArray().map((row) => row.note)).toEqual(['call Sam']);
    });
  } finally { vi.useRealTimers(); }
});

// A message longer than one iMessage goes to the bridge as two commands, one per part, each frozen under its own key. The model
// writes `text` for the due job, and the host reports on each part in turn: sent, or proved never sent. The bridge takes one
// command at a time, so each next part goes on the owner's next hand-off try, seconds later; the job's record waits for the
// bridge until the last report. Before that retry, the drain that handed over a part polls the bridge's slot, which that part
// holds until the host pulls it; here each poll's pause moves the test's clock instead of sleeping. Answers the commands the
// bridge received.
const LONG = 'Call Sam about the harbour fund before lunch. '.repeat(120).trim();
const inTwoParts = async (w: Awaited<ReturnType<typeof world>>, job: 'reminder' | 'heartbeat', reports: readonly ('sent' | 'not_started')[]) => {
  expect(LONG.length).toBeGreaterThan(4_096);
  const status = () => runInDurableObject(w.ownerStub, async (_i, state) => deliveryRecords(state).filter((row) => row[job]).map((row) => row.status));
  const received: { text: string; commandId: string }[] = [];
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  const host = Object.getOwnPropertyDescriptor(OwnerDO.prototype, 'imessageHost')!.get!;
  vi.spyOn(OwnerDO.prototype as unknown as { imessageHost: OwnerHost }, 'imessageHost', 'get')
    .mockImplementation(function (this: OwnerDO) { return { ...host.call(this), wait: async (ms: number) => { vi.setSystemTime(Date.now() + ms); } }; });
  try {
    proof.reply = LONG;
    try { await runDurableObjectAlarm(w.ownerStub); await w.settle(); } finally { proof.reply = 'Scripted owner reply.'; }
    await moveClock(w, t0 + 1_000, [job]);
    for (const [part, report] of reports.entries()) {
      await w.pump();
      const { delivery } = await w.host.pull();
      expect(delivery, `part ${part} reached the bridge`).not.toBeNull();
      received.push(JSON.parse(delivery!.body));
      expect(await status()).toEqual(['accepted']);
      await hostReports(w, delivery!, report === 'sent' ? undefined : Date.now() + 24 * 3_600_000);
      await moveClock(w, Date.now() + 6_000, [job]);
    }
    await w.pump(2);
  } finally { vi.useRealTimers(); }
  return received;
};

it('an iMessage-only owner\'s reminder too long for one message goes out in two parts and settles once both arrive', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => { await seedDueReminder(state); });
  const received = await inTwoParts(w, 'reminder', ['sent', 'sent']);
  expect(new Set(received.map((command) => command.commandId)).size).toBe(2);
  expect(LONG.startsWith(received[0]!.text)).toBe(true);
  expect(LONG.endsWith(received[1]!.text)).toBe(true);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    const [record] = deliveryRecords(state).filter((row) => row.reminder);
    expect(record!.status).toBe('delivered');
    expect(new IMessageFinalOutbox(state.storage).records().filter((row) => row.replyRef.startsWith('proactive:reminder:')).map((row) => row.replyRef))
      .toEqual([`proactive:${record!.id}:0`, `proactive:${record!.id}:1`]);
    expect(reminderRuns(state)).toEqual(['completed']);
  });
});

// A later part the bridge proves never sent, after an earlier part arrived, leaves the message on the owner's phone in part: the
// job says it was partly sent, not that it could not be delivered.
it('an iMessage-only owner\'s two-part reminder whose second part never went says it was partly sent', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => { await seedDueReminder(state); });
  await inTwoParts(w, 'reminder', ['sent', 'not_started']);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    expect(deliveryRecords(state).filter((row) => row.reminder)).toMatchObject([{ status: 'blocked', reason: 'provider_failed', arrived: [true, false] }]);
    expect(reminderRunSummaries(state)).toEqual([{ status: 'failed', summary: 'reminder partly sent; the rest was not sent' }]);
  });
});

it('an iMessage-only owner\'s two-part follow-up whose second part never went says it was partly sent', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => { await dueFollowUp(state); });
  await inTwoParts(w, 'heartbeat', ['sent', 'not_started']);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    expect(deliveryRecords(state).filter((row) => row.heartbeat)).toMatchObject([{ status: 'blocked', reason: 'provider_failed', arrived: [true, false] }]);
    expect(state.storage.sql.exec<{ status: string; summary: string | null }>("SELECT status, summary FROM background_runs WHERE kind = 'heartbeat'").toArray())
      .toEqual([{ status: 'failed', summary: 'heartbeat partly sent; the rest was not sent' }]);
  });
});

it('an iMessage-only owner\'s morning brief goes out on iMessage and counts as sent only once the bridge reports it', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    dayPlanBook(state.storage.sql).save(DAY(), { card: 'card:brief', time: '00:00', reason: 'planned' });
    await new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: null });
  });
  const brief = 'Morning. Two things on today.';
  const delivery = await scheduledOnIMessage(w, brief);
  const sent = (state: DurableObjectState) => dayPlanBook(state.storage.sql).read(DAY()).find((row) => row.card === 'card:brief')?.sent;
  await runInDurableObject(w.ownerStub, async (_i, state) => expect(sent(state)).toBeFalsy());
  await hostReports(w, delivery);
  await runInDurableObject(w.ownerStub, async (_i, state) => expect(sent(state)).toBeTruthy());
});

// A loop past its date, with the follow-up tick due now. The ticks recur on the wall clock's half hours, so the tick is seeded
// with its own phase: the next one is due a full interval later, never at a half hour the test happens to run across.
const dueFollowUp = async (state: DurableObjectState) => {
  loopBook(state.storage.sql, { newId: () => 'loop-1', now: () => Date.now() - 3 * 3_600_000 }).open({ title: 'Send the invoice', due: new Date(Date.now() - 3_600_000).toISOString().slice(0, 16) });
  state.storage.sql.exec("DELETE FROM schedule WHERE kind = 'heartbeat'");
  const due = Date.now() - 60_000;
  await new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', payloadRefs: { id: HEARTBEAT_ID },
    occurrenceAt: due, dueAt: due, recurrence: { type: 'interval', every_ms: HEARTBEAT_EVERY_MS, phase_ms: due % HEARTBEAT_EVERY_MS } });
};
it('an iMessage-only owner\'s follow-up on a loop past its date goes out on iMessage and settles on the bridge\'s report', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => { await dueFollowUp(state); });
  const followUp = 'Did the invoice go out?';
  const delivery = await scheduledOnIMessage(w, followUp);
  await runInDurableObject(w.ownerStub, async (_i, state) => expect(runsOf(state, 'heartbeat')).toEqual(['running']));
  await hostReports(w, delivery);
  await runInDurableObject(w.ownerStub, async (_i, state) => expect(runsOf(state, 'heartbeat')).toEqual(['completed']));
});

it('an iMessage-only owner\'s follow-up the bridge proves it never sent fails, saying it could not be delivered', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => { await dueFollowUp(state); });
  const delivery = await scheduledOnIMessage(w, 'Did the invoice go out?');
  await hostReports(w, delivery, Date.now() + 24 * 3_600_000);
  await runInDurableObject(w.ownerStub, async (_i, state) => expect(state.storage.sql.exec<{ status: string; summary: string | null }>("SELECT status, summary FROM background_runs WHERE kind = 'heartbeat'").toArray())
    .toEqual([{ status: 'failed', summary: 'heartbeat could not be delivered' }]));
});

// An iMessage-only owner's runtime arms their own scheduled work (memory, the event sweep, follow-up ticks), as a WhatsApp-only
// owner's runtime does. An owner who also has the app keeps the native-chat rule: an iMessage turn arms nothing for them.
const armedKinds = (w: Awaited<ReturnType<typeof world>>) => runInDurableObject(w.ownerStub, async (_i, state) =>
  state.storage.sql.exec<{ kind: string }>("SELECT kind FROM schedule WHERE status = 'armed' ORDER BY kind").toArray().map((row) => row.kind));
it('an iMessage-only owner\'s first turn arms their own scheduled work', async () => {
  const w = await world();
  await afterOneReply(w);
  expect(await armedKinds(w)).toEqual(expect.arrayContaining(['dreaming', 'heartbeat', 'pre_activity_spot']));
  await clearOwnerAlarm(w.ownerStub);
});

it('an owner who also has the app arms no scheduled work from an iMessage turn', async () => {
  const w = await world();
  await runInDurableObject(w.ownerStub, async (_i, state) => { state.storage.kv.put('app_subject', String(appSubjectFor(w.ownerName))); });
  await afterOneReply(w);
  expect(await armedKinds(w)).toEqual([]);
});

// An owner with no surface at all runs no scheduled work and keeps no wake for it. So does one whose iMessage sender the
// directory no longer binds: the pass asks the directory, finds no owner, and sleeps; and Waldo refuses to promise them a
// message first.
it('an owner with no surface keeps no schedule wake and runs nothing that is due', async () => {
  const w = await world();
  await runInDurableObject(w.ownerStub, async (_i, state) => { state.storage.kv.put('timezone', 'UTC'); await seedDueReminder(state); });
  await runDurableObjectAlarm(w.ownerStub); await w.settle();
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM schedule WHERE kind = 'reminder'").toArray().map((row) => row.status)).toEqual(['armed']);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it('once an iMessage-only owner unlinks, their due reminder does not run, nothing wakes for it, and a new one is refused', async () => {
  const w = await world();
  await iMessageOnly(w);
  expect((await w.action('imessage.unlink')).status).toBe(303);
  await runInDurableObject(w.ownerStub, async (_i, state) => { await seedDueReminder(state); });
  await runDurableObjectAlarm(w.ownerStub); await w.settle();
  await runInDurableObject(w.ownerStub, async (instance, state) => {
    expect(reminderRuns(state)).toEqual([]);
    expect(await state.storage.getAlarm()).toBeNull();
    expect(await (instance as unknown as { proactiveReachable(): Promise<boolean> }).proactiveReachable()).toBe(false);
  });
});

// Outside a scheduled pass no owner job is named, so a reminder fired there reaches no responder: nothing is written or queued.
it('a reminder fired on iMessage outside a scheduled pass runs nothing', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (instance, state) => {
    const runtime = (instance as unknown as { setup(channel: 'imessage'): { ready: Promise<void>; fire(entry: ScheduleEntry): Promise<unknown>; reminders: ReturnType<typeof reminderBook>; scheduler: Scheduler } }).setup('imessage');
    await runtime.ready;
    const reminder = await runtime.reminders.set({ note: 'call Sam', at: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16), repeat: 'none' });
    await expect(runtime.fire(runtime.scheduler.read(reminder.id)!)).rejects.toThrow();
    expect(runtime.reminders.note(reminder.id)).toBe('call Sam');
    expect(deliveryRecords(state).filter((row) => row.reminder)).toEqual([]);
  });
});

// The iMessage outbox's own results reach the delivery records waiting on them, whoever settled them: the bridge's report, or
// the owner side proving a hand-off never went. Sent arrives; not_started fails; an unknown result leaves the record waiting.
it('iMessage results reach the delivery records waiting on them: sent arrives, not_started fails, unknown waits', async () => {
  const w = await world();
  await iMessageOnly(w);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    const subject = state.storage.kv.get<string>('imessage_subject')!, outbox = new IMessageFinalOutbox(state.storage), latest = new IMessageOwnerInbox(state.storage).latest()!;
    const frozen = (id: string) => outbox.freezeProactive(id, `wpc_${id}`, targetOf(latest), 'Time to call Sam.');
    const target = { bridgeId: latest.binding.bridgeId, accountId: latest.binding.accountId, chatGuid: latest.binding.chatGuid };
    const results = {
      sent: { version: 1, commandId: 'wpc_sent', target, state: 'local_recorded', messageGuid: 'guid-1', evidence: { kind: 'local_database', reference: 'row-1' } },
      lost: { version: 1, commandId: 'wpc_lost', target, state: 'rejected', disposition: 'not_started', reason: 'bridge_unavailable' },
      unsure: { version: 1, commandId: 'wpc_unsure', target, state: 'unknown', disposition: 'may_have_completed', reason: 'mutation_deadline' },
    } as const;
    for (const [id, result] of Object.entries(results)) { frozen(id); outbox.settle(`proactive:${id}`, `wpc_${id}`, result); }
    const now = Date.now();
    state.storage.kv.put('telegram_final_outbox_v1', Object.keys(results).map((id) => ({ id: `reminder:${id}`, trace: id, payload: { chat_id: Number(subject), text: 'Time to call Sam.' }, digest: id,
      ownerSubject: subject, doName: w.ownerName, status: 'accepted', dueAt: now + 3_600_000, createdAt: now, attempts: 1, deliveredParts: 1, providerMessageIds: [`wpc_${id}`], arrivalBy: now + 3_600_000 })));
    expect(observeIMessageReports(state.storage, subject, now)).toBe(2);
    expect(Object.fromEntries(deliveryRecords(state).map((row) => [row.id, row.status]))).toEqual({ 'reminder:sent': 'delivered', 'reminder:lost': 'blocked', 'reminder:unsure': 'accepted' });
    expect(observeIMessageReports(state.storage, subject, now)).toBe(0);
  });
});

// A turn the alarm pass runs queues its reply's drain behind the pass, so that drain is the last re-arm, after the pass has
// ended. This fixture's owner has only iMessage, so the pass runs on it, and the drain's re-arm, last, keeps the reminder's
// wake. The message is admitted straight into the owner's inbox, as the bridge's handoff does, so the pass runs it.
it('a turn the alarm pass runs keeps the reminder\'s alarm once its reply goes out', async () => {
  const w = await world();
  await afterOneReply(w);
  const due = await runInDurableObject(w.ownerStub, async (_i, state) => {
    const reminder = await remindInTwoHours(state);
    const owned = new IMessageOwnerInbox(state.storage), first = owned.records()[0]!;
    const dedupKey = JSON.stringify(['imessage', 'in-pass', crypto.randomUUID()]), digest = await sha256Hex(dedupKey);
    const admitted = await owned.admit({ environment: first.environment, binding: first.binding, revision: first.revision, ownerDoName: first.ownerDoName,
      bindingDigest: first.bindingDigest, conversationRef: first.conversationRef, bridgeDoName: first.bridgeDoName, dedupKey, digest,
      commandId: `wrc_${digest.slice(0, 40)}`, text: 'What is on today?', occurredAt: Date.now() });
    expect(admitted.kind).toBe('admitted');
    return reminder;
  });
  try {
    await runDurableObjectAlarm(w.ownerStub);
    await vi.waitFor(async () => expect((await inbox(w.ownerStub)).map(record => record.state)).toEqual(['completed', 'completed']), { timeout: 8_000, interval: 50 });
    expect(proof.turns).toHaveLength(2);
    await ownerIdle(w.ownerStub);
    const { alarm, next, reminder } = await ownerAlarm(w.ownerStub);
    expect(reminder).toBe(due);
    expect(alarm).toBe(next);
  } finally { await clearOwnerAlarm(w.ownerStub); }
}, 15_000);

// Progress notes. The pacer's marks shrink to test scale; the wait still counts from the message's send time, which the
// simulated host puts a second before it posts the event.
const progressTiming = (stub: DurableObjectStub, firstMs: number, secondMs: number) => runInDurableObject(stub, async instance => {
  (instance as unknown as { iMessageProgressTiming: unknown }).iMessageProgressTiming = { firstMs, secondMs, minTurnMs: 0 };
});
// The host pulls the next command once it is there and sends it, as the real host's poll does. Polling stays well inside
// the bridge's edge limit (120 requests a minute per host address); the real host pulls every 2 s.
const sendNext = async (w: Awaited<ReturnType<typeof world>>): Promise<Delivery> => {
  let delivery: Delivery | null = null;
  await vi.waitFor(async () => { const pulled = await w.host.pull(); expect(pulled.status).toBe(200); delivery = pulled.delivery; expect(delivery).not.toBeNull(); }, { timeout: 10_000, interval: 250 });
  await w.host.postResult(delivery!, await w.host.execute(delivery!));
  return delivery!;
};
const sentTexts = (w: Awaited<ReturnType<typeof world>>) => w.host.nativeSends.map(send => send.text);
const traceRows = (stub: DurableObjectStub) => runInDurableObject(stub, async (_i, state) =>
  state.storage.sql.exec<{ hop: string; ok: number; note: string | null }>('SELECT hop, ok, note FROM trace_log ORDER BY id').toArray());
const waitFor = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 8_000, interval: 25 });

it('a slow iMessage turn sends one progress note, then its reply, in that order', async () => {
  const w = await world();
  await w.pairAndActivate();
  await progressTiming(w.ownerStub, 1_200, 60_000);
  proof.notes.push('Looking at dinner spots near you and checking tonight on your calendar.');
  proof.hold = async () => { await sendNext(w); };
  await replyFor(w, 'Find me three dinner options near me tonight and check my calendar');
  await sendNext(w);
  await w.pump(2);
  expect(sentTexts(w)).toEqual(['Looking at dinner spots near you and checking tonight on your calendar.', 'Scripted owner reply.']);
  expect((await outbox(w.ownerStub)).map(r => [r.replyRef.split(':')[0], r.state, r.result?.state])).toEqual([['progress', 'settled', 'local_recorded'], ['reply', 'settled', 'local_recorded']]);
  expect(proof.progressInputs).toHaveLength(1);
  expect((await traceRows(w.ownerStub)).filter(row => row.hop === 'progress_note')).toEqual([{ hop: 'progress_note', ok: 1, note: 'sent:model' }]);
  expect(forbiddenEgress).toEqual([]);
}, 20_000);

it('a progress pacer that cannot start leaves the turn to answer as usual', async () => {
  const w = await world();
  await w.pairAndActivate();
  vi.spyOn(ProgressPacer.prototype, 'start').mockImplementation(() => { throw new Error('pacer unavailable'); });
  await replyFor(w, 'What time is it?');
  await sendNext(w);
  expect(sentTexts(w)).toEqual(['Scripted owner reply.']);
  expect((await inbox(w.ownerStub)).map(record => record.state)).toEqual(['completed']);
}, 20_000);

it('a fast iMessage turn sends no note and asks the model for none', async () => {
  const w = await world();
  await w.pairAndActivate();
  await replyFor(w, 'What time is it?');
  await sendNext(w);
  expect(sentTexts(w)).toEqual(['Scripted owner reply.']);
  expect(proof.progressInputs).toEqual([]);
  expect((await outbox(w.ownerStub)).map(r => r.replyRef.split(':')[0])).toEqual(['reply']);
}, 20_000);

it('a very long iMessage turn sends two notes at most, each written from the steps so far, and never a third', async () => {
  const w = await world();
  await w.pairAndActivate();
  await runInDurableObject(w.ownerStub, async (_i, state) => { state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true); });
  await progressTiming(w.ownerStub, 1_200, 7_000);
  proof.notes.push('Checking your reminders first.', 'Still comparing a few places against your evening.');
  // The first model call asks for a tool; the second holds the turn while both notes go out.
  proof.outputs.push([{ type: 'function_call', call_id: 'reminders', name: 'list_reminders', arguments: '{}' }], []);
  proof.hold = async () => { proof.hold = async () => {
    await sendNext(w); await sendNext(w);
    await new Promise(resolve => setTimeout(resolve, 2_500));
    expect((await w.host.pull()).delivery).toBeNull();
  }; };
  await replyFor(w, 'Find me three dinner options near me tonight and check my calendar');
  await sendNext(w);
  expect(sentTexts(w)).toEqual(['Checking your reminders first.', 'Still comparing a few places against your evening.', 'Scripted owner reply.']);
  expect(proof.progressInputs).toHaveLength(2);
  expect(proof.progressInputs[1]).toContain('list_reminders');
  // Steps are tools only: a hop that merely starts with tool_ (tool_eligibility) is not one.
  expect(proof.progressInputs[1]).toContain('Steps finished so far, in order: list_reminders.');
  expect(proof.progressInputs[1]).toContain('Checking your reminders first.');
}, 30_000);

it('a note the model is still writing when the reply freezes is dropped, never sent after the reply', async () => {
  const w = await world();
  await w.pairAndActivate();
  await progressTiming(w.ownerStub, 1_200, 60_000);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  proof.progressHold = () => released;
  proof.hold = () => waitFor(() => proof.progressInputs.length === 1);
  await replyFor(w, 'Plan my Saturday around the farmers market');
  await sendNext(w);
  release();
  await w.pump(2);
  await vi.waitFor(async () => expect((await traceRows(w.ownerStub)).filter(row => row.hop === 'progress_note')).toEqual([{ hop: 'progress_note', ok: 0, note: 'closed:model' }]), { timeout: 8_000 });
  expect((await w.host.pull()).delivery).toBeNull();
  expect(sentTexts(w)).toEqual(['Scripted owner reply.']);
  expect((await outbox(w.ownerStub)).map(r => r.replyRef.split(':')[0])).toEqual(['reply']);
}, 20_000);

it('a note the host has not pulled when the reply lands is withdrawn by the reply as not_started', async () => {
  const w = await world();
  await w.pairAndActivate();
  await progressTiming(w.ownerStub, 1_200, 60_000);
  const queued: string[] = [], markQueued = IMessageFinalOutbox.prototype.markQueued;
  vi.spyOn(IMessageFinalOutbox.prototype, 'markQueued').mockImplementation(function (this: IMessageFinalOutbox, replyRef: string) { queued.push(replyRef); return markQueued.call(this, replyRef); });
  proof.hold = () => waitFor(() => queued.some(ref => ref.startsWith('progress:')));
  await replyFor(w, 'Find me a dentist near work');
  await sendNext(w);
  await w.pump(2);
  expect(sentTexts(w)).toEqual(['Scripted owner reply.']);
  const [note, reply] = await outbox(w.ownerStub);
  expect(note).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'progress_superseded' } });
  expect(reply).toMatchObject({ replyRef: expect.stringMatching(/^reply:/), state: 'settled', result: { state: 'local_recorded' } });
}, 20_000);

it('a reply behind a note the host already pulled, still unsent after the wait, retries in a second', async () => {
  const w = await world();
  await w.pairAndActivate();
  await progressTiming(w.ownerStub, 1_200, 60_000);
  const retries: (number | undefined)[] = [], retryLater = IMessageFinalOutbox.prototype.retryLater;
  vi.spyOn(IMessageFinalOutbox.prototype, 'retryLater').mockImplementation(function (this: IMessageFinalOutbox, ref: string, maxAge: number, delay?: number) {
    if (ref.startsWith('reply:')) retries.push(delay); return retryLater.call(this, ref, maxAge, delay);
  });
  let note: Delivery | null = null;
  proof.hold = async () => { await vi.waitFor(async () => { note = (await w.host.pull()).delivery; expect(note).not.toBeNull(); }, { timeout: 10_000, interval: 250 }); };
  await replyFor(w, 'Find me a dentist near work');
  expect(retries[0]).toBe(1_000);
  await w.host.postResult(note!, await w.host.execute(note!));
  // The retry is a second out; the owner's alarm hands the reply over once it is due.
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await w.pump(3);
  await sendNext(w);
  expect(sentTexts(w)).toEqual(['Working through your request now.', 'Scripted owner reply.']);
}, 20_000);

const admissions = () => {
  const admitted: string[] = [], admit = IMessageOwnerInbox.prototype.admit;
  vi.spyOn(IMessageOwnerInbox.prototype, 'admit').mockImplementation(async function (this: IMessageOwnerInbox, ...args: Parameters<typeof admit>) {
    const result = await admit.apply(this, args); admitted.push(result.kind); return result;
  });
  return () => admitted.filter(kind => kind === 'admitted').length;
};

it('a reply that meets a note the host is still sending waits for that send and goes out before the owner\'s next message runs', async () => {
  const w = await world();
  await w.pairAndActivate();
  await progressTiming(w.ownerStub, 1_200, 60_000);
  let setTiming!: (timing: unknown) => void;
  await runInDurableObject(w.ownerStub, async instance => { setTiming = timing => { (instance as unknown as { iMessageProgressTiming: unknown }).iMessageProgressTiming = timing; }; });
  const admitted = admissions();
  const enqueue = IMessageBridgeDO.prototype.enqueueReply, outcomes: string[] = [];
  vi.spyOn(IMessageBridgeDO.prototype, 'enqueueReply').mockImplementation(async function (this: IMessageBridgeDO, input) {
    const outcome = await enqueue.call(this, input); outcomes.push(`${input.replyRef.split(':')[0]}:${outcome.kind}`); return outcome;
  });
  const retries: string[] = [], retryLater = IMessageFinalOutbox.prototype.retryLater;
  vi.spyOn(IMessageFinalOutbox.prototype, 'retryLater').mockImplementation(function (this: IMessageFinalOutbox, ref: string, maxAge: number, delay?: number) {
    retries.push(ref); return retryLater.call(this, ref, maxAge, delay);
  });
  let note: Delivery | null = null, duringNextTurn: string[] = [];
  proof.hold = async () => {
    await vi.waitFor(async () => { note = (await w.host.pull()).delivery; expect(note).not.toBeNull(); }, { timeout: 10_000, interval: 250 });
    setTiming({ firstMs: 60_000, secondMs: 60_000, minTurnMs: 0 });
    expect((await w.host.send(w.host.message('Make it vegetarian'))).status).toBe(200);
    await waitFor(() => admitted() === 2);
    // The reply meets the slot the note still holds; the host finishes that send a moment later.
    void waitFor(() => outcomes.includes('reply:busy')).then(async () => { await w.host.postResult(note!, await w.host.execute(note!)); });
    proof.hold = async () => { await sendNext(w).catch(() => undefined); duringNextTurn = sentTexts(w); };
  };
  await replyFor(w, 'Find me three dinner options near me tonight');
  await w.pump(2);
  await sendNext(w);
  expect(outcomes).toContain('reply:busy');
  expect(duringNextTurn).toEqual(['Working through your request now.', 'Scripted owner reply.']);
  expect(sentTexts(w)).toEqual(['Working through your request now.', 'Scripted owner reply.', 'Scripted owner reply.']);
  expect(retries).toEqual([]);
}, 30_000);

it('a note from the next turn never reaches the owner before the reply still waiting from the turn before it', async () => {
  const w = await world();
  await w.pairAndActivate();
  await progressTiming(w.ownerStub, 1_200, 600_000);
  let setTiming!: (timing: unknown) => void;
  await runInDurableObject(w.ownerStub, async instance => { setTiming = timing => { (instance as unknown as { iMessageProgressTiming: unknown }).iMessageProgressTiming = timing; }; });
  const admitted = admissions();
  const retries: string[] = [], retryLater = IMessageFinalOutbox.prototype.retryLater;
  vi.spyOn(IMessageFinalOutbox.prototype, 'retryLater').mockImplementation(function (this: IMessageFinalOutbox, ref: string, maxAge: number, delay?: number) {
    retries.push(ref); return retryLater.call(this, ref, maxAge, delay);
  });
  const drops: string[] = [], dropProgress = IMessageFinalOutbox.prototype.dropProgress;
  vi.spyOn(IMessageFinalOutbox.prototype, 'dropProgress').mockImplementation(function (this: IMessageFinalOutbox, ...args: Parameters<typeof dropProgress>) {
    drops.push(args[0]); return dropProgress.apply(this, args);
  });
  const LATER = 'Switching the options to vegetarian ones.';
  proof.notes.push('Looking at dinner spots near you.', LATER);
  const hostStep = async () => {
    const pulled = await w.host.pull(); expect(pulled.status).toBe(200);
    if (pulled.delivery) await w.host.postResult(pulled.delivery, await w.host.execute(pulled.delivery));
  };
  let note: Delivery | null = null;
  proof.hold = async () => {
    // Turn 1: the host has pulled note 1 and is still sending it.
    await vi.waitFor(async () => { note = (await w.host.pull()).delivery; expect(note).not.toBeNull(); }, { timeout: 10_000, interval: 250 });
    // Turn 2's note falls due once the bridge's own short hold for a waiting reply has lapsed.
    setTiming({ firstMs: 10_000, secondMs: 600_000, minTurnMs: 0 });
    expect((await w.host.send(w.host.message('Make it vegetarian'))).status).toBe(200);
    await waitFor(() => admitted() === 2);
    // The slow send finishes only after reply 1 has given up its polls and gone to its retry.
    void vi.waitFor(() => expect(retries.some(ref => ref.startsWith('reply:'))).toBe(true), { timeout: 15_000, interval: 50 })
      .then(async () => { await w.host.postResult(note!, await w.host.execute(note!)); });
    // Turn 2 runs while the host keeps pulling, until its note has been settled or sent.
    proof.hold = () => vi.waitFor(async () => { await hostStep(); expect(drops.includes('progress_yields') || sentTexts(w).includes(LATER)).toBe(true); }, { timeout: 20_000, interval: 500 });
  };
  await replyFor(w, 'Find me three dinner options near me tonight');
  await w.pump(2);
  // Reply 2 met the slot reply 1 held; its retry is an owner alarm, which this harness runs through pump.
  await vi.waitFor(async () => { await hostStep(); await w.pump(1); expect(sentTexts(w)).toHaveLength(3); }, { timeout: 20_000, interval: 500 });
  expect(sentTexts(w)).toEqual(['Looking at dinner spots near you.', 'Scripted owner reply.', 'Scripted owner reply.']);
  expect(proof.progressInputs).toHaveLength(2);
  const later = (await outbox(w.ownerStub)).filter(r => r.replyRef.startsWith('progress:') && r.replyRef.endsWith(':1'))[1];
  expect(later).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'progress_yields' } });
}, 60_000);

it('a turn that starts just after a reply counts its wait from that reply, not from the owner\'s earlier message', async () => {
  const w = await world();
  await w.pairAndActivate();
  await progressTiming(w.ownerStub, 60_000, 600_000);
  let setTiming!: (timing: unknown) => void;
  await runInDurableObject(w.ownerStub, async instance => { setTiming = timing => { (instance as unknown as { iMessageProgressTiming: unknown }).iMessageProgressTiming = timing; }; });
  const admitted = admissions();
  proof.hold = async () => {
    expect((await w.host.send(w.host.message('And book the earliest one'))).status).toBe(200);
    await waitFor(() => admitted() === 2);
    // By the time its turn starts, the second message is older than that turn's first mark.
    setTiming({ firstMs: 2_000, secondMs: 600_000, minTurnMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 2_500));
    proof.hold = async () => { await sendNext(w); await new Promise(resolve => setTimeout(resolve, 500)); };
  };
  await replyFor(w, 'Find me a dentist near work');
  await w.pump(2);
  await sendNext(w);
  expect(sentTexts(w)).toEqual(['Scripted owner reply.', 'Scripted owner reply.']);
  expect(proof.progressInputs).toEqual([]);
}, 30_000);

it('two messages already waiting when a drain starts each have their reply handed over before the next one runs', async () => {
  const w = await world();
  await w.pairAndActivate();
  const admitted = admissions();
  let duringThirdTurn: string[] = [];
  proof.hold = async () => {
    for (const text of ['And the weather there', 'And what to wear']) expect((await w.host.send(w.host.message(text))).status).toBe(200);
    await waitFor(() => admitted() === 3);
    proof.hold = async () => { await sendNext(w); proof.hold = async () => { await sendNext(w).catch(() => undefined); duringThirdTurn = sentTexts(w); }; };
  };
  await replyFor(w, 'Plan a day trip to the coast');
  await w.pump(2);
  await sendNext(w);
  expect(duringThirdTurn).toEqual(['Scripted owner reply.', 'Scripted owner reply.']);
  expect(sentTexts(w)).toHaveLength(3);
  expect((await inbox(w.ownerStub)).map(record => record.state)).toEqual(['completed', 'completed', 'completed']);
}, 30_000);

it('an iMessage turn that sent a progress note keeps the alarm for the owner\'s reminder two hours out', async () => {
  const w = await world();
  await afterOneReply(w);
  await progressTiming(w.ownerStub, 1_200, 60_000);
  const due = await runInDurableObject(w.ownerStub, (_i, state) => remindInTwoHours(state));
  proof.hold = async () => { await sendNext(w); };
  try {
    await handedTurn(w, 'Book me a table somewhere quiet tonight');
    expect(sentTexts(w)).toEqual(['Scripted owner reply.', 'Working through your request now.']);
    // The note wakes nothing: the reminder keeps its entry, and the alarm holds the schedule's next one.
    const { alarm, next, reminder } = await ownerAlarm(w.ownerStub);
    expect(reminder).toBe(due);
    expect(alarm).toBe(next);
  } finally { await clearOwnerAlarm(w.ownerStub); }
}, 20_000);

it('with capture off, neither the owner\'s words nor the note reach the console or the trace table', async () => {
  const w = await world();
  await w.pairAndActivate();
  await progressTiming(w.ownerStub, 1_200, 60_000);
  const lines: string[] = [];
  for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  proof.notes.push('Reading the Priya thread about plan zebra-6612 now.');
  proof.hold = async () => { await sendNext(w); };
  await replyFor(w, 'My HRV was 4471 so find a calm plan zebra-6612 with Priya');
  await sendNext(w);
  expect(sentTexts(w)[0]).toBe('Reading the Priya thread about plan zebra-6612 now.');
  const rows = JSON.stringify(await traceRows(w.ownerStub));
  for (const secret of ['4471', 'zebra-6612', 'Priya']) {
    expect(rows).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(secret);
  }
}, 20_000);

it('the bridge refuses a note once its reply is in the mailbox, a note never waits for the slot, and a waiting reply keeps notes off it', async () => {
  const w = await world();
  await w.pairAndActivate();
  await replyFor(w, 'Morning');
  const [reply] = await outbox(w.ownerStub);
  expect(reply).toMatchObject({ replyRef: expect.stringMatching(/^reply:/), state: 'queued' });
  const turn = reply!.replyRef.split(':')[1];
  const handoff = (replyRef: string, commandId: string, text = 'A note.') => w.bridgeStub().enqueueReply({ replyRef, commandId, text, ownerDoName: reply!.ownerDoName,
    revision: reply!.revision, bindingDigest: reply!.bindingDigest, ...(reply!.subject !== undefined ? { subject: reply!.subject } : {}) });
  // While the reply holds the slot a note is refused at once.
  expect(await handoff(`progress:${turn}:1`, 'wpn1_early')).toMatchObject({ kind: 'terminal', result: { state: 'rejected', disposition: 'not_started', reason: 'progress_busy' } });
  await sendNext(w);
  // Once the reply is sent the slot is free, and a note for that turn is still refused: it would follow its reply.
  expect(await handoff(`progress:${turn}:1`, 'wpn1_late')).toMatchObject({ kind: 'terminal', result: { reason: 'progress_superseded' } });
  // A note for another turn takes the free slot; once the host has pulled it, a reply waits, and while it waits no note goes.
  expect(await handoff('progress:imsg-other:1', 'wpn1_other', 'Checking the other thing.')).toEqual({ kind: 'queued' });
  const pulled = (await w.host.pull()).delivery!;
  expect(await handoff('reply:imsg-other', 'wrc_other', 'The other answer.')).toEqual({ kind: 'busy' });
  await w.host.postResult(pulled, await w.host.execute(pulled));
  expect(await handoff('progress:imsg-third:1', 'wpn1_third')).toMatchObject({ kind: 'terminal', result: { reason: 'progress_yields' } });
  expect(await handoff('reply:imsg-other', 'wrc_other', 'The other answer.')).toEqual({ kind: 'queued' });
  await sendNext(w);
  expect(sentTexts(w)).toEqual(['Scripted owner reply.', 'Checking the other thing.', 'The other answer.']);
}, 20_000);

it('a note that passed the slot check is still refused if a reply started waiting while it was being prepared', async () => {
  const w = await world();
  await w.pairAndActivate();
  await replyFor(w, 'Morning');
  const [reply] = await outbox(w.ownerStub);
  await sendNext(w);
  const handoff = (replyRef: string, commandId: string, text: string) => w.bridgeStub().enqueueReply({ replyRef, commandId, text, ownerDoName: reply!.ownerDoName,
    revision: reply!.revision, bindingDigest: reply!.bindingDigest, ...(reply!.subject !== undefined ? { subject: reply!.subject } : {}) });
  // The note's preparation (its key) waits until the reply below has met the slot and the slot is free again.
  let release!: () => void, entered = false;
  const released = new Promise<void>(resolve => { release = resolve; });
  const bridge = IMessageBridgeDO.prototype as unknown as { key: (...args: unknown[]) => Promise<string | null> }, key = bridge.key;
  vi.spyOn(bridge, 'key').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    if (!entered) { entered = true; await released; }
    return key.apply(this, args);
  });
  const note = handoff('progress:imsg-late:1', 'wpn1_late', 'Checking a few places.');
  await waitFor(() => entered);
  expect(await handoff('reply:imsg-first', 'wrc_first', 'The first answer.')).toEqual({ kind: 'queued' });
  expect(await handoff('reply:imsg-second', 'wrc_second', 'The second answer.')).toEqual({ kind: 'busy' });
  await sendNext(w);
  release();
  expect(await note).toMatchObject({ kind: 'terminal', result: { state: 'rejected', disposition: 'not_started', reason: 'progress_yields' } });
  expect(await handoff('reply:imsg-second', 'wrc_second', 'The second answer.')).toEqual({ kind: 'queued' });
  await sendNext(w);
  expect(sentTexts(w)).toEqual(['Scripted owner reply.', 'The first answer.', 'The second answer.']);
}, 20_000);

it('a note whose handoff threw is settled as possibly sent, never retried, and the reply goes out as before', async () => {
  const w = await world();
  await w.pairAndActivate();
  await progressTiming(w.ownerStub, 1_200, 60_000);
  const enqueue = IMessageBridgeDO.prototype.enqueueReply, attempts: string[] = [];
  vi.spyOn(IMessageBridgeDO.prototype, 'enqueueReply').mockImplementation(function (this: IMessageBridgeDO, input) {
    attempts.push(input.replyRef);
    if (input.replyRef.startsWith('progress:')) throw new Error('bridge unavailable');
    return enqueue.call(this, input);
  });
  proof.hold = () => waitFor(() => attempts.some(ref => ref.startsWith('progress:')));
  await replyFor(w, 'Find me a dentist near work');
  await sendNext(w);
  await w.pump(2);
  expect(sentTexts(w)).toEqual(['Scripted owner reply.']);
  expect(attempts.filter(ref => ref.startsWith('progress:'))).toHaveLength(1);
  const [note, reply] = await outbox(w.ownerStub);
  expect(note).toMatchObject({ state: 'settled', result: { state: 'unknown', disposition: 'may_have_completed', reason: 'progress_handoff_uncertain' } });
  expect(reply).toMatchObject({ state: 'settled', result: { state: 'local_recorded' } });
}, 20_000);

// A Mac result reaches the owner where their proactive work goes: on iMessage for an owner whose only surface it is, and in
// the app with one iMessage copy for an owner who chose both. The device directory answers for the owner's paired Mac.
const MAC_OWNER = '10000000-0000-4000-8000-000000000001';
const MAC_REPORT = 'Mac request request_imsg: completed (exit code 0).\nFixture result summary.';
const macResultFor = async (w: Awaited<ReturnType<typeof world>>) => {
  const directory = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/rpc/device_for_auth_v030')) return Response.json([{ owner_id: MAC_OWNER, do_name: w.ownerName, contract_version: '0.3.0', pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', capabilities: 'shell_exec' }]);
    return directory(input, init);
  });
  return runInDurableObject(w.ownerStub, async (instance) => (instance as unknown as { admitMacDelivery(value: unknown): Promise<boolean> }).admitMacDelivery({
    kind: 'result', request_id: 'request_imsg', device_id: 'device_imsg', owner_id: MAC_OWNER, payload: { status: 'completed', exit_code: 0, output_tail: 'fixture output', truncated: false } }));
};
const macRows = (w: Awaited<ReturnType<typeof world>>) => runInDurableObject(w.ownerStub, async (_i, state) =>
  state.storage.sql.exec<{ state: string }>('SELECT state FROM mac_result_inbox').toArray().map(row => row.state));
const macPasses = async (w: Awaited<ReturnType<typeof world>>) => {
  proof.reply = 'Fixture result summary.';
  try {
    for (let i = 0; i < 3; i++) {
      await runInDurableObject(w.ownerStub, async (_i, state) => { state.storage.kv.put('owner_alarm_last_v1', 0); });
      await runDurableObjectAlarm(w.ownerStub); await w.settle();
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  } finally { proof.reply = 'Scripted owner reply.'; }
  await w.pump();
};

it('an iMessage-only owner gets a Mac result on iMessage', async () => {
  const w = await world();
  await iMessageOnly(w);
  expect(await macResultFor(w)).toBe(true);
  await macPasses(w);
  expect(await macRows(w)).toEqual(['finished']);
  const { delivery } = await w.host.pull();
  expect(delivery, 'the report reached the bridge').not.toBeNull();
  expect(JSON.parse(delivery!.body)).toMatchObject({ operation: 'send', text: MAC_REPORT, binding: { subject: SUBJECT, chatGuid: CHAT } });
  expect(forbiddenEgress).toEqual([]);
}, 20_000);

it('an owner who chose the app and iMessage gets a Mac result in the app and one iMessage copy of it', async () => {
  const w = await world();
  await w.pairAndActivate();
  await answered(w, 'Morning');
  const directory = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/rpc/owner_runtime_authority')) return Response.json({ owner_id: MAC_OWNER, auth_user_id: MAC_OWNER, do_name: w.ownerName, state_version: 1, admission_revision: '5' });
    if (url.endsWith('/rpc/health_log_recent')) return Response.json([]);
    return directory(input, init);
  });
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    state.storage.kv.put('app_subject', String(appSubjectFor(w.ownerName)));
    state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true);
    state.storage.kv.put(PROACTIVE_SURFACE_KEY, 'app_imessage');
    state.storage.sql.exec('DELETE FROM schedule');
  });
  expect(await macResultFor(w)).toBe(true);
  await macPasses(w);
  expect(await macRows(w)).toEqual(['finished']);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    expect(deliveryRecords(state).filter(row => row.id.startsWith('device-')).map(row => [row.status, row.payload.text])).toEqual([['delivered', MAC_REPORT]]);
    expect(copies(state).map(row => row.replyRef)).toEqual([expect.stringMatching(/^proactive:imessage-copy:device-/)]);
  });
  const { delivery } = await w.host.pull();
  expect(delivery, 'the copy reached the bridge').not.toBeNull();
  expect(JSON.parse(delivery!.body)).toMatchObject({ operation: 'send', text: MAC_REPORT, binding: { subject: SUBJECT, chatGuid: CHAT } });
  expect(forbiddenEgress).toEqual([]);
}, 20_000);
