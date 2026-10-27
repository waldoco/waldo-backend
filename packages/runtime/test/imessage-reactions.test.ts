// iMessage tapbacks, both ways, through the signed bridge, the owner DO and a scripted model. Inbound, the owner's tapback
// on a message Waldo sent them is one line their next turn reads: it starts no turn and never reaches an approval.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { buildTextReply, iMessageBridgeName, type OwnerIMessagePort } from '../src/channels/imessage/bridge-do';
import { IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { HEALTH_SPAN_MARKER } from '../src/scribe/sanitiser';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost, type Delivery } from './helpers/imessage-sim-host';

// tools: each owner model call's tool names. before: work run at the start of the next owner model calls, in order.
const proof = vi.hoisted(() => ({ turns: [] as string[], tools: [] as string[][], reply: 'Scripted owner reply.', outputs: [] as any[][], before: [] as (() => Promise<unknown>)[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) { await proof.before.shift()?.(); proof.turns.push(JSON.stringify(input.input ?? '')); proof.tools.push((input.tools ?? []).map((tool: { name?: string }) => tool.name ?? '')); }
  if (format === 'progress_note') return { id: 'scripted', output: [], output_text: JSON.stringify({ note: null }), usage: { input_tokens: 1, output_tokens: 1 } };
  return { id: 'scripted', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.reply, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/connectors/google', async load => ({ ...await load<typeof import('../src/connectors/google')>(), googleClient: () => ({
  event: async (id: string) => ({ id, etag: 'etag-3pm', title: 'Design review', status: 'confirmed', start: '2030-01-02T15:00:00Z', end: '2030-01-02T16:00:00Z' }),
}) }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
const LOVED = '[Owner reacted ❤️ to your message: "Scripted owner reply."]';

afterEach(() => { vi.restoreAllMocks(); proof.turns = []; proof.tools = []; proof.outputs = []; proof.before = []; });

async function world() {
  const ownerName = `imsg-reactions-${crypto.randomUUID()}`;
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
  const activate = async () => {
    const code = (await (await action('imessage.pair')).text()).split('\n')[0]!;
    expect((await host.redeem(code)).status).toBe(200);
    const challenge = (await (await action('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
    expect((await host.send(host.message(challenge))).status).toBe(200);
    expect((await action('imessage.activate', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
    expect((await host.heartbeat()).status).toBe(200);
    expect((await host.capabilities()).status).toBe(200);
  };
  // The owner writes, Waldo's reply reaches the host and the host reports it sent: the reply's message guid.
  const exchange = async (text: string): Promise<string> => {
    expect((await host.send(host.message(text))).status).toBe(200);
    await pump();
    const { delivery } = await host.pull();
    const result = await host.execute(delivery!);
    expect((await host.postResult(delivery!, result)).status).toBe(200);
    await pump(2);
    if (result.state !== 'local_recorded') throw new Error(`reply not sent: ${result.state}`);
    return result.messageGuid;
  };
  const react = async (event: unknown) => { expect((await host.send(event)).status).toBe(200); await pump(); };
  // How the bridge settled each tapback it was handed, in order.
  const settled = () => runInDurableObject(bridgeStub(), async (_i, state) =>
    state.storage.sql.exec<{ reason: string }>("SELECT reason FROM events WHERE kind = 'reaction' ORDER BY seq").toArray().map(row => row.reason));
  return { ownerStub, bridgeStub, host, pump, activate, exchange, react, settled, action };
}

// The owner's message the model read last, as the model saw it.
const ownerInput = (turn: string): string => {
  const items = JSON.parse(turn) as { role?: string; content?: unknown }[];
  const content = items.filter(item => item.role === 'user').at(-1)?.content;
  return typeof content === 'string' ? content : (content as { text?: string }[]).map(part => part.text ?? '').join('');
};
const count = (text: string, line: string) => text.split(line).length - 1;

it('the owner\'s tapback on Waldo\'s reply starts no turn; their next turn reads it as one line, and only that turn', async () => {
  const w = await world();
  await w.activate();
  const sent = await w.exchange('What should I focus on today?');
  expect(proof.turns).toHaveLength(1);
  await w.react(w.host.reaction(sent, 'love'));
  expect(proof.turns).toHaveLength(1);
  expect(await w.settled()).toEqual(['reaction_noted']);
  await w.exchange('Thanks, and after that?');
  expect(proof.turns).toHaveLength(2);
  const said = ownerInput(proof.turns[1]!);
  expect(count(said, LOVED)).toBe(1);
  expect(said).toContain('Thanks, and after that?');
  await w.exchange('Got it.');
  expect(ownerInput(proof.turns[2]!)).not.toContain('Owner reacted');
});

it('a tapback the owner takes back leaves no line', async () => {
  const w = await world();
  await w.activate();
  const sent = await w.exchange('Plan my morning.');
  await w.react(w.host.reaction(sent, 'love'));
  await w.react(w.host.reaction(sent, 'love', { action: 'remove' }));
  await w.exchange('Okay.');
  expect(proof.turns).toHaveLength(2);
  expect(ownerInput(proof.turns[1]!)).not.toContain('Owner reacted');
});

it('only the owner, in their bound chat, on a message Waldo sent them, leaves a line', async () => {
  const w = await world();
  await w.activate();
  const sent = await w.exchange('What is next?');
  const ownMessage = w.host.message('a message of the owner\'s own').messageGuid;
  await w.react(w.host.reaction(sent, 'like', { senderHandle: 'stranger@example.invalid', chatGuid: CHAT }));
  await w.react(w.host.reaction(sent, 'like', { chatGuid: 'iMessage;-;other@example.invalid' }));
  await w.react(w.host.reaction(sent, 'like', { isFromMe: true }));
  await w.react(w.host.reaction(ownMessage, 'like'));
  expect(proof.turns).toHaveLength(1);
  expect(await w.settled()).toEqual(['reaction_ignored', 'reaction_ignored', 'reaction_ignored', 'reaction_untracked']);
  await w.exchange('Thanks.');
  expect(ownerInput(proof.turns[1]!)).not.toContain('Owner reacted');
});

// The card turn's reply waits on the bridge's one mailbox slot, which the card holds until the host pulls it (up to 4 s).
it('a tapback on the message that carries a pending card changes no approval, card or ledger row', async () => {
  const w = await world();
  await w.activate();
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    await state.storage.put('origin', HOST_ORIGIN);
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
  });
  proof.outputs.push([{ type: 'function_call', call_id: 'move-3pm', name: 'propose_calendar_change', arguments: JSON.stringify({ action: 'move', event_id: 'ev-3pm', title: 'Design review', start: '2030-01-02T16:00:00Z', end: '2030-01-02T17:00:00Z', reason: 'Owner asked to move it to 4' }) }], []);
  const card = await w.exchange('Move my 3pm to 4');
  const desk = () => runInDurableObject(w.ownerStub, async (_i, state) => ({
    ledger: state.storage.sql.exec('SELECT * FROM ledger ORDER BY id').toArray(),
    presentations: state.storage.sql.exec('SELECT * FROM approval_presentations ORDER BY approval_id, surface, message_ref').toArray(),
  }));
  const before = await desk();
  expect(before.ledger).toHaveLength(1);
  expect(before.ledger[0]).toMatchObject({ kind: 'calendar_change', decided_at: null });
  expect(['open', 'review_only', 'card_unconfirmed']).toContain(before.ledger[0]!.status);
  const modelCalls = proof.turns.length;
  for (const type of ['like', 'love', 'emphasis', 'dislike', 'question', 'laugh']) await w.react(w.host.reaction(card, type));
  expect(proof.turns).toHaveLength(modelCalls);
  expect(await w.settled()).toEqual(Array(6).fill('reaction_noted'));
  expect(await desk()).toEqual(before);
  await w.exchange('ok');
  expect(ownerInput(proof.turns.at(-1)!)).toContain('Owner reacted 👍 to your message');
  expect(await desk()).toEqual(before);
}, 20_000);

// Outbound: the model's tapback on the owner's message, offered and sent only where the bridge's host verified tapbacks.
const TAPBACKS = { receive: true, send: true, exactTarget: true, verified: true };
const tapback = (reaction: string) => [{ type: 'function_call', call_id: `tapback-${reaction}`, name: 'react_to_message', arguments: JSON.stringify({ reaction }) }];
// What the tool told the model: each function call's result data, from the next model call's input.
const toolOutput = (turn: string) => (JSON.parse(turn) as { type?: string; output?: string }[]).filter(item => item.type === 'function_call_output').map(item => (JSON.parse(item.output!) as { data?: unknown }).data);
const outbox = (w: Awaited<ReturnType<typeof world>>) => runInDurableObject(w.ownerStub, async (_i, state) => new IMessageFinalOutbox(state.storage).records());

it('react_to_message is offered on an iMessage turn only while the host reports tapbacks sent, verified and exact', async () => {
  const w = await world();
  await w.activate();
  const offered = async (flag: Parameters<SimulatedHost['capabilities']>[1]) => {
    expect((await w.host.capabilities(true, flag)).status).toBe(200);
    await w.exchange('Hi');
    return proof.tools.at(-1)!.includes('react_to_message');
  };
  expect(await offered(false)).toBe(false);
  expect(await offered({ ...TAPBACKS, verified: false })).toBe(false);
  expect(await offered({ ...TAPBACKS, exactTarget: false })).toBe(false);
  expect(await offered({ ...TAPBACKS, send: false })).toBe(false);
  expect(await offered(TAPBACKS)).toBe(true);
  expect(proof.tools.at(-1)!.includes('send_message')).toBe(true);
  // The console's row says so too, from the same reading.
  expect(await w.bridgeStub().status()).toMatchObject({ textReady: true, tapbacksReady: true });
  expect((await w.host.capabilities(true, { ...TAPBACKS, verified: false })).status).toBe(200);
  expect(await w.bridgeStub().status()).toMatchObject({ textReady: true, tapbacksReady: false });
});

it('a tapback the model sends goes out once, on the owner\'s own message, through the outbox after the reply', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, TAPBACKS)).status).toBe(200);
  proof.outputs.push(tapback('love'), []);
  const asked = w.host.message('Booked the dentist for Friday!');
  expect((await w.host.send(asked)).status).toBe(200);
  await w.pump();
  expect(toolOutput(proof.turns[1]!)).toEqual([{ queued: true }]);
  // The reply never waits on a tapback: it takes the mailbox's one slot first.
  const reply = (await w.host.pull()).delivery!;
  expect(JSON.parse(reply.body)).toMatchObject({ operation: 'send', text: proof.reply });
  expect((await w.host.postResult(reply, await w.host.execute(reply))).status).toBe(200);
  let delivery: Delivery | null = null;
  await vi.waitFor(async () => { await w.pump(1); delivery = (await w.host.pull()).delivery; expect(delivery).not.toBeNull(); }, { timeout: 10_000, interval: 250 });
  const command = JSON.parse(delivery!.body);
  expect(command).toMatchObject({ operation: 'react', action: 'add', reaction: { kind: 'standard', type: 'love' }, allowSMSFallback: false,
    target: { chatGuid: CHAT, messageGuid: asked.messageGuid, partIndex: 0 }, binding: { subject: SUBJECT, chatGuid: CHAT } });
  // The same frozen intent handed to the bridge again is the same command, never a second one.
  const frozen = (await outbox(w)).find(row => row.replyRef.startsWith('react:'))!;
  expect(frozen).toMatchObject({ state: 'queued', commandId: command.commandId });
  expect(await w.bridgeStub().enqueueReply({ replyRef: frozen.replyRef, commandId: frozen.commandId, text: '', ownerDoName: frozen.ownerDoName, revision: frozen.revision,
    bindingDigest: frozen.bindingDigest, subject: SUBJECT, reaction: frozen.reaction! })).toEqual({ kind: 'queued' });
  expect((await w.host.postResult(delivery!, await w.host.execute(delivery!))).status).toBe(200);
  await w.pump(2);
  expect((await w.host.pull()).delivery).toBeNull();
  expect(w.host.nativeSends.map(sent => sent.text)).toEqual([proof.reply]);
  expect(w.host.nativeReactions).toEqual([{ commandId: command.commandId, messageGuid: asked.messageGuid, partIndex: 0, type: 'love', action: 'add' }]);
  expect((await outbox(w)).find(row => row.replyRef === frozen.replyRef)).toMatchObject({ state: 'settled', result: { state: 'local_recorded' } });
}, 30_000);

it('a capability gone stale before the call fails closed: nothing is frozen and the model hears why', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, TAPBACKS)).status).toBe(200);
  proof.outputs.push(tapback('like'), []);
  // Offered when the turn began; the host withdraws verification before the model's call runs.
  proof.before.push(async () => expect((await w.host.capabilities(true, { ...TAPBACKS, verified: false })).status).toBe(200));
  await w.exchange('Running late.');
  expect(proof.tools[0]).toContain('react_to_message');
  expect(toolOutput(proof.turns[1]!)).toEqual([{ queued: false, reason: 'unavailable' }]);
  expect((await outbox(w)).some(row => row.replyRef.startsWith('react:'))).toBe(false);
  expect(w.host.nativeReactions).toEqual([]);
});

it('the bridge refuses a frozen tapback once its host no longer verifies them: proved not started, never sent', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, TAPBACKS)).status).toBe(200);
  proof.outputs.push(tapback('like'), []);
  // The tapback froze on the first model call; verification is gone before the turn's outbox drains.
  proof.before.push(async () => undefined, async () => expect((await w.host.capabilities(true, { ...TAPBACKS, verified: false })).status).toBe(200));
  await w.exchange('Can you check the train?');
  expect(toolOutput(proof.turns[1]!)).toEqual([{ queued: true }]);
  // The tapback goes to the bridge once the reply has left the mailbox's one slot.
  await vi.waitFor(async () => {
    await w.pump(1);
    expect((await outbox(w)).find(row => row.replyRef.startsWith('react:'))).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'tapbacks_unverified' } });
  }, { timeout: 10_000, interval: 250 });
  expect((await w.host.pull()).delivery).toBeNull();
  expect(w.host.nativeReactions).toEqual([]);
}, 30_000);

it('the bridge refuses a tapback on a message outside the bound chat', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, TAPBACKS)).status).toBe(200);
  await w.exchange('Hello');
  const record = await runInDurableObject(w.ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).records()[0]!);
  const handoff = { replyRef: `react:${record.id}`, commandId: `wrx_love_${record.commandId}`, text: '', ownerDoName: record.ownerDoName, revision: record.revision, bindingDigest: record.bindingDigest, subject: SUBJECT };
  expect(await w.bridgeStub().enqueueReply({ ...handoff, reaction: { chatGuid: 'iMessage;-;other@example.invalid', messageGuid: 'sim-guid-elsewhere', partIndex: 0, type: 'love' } }))
    .toMatchObject({ kind: 'terminal', result: { state: 'rejected', disposition: 'not_started', reason: 'target_not_in_chat' } });
  expect((await w.host.pull()).delivery).toBeNull();
});

// The owner inbox's tapback lines by themselves: the newest eight wait, the next turn on their chat takes them once, and a
// line noted under an earlier binding of that chat is dropped unread.
it('tapback lines are bounded, taken once by their chat\'s next turn, and never read under another binding', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`imsg-notes-${crypto.randomUUID()}`)), async (_i, state) => {
    const inbox = new IMessageOwnerInbox(state.storage);
    const chat = JSON.stringify(['imessage', 'b', 'a', CHAT]), other = JSON.stringify(['imessage', 'b', 'a', 'iMessage;-;other@example.invalid']);
    for (let n = 0; n < 10; n++) inbox.noteReaction({ key: `k${n}`, conversationRef: chat, bindingDigest: n < 9 ? 'earlier' : 'now', line: `line ${n}` }, 'add');
    inbox.noteReaction({ key: 'elsewhere', conversationRef: other, bindingDigest: 'now', line: 'other chat' }, 'add');
    inbox.noteReaction({ key: 'k9', conversationRef: chat, bindingDigest: 'now', line: 'line 9' }, 'remove');
    inbox.noteReaction({ key: 'latest', conversationRef: chat, bindingDigest: 'now', line: 'line now' }, 'add');
    expect(inbox.notes().map(note => note.line)).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'other chat', 'line now']);
    const admitted = await inbox.admit({ dedupKey: 'd1', digest: 'x', text: 'hi', conversationRef: chat, bindingDigest: 'now', revision: 'r', environment: 'test', bridgeDoName: 'bridge', ownerDoName: 'owner',
      binding: { ownerId: 'o', presenceId: 'p', subject: SUBJECT, bridgeId: 'b', accountId: 'a', chatGuid: CHAT, verified: true, conversationKind: 'direct', service: 'iMessage' }, commandId: 'wrc_1', occurredAt: Date.now() });
    if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
    expect(inbox.claim(admitted.record.id, true)?.reactions).toEqual(['line now']);
    expect(inbox.notes().map(note => note.line)).toEqual(['other chat']);
  });
});

// The owner DO takes a tapback only under the binding's current authority: a stale revision or a revoked bridge stores nothing.
it('the owner DO refuses a tapback under a stale or revoked authority and keeps no line', async () => {
  const w = await world();
  await w.activate();
  await w.exchange('Hello');
  const record = await runInDurableObject(w.ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).records()[0]!);
  const notes = () => runInDurableObject(w.ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).notes().map(note => note.line));
  const port = w.ownerStub as unknown as OwnerIMessagePort;
  const note = (revision: string, action: 'add' | 'remove' = 'add') => port.noteIMessageReaction({ binding: record.binding, revision, environment: record.environment, bridgeDoName: record.bridgeDoName,
    ownerDoName: record.ownerDoName, action, type: 'love', target: { messageGuid: 'sim-sent-x', partIndex: 0 }, quoted: 'Scripted owner reply.' });
  expect(await note(`${record.revision}.stale`)).toBe('refused');
  expect(await notes()).toEqual([]);
  // The same tapback under the current revision is kept, which is what the refusals above are measured against.
  expect(await note(record.revision)).toBe('noted');
  expect(await notes()).toEqual([LOVED]);
  expect(await note(record.revision, 'remove')).toBe('noted');
  expect((await w.action('imessage.revoke', { id: w.host.bridgeId })).status).toBe(303);
  expect(await note(record.revision)).toBe('refused');
  expect(await notes()).toEqual([]);
});

// A reading in Waldo's earlier message never reaches the owner DO's storage through the quote, whole or cut by the 80-character limit.
it('a tapback on a message that carried a health reading stores the quote with the reading withheld', async () => {
  const w = await world();
  await w.activate();
  await w.exchange('Hello');
  const record = await runInDurableObject(w.ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).records()[0]!);
  const notes = () => runInDurableObject(w.ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).notes().map(note => note.line));
  const port = w.ownerStub as unknown as OwnerIMessagePort;
  expect(await port.noteIMessageReaction({ binding: record.binding, revision: record.revision, environment: record.environment, bridgeDoName: record.bridgeDoName,
    ownerDoName: record.ownerDoName, action: 'add', type: 'love', target: { messageGuid: 'sim-sent-reading', partIndex: 0 }, quoted: 'Your HRV was 52 ms last night.' })).toBe('noted');
  const [line] = await notes();
  expect(line).toContain('Owner reacted');
  expect(line).not.toMatch(/52/);
  expect(line).toContain(HEALTH_SPAN_MARKER);
});

it('a reading the 80-character quote limit would cut in half is withheld before the cut', async () => {
  const w = await world();
  await w.activate();
  await w.exchange('Hello');
  const record = await runInDurableObject(w.ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).records()[0]!);
  const text = `${'a '.repeat(30)}ab Your HRV was 52 ms last night, a little lower than usual.`;
  expect([...text].slice(0, 80).join('')).toMatch(/52 m$/);
  await runInDurableObject(w.bridgeStub(), async (_i, state) => {
    const commandId = 'seeded-reading', command = buildTextReply(record.binding, commandId, text);
    const result = { version: 1, commandId, target: command.target, state: 'local_recorded', messageGuid: 'sent-with-reading', evidence: { kind: 'local_database', reference: 'seeded' } };
    state.storage.sql.exec("INSERT INTO deliveries(delivery_id,command_id,command_digest,body,headers,commitment,state,attempt,result,created_at,owner_do,reply_ref,reported) VALUES(?,?,?,?,?,?,'resulted',1,?,?,?,?,1)",
      'delivery-reading', commandId, 'seeded-digest', JSON.stringify(command), '{}', '{}', JSON.stringify(result), Date.now(), record.ownerDoName, 'reply:seeded-reading');
    state.storage.sql.exec("INSERT INTO sent_messages(message_guid,command_id,state) VALUES(?,?,'local_recorded')", 'sent-with-reading', commandId);
  });
  await w.react(w.host.reaction('sent-with-reading', 'love'));
  expect(await w.settled()).toEqual(['reaction_noted']);
  const lines = await runInDurableObject(w.ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).notes().map(note => note.line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toMatch(/52|5 ?m|HRV was 5/);
  expect(lines[0]).toContain(HEALTH_SPAN_MARKER.slice(0, 7));
});

// The bridge quotes only a message Waldo sent this owner, in this chat. Each check holds alone: a send recorded for another
// owner in this chat, and one recorded for this owner in another chat, are both untracked and leave no line.
it('a tapback on a send recorded for another owner, or for another chat, is untracked and quotes nothing', async () => {
  const w = await world();
  await w.activate();
  await w.exchange('Hello');
  const record = await runInDurableObject(w.ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).records()[0]!);
  const seed = (guid: string, ownerDoName: string, chatGuid: string) => runInDurableObject(w.bridgeStub(), async (_i, state) => {
    const commandId = `seeded-${guid}`, command = buildTextReply({ ...record.binding, chatGuid }, commandId, 'A message that went elsewhere.');
    const result = { version: 1, commandId, target: command.target, state: 'local_recorded', messageGuid: guid, evidence: { kind: 'local_database', reference: 'seeded' } };
    state.storage.sql.exec("INSERT INTO deliveries(delivery_id,command_id,command_digest,body,headers,commitment,state,attempt,result,created_at,owner_do,reply_ref,reported) VALUES(?,?,?,?,?,?,'resulted',1,?,?,?,?,1)",
      `delivery-${guid}`, commandId, 'seeded-digest', JSON.stringify(command), '{}', '{}', JSON.stringify(result), Date.now(), ownerDoName, `reply:seeded-${guid}`);
    state.storage.sql.exec("INSERT INTO sent_messages(message_guid,command_id,state) VALUES(?,?,'local_recorded')", guid, commandId);
  });
  await seed('sent-to-another-owner', 'imsg-another-owner', CHAT);
  await seed('sent-to-another-chat', record.ownerDoName, 'iMessage;-;alias@example.invalid');
  await w.react(w.host.reaction('sent-to-another-owner', 'love'));
  await w.react(w.host.reaction('sent-to-another-chat', 'love'));
  expect(await w.settled()).toEqual(['reaction_untracked', 'reaction_untracked']);
  await w.exchange('Anything else?');
  expect(ownerInput(proof.turns.at(-1)!)).not.toContain('Owner reacted');
});
