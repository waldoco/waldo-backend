import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { iMessageBridgeName } from '../src/channels/imessage/bridge-do';
import { sha256Hex } from '../src/channels/imessage/crypto';
import { IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

// Scripted model: every non-structured responses.create call is one owner turn.
const proof = vi.hoisted(() => ({ turns: [] as string[], reply: 'Scripted owner reply.', hold: null as null | (() => Promise<void>) }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) { proof.turns.push(JSON.stringify(input.input ?? '')); if (proof.hold) { const h = proof.hold; proof.hold = null; await h(); } }
  return { id: 'scripted', output: [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.reply, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
const forbiddenEgress: string[] = [];

afterEach(() => { vi.restoreAllMocks(); proof.turns = []; proof.hold = null; });

async function world(ownerName = `imsg-owner-${crypto.randomUUID()}`, ownerId = '10000000-0000-4000-8000-000000000001') {
  const owners: FixtureOwner[] = [{ do_name: ownerName, owner_id: ownerId, state: 'active', state_version: 1, admission_revision: 1 }];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners, extra: (fn) => {
    if (fn === 'console_session_touch') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane') return Response.json(null);
    return null;
  } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    const url = String(input instanceof Request ? input.url : input);
    forbiddenEgress.push(url);
    throw new Error(`forbidden egress ${new URL(url).origin}`);
  });
  const ownerStub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(ownerName));
  let session = '', csrf = '';
  await runInDurableObject(ownerStub, async (_i, state) => {
    state.storage.kv.put('do_name', ownerName);
    session = await consoleAccess(state.storage).grant();
    csrf = (await consoleAccess(state.storage).session(session))!.csrf;
  });
  const cookie = `waldo_console=${session}; waldo_owner=${ownerName}.session_fixture.${await routerSignature(SECRET, 0, `cookie.${ownerName}.session_fixture`)}`;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = (request: Request) => worker.fetch(request, env, ctx);
  const action = (name: string, fields: Record<string, string> = {}, token = csrf) => {
    const form = new FormData(); form.set('action', name); form.set('csrf', token);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return call(new Request('https://imessage.fixture.invalid/console/action', { method: 'POST', body: form, headers: { cookie }, redirect: 'manual' }));
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
  return { fx, ownerName, ownerStub, action, host, bridgeStub, call, pump, settle, pairAndActivate, csrf };
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
    expect(rows[0]).toMatchObject({ state: 'settled', text: proof.reply, result: { state: 'local_recorded' } });
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
