// Characterises what happens today when the owner sends a second iMessage while the first one's turn is still running,
// through the signed bridge, the owner DO and a scripted model. These tests pin current behaviour, not the target design
// (docs/proposals/WALDO_SECOND_MESSAGE_DESIGN_2026-10-31.md).
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { iMessageBridgeName } from '../src/channels/imessage/bridge-do';
import { IMESSAGE_BUSY_RETRY_MS, IMESSAGE_OUTBOX_DUE_KEY, IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import type { IMessageResult } from '@waldo/contracts';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

// before: work run at the start of the next owner reply calls, in order. An owner reply call carries the tool menu and one of
// the owner's two messages; the owner object's other model calls (its boot day plan, memory) run on their own timing and must
// neither count nor take a hold. Each owner reply names the turn it answers.
const proof = vi.hoisted(() => ({ turns: [] as string[], before: [] as (() => Promise<unknown>)[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name, said = JSON.stringify(input.input ?? '');
  const owner = !format && Array.isArray(input.tools) && input.tools.length > 0 && ['flights to Goa', 'raining in Pune'].some(words => said.includes(words));
  if (owner) { await proof.before.shift()?.(); proof.turns.push(said); }
  if (format === 'progress_note') return { id: 'scripted', output: [], output_text: JSON.stringify({ note: null }), usage: { input_tokens: 1, output_tokens: 1 } };
  const reply = owner ? `Reply to turn ${proof.turns.length}.` : 'Scripted.';
  return { id: 'scripted', output: [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : reply, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;

afterEach(() => { vi.restoreAllMocks(); proof.turns = []; proof.before = []; });

async function world() {
  const ownerName = `imsg-second-${crypto.randomUUID()}`;
  const owners: FixtureOwner[] = [{ do_name: ownerName, owner_id: '10000000-0000-4000-8000-000000000001', state: 'active', state_version: 1, admission_revision: 1 }];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners, extra: (fn) => {
    if (fn === 'console_session_touch' || fn === 'console_session_open' || fn === 'console_session_open_for') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane' || fn === 'admin_overview') return Response.json(null);
    return null;
  } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    throw new Error(`forbidden egress ${new URL(String(input instanceof Request ? input.url : input)).origin}`);
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
  const address = `2001:db8::${crypto.randomUUID().slice(0, 4)}`;
  const call = (request: Request) => {
    if (!request.headers.has('cf-connecting-ip')) request.headers.set('cf-connecting-ip', address);
    return worker.fetch(request, env, ctx);
  };
  const action = (name: string, fields: Record<string, string> = {}) => {
    const form = new FormData(); form.set('action', name); form.set('csrf', csrf);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return call(new Request(`${HOST_ORIGIN}/console/action`, { method: 'POST', body: form, headers: { cookie, origin: HOST_ORIGIN }, redirect: 'manual' }));
  };
  const host = new SimulatedHost(call, HOST_ORIGIN);
  const bridgeStub = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  const settle = async () => { while (pending.length) await pending.shift(); };
  const pump = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) { await runDurableObjectAlarm(bridgeStub()); await settle(); await runDurableObjectAlarm(ownerStub); await settle(); }
  };
  // Hands what the bridge holds to the owner DO without running the owner's alarm, which would wait on a held turn.
  const handOver = async () => { await runDurableObjectAlarm(bridgeStub()); await settle(); };
  const activate = async () => {
    const code = (await (await action('imessage.pair')).text()).split('\n')[0]!;
    expect((await host.redeem(code)).status).toBe(200);
    const challenge = (await (await action('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
    expect((await host.send(host.message(challenge))).status).toBe(200);
    expect((await action('imessage.activate', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
    expect((await host.heartbeat()).status).toBe(200);
    expect((await host.capabilities()).status).toBe(200);
  };
  const threaded = () => runInDurableObject(ownerStub, async (_i, state) => new IMessageFinalOutbox(state.storage).records().map(record => record.replyTo !== undefined));
  // Each record as kind:outcome, in the chat's order; a plain resend shares its reply's place and lists after it.
  const outcomes = () => runInDurableObject(ownerStub, async (_i, state) => new IMessageFinalOutbox(state.storage).records()
    .sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0) || Number(x.replyRef.startsWith('plain:')) - Number(y.replyRef.startsWith('plain:')))
    .map(record => `${record.replyRef.split(':')[0]}:${record.result?.state ?? record.state}`));
  const inbox = () => runInDurableObject(ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).records().map(record => record.state));
  // The owner object's armed alarm and the outbox's own wake, read without running either.
  const wakes = () => runInDurableObject(ownerStub, async (_i, state) => ({ alarm: await state.storage.getAlarm(), outbox: state.storage.kv.get<number | null>(IMESSAGE_OUTBOX_DUE_KEY) ?? null }));
  const ownerAlarm = async () => { await runDurableObjectAlarm(ownerStub); await settle(); };
  return { host, pump, handOver, activate, inbox, threaded, outcomes, wakes, ownerAlarm };
}

// The owner sends A, then B while A's turn is held on its first model call; A is released and both turns run.
async function twoInARow(w: Awaited<ReturnType<typeof world>>) {
  // The hold polls a flag rather than awaiting a promise the test resolves: workerd forbids settling another object's I/O.
  const gate = { held: false, open: false };
  proof.before.push(async () => { gate.held = true; while (!gate.open) await new Promise(resolve => setTimeout(resolve, 10)); });

  expect((await w.host.send(w.host.message('Find me three flights to Goa for Friday.'))).status).toBe(200);
  await w.handOver();
  await vi.waitFor(() => expect(gate.held).toBe(true), { timeout: 10_000, interval: 20 });

  expect((await w.host.send(w.host.message('Also, is it raining in Pune?'))).status).toBe(200);
  await w.handOver();
  await vi.waitFor(async () => expect(await w.inbox()).toEqual(['running', 'admitted']), { timeout: 10_000, interval: 20 });

  gate.open = true;
  await vi.waitFor(async () => expect((await w.inbox())[0]).toBe('completed'), { timeout: 10_000, interval: 20 });
  await w.pump();
  expect(await w.inbox()).toEqual(['completed', 'completed']);
}
// The host takes one delivery and answers it; the bridge's next delivery waits on the outbox's busy retry.
async function answer(w: Awaited<ReturnType<typeof world>>, result?: (command: { commandId: string; target: unknown }) => IMessageResult) {
  const { delivery } = await w.host.pull();
  const command = JSON.parse(delivery!.body) as { commandId: string; target: unknown };
  expect((await w.host.postResult(delivery!, result ? result(command) : await w.host.execute(delivery!))).status).toBe(200);
  await new Promise(resolve => setTimeout(resolve, IMESSAGE_BUSY_RETRY_MS + 100));
  await w.pump(2);
  return delivery!.body;
}

it('queues B behind a running A: no steer reaches A, A is not interrupted, and each message gets its own reply, A first', async () => {
  const w = await world();
  await w.activate();
  await twoInARow(w);

  // Two separate turns: A's model input never saw B, and B ran as its own turn after A.
  expect(proof.turns).toHaveLength(2);
  expect(proof.turns[0]).not.toContain('raining in Pune');
  expect(proof.turns[1]).toContain('raining in Pune');
  expect(proof.turns[1]).toContain('Reply to turn 1.');

  // Both replies reach the host, in order: B's waits while A's is with the bridge, then goes on the outbox's busy retry.
  const sent = [await answer(w), await answer(w)];
  expect(sent[0]).toContain('Reply to turn 1.');
  expect(sent[1]).toContain('Reply to turn 2.');
  // B came in before A was answered, so A's reply is frozen to thread onto A's message; B's, to the latest message, is plain.
  expect(await w.threaded()).toEqual([true, false]);
}, 30_000);

// Only in this case does A's reply thread onto A's message, so only here does a host that reports verified replies get a
// threaded send. A host that refuses it before sending anything (on Photon: the target message cannot be resolved) settles
// that send as not_started, and the outbox sends the same answer once more, plain, ahead of B's.
it('a host that refuses A\'s threaded reply before sending still gets A\'s answer, once, plain, and then B\'s', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, false, true)).status).toBe(200);
  await twoInARow(w);

  const threaded = await answer(w, command => ({ version: 1, commandId: command.commandId, target: command.target as IMessageResult['target'], state: 'rejected', disposition: 'not_started', reason: 'photon_target_unavailable' }));
  expect(threaded).toContain('Reply to turn 1.');
  expect((JSON.parse(threaded) as { target: { messageGuid?: string } }).target.messageGuid).toBeDefined();
  const plain = await answer(w);
  expect(plain).toContain('Reply to turn 1.');
  expect((JSON.parse(plain) as { target: { messageGuid?: string } }).target.messageGuid).toBeUndefined();
  expect(await answer(w)).toContain('Reply to turn 2.');

  expect((await w.host.pull()).delivery).toBeNull();
  expect(w.host.nativeSends.map(send => send.text)).toEqual(['Reply to turn 1.', 'Reply to turn 2.']);
  expect(await w.outcomes()).toEqual(['reply:rejected', 'plain:local_recorded', 'reply:local_recorded']);
}, 30_000);

// One message, written as an inline reply, so its answer is threaded, and nothing else is waiting: no second turn, no busy
// retry. The refusal's own report must wake the owner object for the plain resend, at the outbox's due time, not on the
// 30-minute heartbeat.
it('with no other wake, a refused threaded reply goes out plain on the wake its refusal armed', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, false, true)).status).toBe(200);
  expect((await w.host.send({ ...w.host.message('Find me three flights to Goa for Friday.'), replyToGuid: 'g-earlier-waldo-message' })).status).toBe(200);
  await w.pump();
  expect(await w.threaded()).toEqual([true]);

  const { delivery } = await w.host.pull();
  const command = JSON.parse(delivery!.body) as { commandId: string; target: IMessageResult['target'] };
  expect(command.target.messageGuid).toBeDefined();
  expect((await w.host.postResult(delivery!, { version: 1, commandId: command.commandId, target: command.target, state: 'rejected', disposition: 'not_started', reason: 'photon_target_unavailable' })).status).toBe(200);
  await w.handOver();
  await vi.waitFor(async () => expect(await w.outcomes()).toEqual(['reply:rejected', 'plain:frozen']), { timeout: 10_000, interval: 20 });

  const { alarm, outbox } = await w.wakes();
  // Armed at the outbox's due time, never before it (no busy loop): the arbiter floors the alarm at its own now + 250 ms, read
  // a moment after the outbox's, so it can land a millisecond later. Without the wake it sat on another lane's wake, minutes out.
  expect(outbox).not.toBeNull();
  expect(alarm! - outbox!).toBeGreaterThanOrEqual(0);
  expect(alarm! - outbox!).toBeLessThan(1_000);
  await w.ownerAlarm();
  const plain = (await w.host.pull()).delivery;
  expect(plain?.body).toContain('Reply to turn 1.');
  expect((JSON.parse(plain!.body) as { target: { messageGuid?: string } }).target.messageGuid).toBeUndefined();
}, 30_000);
