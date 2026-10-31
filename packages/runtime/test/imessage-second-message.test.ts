// Characterises what happens today when the owner sends a second iMessage while the first one's turn is still running,
// through the signed bridge, the owner DO and a scripted model. These tests pin current behaviour, not the target design
// (docs/proposals/WALDO_SECOND_MESSAGE_DESIGN_2026-10-31.md).
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { iMessageBridgeName } from '../src/channels/imessage/bridge-do';
import { IMESSAGE_BUSY_RETRY_MS, IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

// before: work run at the start of the next owner model calls, in order. Each owner reply names the turn it answers.
const proof = vi.hoisted(() => ({ turns: [] as string[], before: [] as (() => Promise<unknown>)[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) { await proof.before.shift()?.(); proof.turns.push(JSON.stringify(input.input ?? '')); }
  if (format === 'progress_note') return { id: 'scripted', output: [], output_text: JSON.stringify({ note: null }), usage: { input_tokens: 1, output_tokens: 1 } };
  const reply = `Reply to turn ${proof.turns.length}.`;
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
  const inbox = () => runInDurableObject(ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).records().map(record => record.state));
  return { host, pump, handOver, activate, inbox, threaded };
}

it('queues B behind a running A: no steer reaches A, A is not interrupted, and each message gets its own reply, A first', async () => {
  const w = await world();
  await w.activate();
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

  // Two separate turns: A's model input never saw B, and B ran as its own turn after A.
  expect(proof.turns).toHaveLength(2);
  expect(proof.turns[0]).not.toContain('raining in Pune');
  expect(proof.turns[1]).toContain('raining in Pune');
  expect(proof.turns[1]).toContain('Reply to turn 1.');

  // Both replies reach the host, in order: B's waits while A's is with the bridge, then goes on the outbox's busy retry.
  const sent: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { delivery } = await w.host.pull();
    const result = await w.host.execute(delivery!);
    expect((await w.host.postResult(delivery!, result)).status).toBe(200);
    sent.push(delivery!.body);
    await new Promise(resolve => setTimeout(resolve, IMESSAGE_BUSY_RETRY_MS + 100));
    await w.pump(2);
  }
  expect(sent[0]).toContain('Reply to turn 1.');
  expect(sent[1]).toContain('Reply to turn 2.');
  // B came in before A was answered, so A's reply is frozen to thread onto A's message; B's, to the latest message, is plain.
  expect(await w.threaded()).toEqual([true, false]);
}, 30_000);
