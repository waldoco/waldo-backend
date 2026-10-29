// iMessage replies to a specific message, through the signed bridge, the owner DO and a scripted model. Inbound, the owner's
// reply to a message Waldo sent them in their bound chat is one host-note line their turn reads; anything else adds nothing.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { buildTextReply, iMessageBridgeName, type IMessageTurnHandoff } from '../src/channels/imessage/bridge-do';
import { IMESSAGE_BUSY_RETRY_MS, IMessageFinalOutbox, targetOf } from '../src/channels/imessage/final-outbox';
import { IMessageOwnerInbox, type IMessageInboxRecord } from '../src/channels/imessage/owner-inbox';
import { iMessageTurnParts } from '../src/channels/imessage/owner-runtime';
import { redactIMessageEntries } from '../src/channels/imessage/forget';
import { receivedView, renderForModel } from '../src/channels/owner-inbound-turn';
import { OwnerDO } from '../src/channels/owner-do';
import { HEALTH_SPAN_MARKER } from '../src/scribe/sanitiser';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost, type Delivery } from './helpers/imessage-sim-host';

// before: work run at the start of the next owner model calls, in order.
const proof = vi.hoisted(() => ({ turns: [] as string[], reply: 'Scripted owner reply.', before: [] as (() => Promise<unknown>)[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) { await proof.before.shift()?.(); proof.turns.push(JSON.stringify(input.input ?? '')); }
  if (format === 'progress_note') return { id: 'scripted', output: [], output_text: JSON.stringify({ note: null }), usage: { input_tokens: 1, output_tokens: 1 } };
  return { id: 'scripted', output: [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.reply, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
const REPLYING = '[Replying to your message: "Scripted owner reply."]';

afterEach(() => { vi.restoreAllMocks(); proof.turns = []; proof.before = []; });

async function world() {
  const ownerName = `imsg-replies-${crypto.randomUUID()}`;
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
  // The owner writes (replying to `replyTo` when given), Waldo's reply reaches the host and the host reports it sent.
  const exchange = async (text: string, replyTo?: string): Promise<string> => {
    expect((await host.send({ ...host.message(text), ...(replyTo ? { replyToGuid: replyTo } : {}) })).status).toBe(200);
    await pump();
    const { delivery } = await host.pull();
    const result = await host.execute(delivery!);
    expect((await host.postResult(delivery!, result)).status).toBe(200);
    await pump(2);
    if (result.state !== 'local_recorded') throw new Error(`reply not sent: ${result.state}`);
    return result.messageGuid;
  };
  // A send recorded on the bridge as delivered: Waldo's message `guid`, to `ownerDoName` in `chatGuid`.
  const seed = (binding: IMessageTurnHandoff['binding'], guid: string, ownerDoName: string, chatGuid: string, text: string) => runInDurableObject(bridgeStub(), async (_i, state) => {
    const commandId = `seeded-${guid}`, command = buildTextReply({ ...binding, chatGuid }, commandId, text);
    const result = { version: 1, commandId, target: command.target, state: 'local_recorded', messageGuid: guid, evidence: { kind: 'local_database', reference: 'seeded' } };
    state.storage.sql.exec("INSERT INTO deliveries(delivery_id,command_id,command_digest,body,headers,commitment,state,attempt,result,created_at,owner_do,reply_ref,reported) VALUES(?,?,?,?,?,?,'resulted',1,?,?,?,?,1)",
      `delivery-${guid}`, commandId, 'seeded-digest', JSON.stringify(command), '{}', '{}', JSON.stringify(result), Date.now(), ownerDoName, `reply:seeded-${guid}`);
    state.storage.sql.exec("INSERT INTO sent_messages(message_guid,command_id,state) VALUES(?,?,'local_recorded')", guid, commandId);
  });
  const firstRecord = () => runInDurableObject(ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).records()[0]!);
  return { ownerStub, bridgeStub, host, pump, activate, exchange, seed, firstRecord };
}

// The owner's message the model read last, as the model saw it.
const ownerInput = (turn: string): string => {
  const items = JSON.parse(turn) as { role?: string; content?: unknown }[];
  const content = items.filter(item => item.role === 'user').at(-1)?.content;
  return typeof content === 'string' ? content : (content as { text?: string }[]).map(part => part.text ?? '').join('');
};
const count = (text: string, line: string) => text.split(line).length - 1;
// What the bridge handed the owner DO for each turn: the quote it found, if any.
const handoffs = () => {
  const seen: IMessageTurnHandoff[] = [];
  const admit = OwnerDO.prototype.admitIMessageTurn;
  vi.spyOn(OwnerDO.prototype, 'admitIMessageTurn').mockImplementation(async function (this: OwnerDO, input) { seen.push(input); return admit.call(this, input); });
  return seen;
};

it('the reply line sits beside the owner\'s words as a host note, never as their words, in the stored and the model view', () => {
  const turn = iMessageTurnParts({ updateId: 1, text: 'Move it?', replyNote: REPLYING }, null)!;
  expect(turn.parts).toEqual([{ authorship: 'owner', text: 'Move it?' }, { authorship: 'media_note', text: REPLYING }]);
  for (const view of [receivedView(turn.parts), renderForModel(turn.parts)]) {
    const at = view.text.indexOf(REPLYING);
    expect(view.foreignRanges).toHaveLength(1);
    const [{ start, end }] = view.foreignRanges as [{ start: number; end: number }];
    expect(end).toBe(at + REPLYING.length);
    expect(view.text.slice(start, at).trim()).toBe('');
    expect(view.text.slice(0, start).trim()).toBe('Move it?');
  }
  expect(iMessageTurnParts({ updateId: 1, text: 'Move it?' }, null)).toBeNull();
});

// The reply line held on a waiting turn: kept no longer than the turn's own text, and reached by a literal forget.
const waiting = async (state: DurableObjectState, id: string, replyNote: string) => {
  const inbox = new IMessageOwnerInbox(state.storage);
  const admitted = await inbox.admit({ dedupKey: id, digest: 'x', text: 'Move it?', conversationRef: 'c', bindingDigest: 'd', revision: 'r', environment: 'test', bridgeDoName: 'bridge',
    ownerDoName: 'owner', binding: { ownerId: 'o', presenceId: 'p', subject: SUBJECT, bridgeId: 'b', accountId: 'a', chatGuid: CHAT, verified: true, conversationKind: 'direct', service: 'iMessage' },
    commandId: `wrc_${id}`, occurredAt: Date.now(), replyNote });
  if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
  return admitted.record;
};
const inboxStub = () => env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`imsg-reply-note-${crypto.randomUUID()}`));

it('a turn that closes keeps no reply line, as it keeps no text: completed, interrupted, or revoked before it ran', async () => {
  await runInDurableObject(inboxStub(), async (_i, state) => {
    const inbox = new IMessageOwnerInbox(state.storage);
    const completed = inbox.claim((await waiting(state, 'done', REPLYING)).id, true)!;
    expect(completed.replyNote).toBe(REPLYING);
    inbox.settle(completed, true);
    const interrupted = inbox.claim((await waiting(state, 'cut', REPLYING)).id, true)!;
    inbox.settle(interrupted, false);
    expect(inbox.claim((await waiting(state, 'revoked', REPLYING)).id, false)).toBeNull();
    for (const id of [completed.id, interrupted.id, inbox.records().at(-1)!.id]) {
      expect(inbox.get(id)).toMatchObject({ text: '' });
      expect(inbox.get(id)).not.toHaveProperty('replyNote');
    }
  });
});

it('a literal forget matching the quoted text drops the waiting reply line, so the turn reads no Replying to line', async () => {
  await runInDurableObject(inboxStub(), async (_i, state) => {
    const inbox = new IMessageOwnerInbox(state.storage);
    const line = '[Replying to your message: "Your secret plan for Friday is set."]';
    const kept = await waiting(state, 'kept', line);
    expect(redactIMessageEntries(state.storage, ['dentist'], '[forgotten]')).toEqual({ rewritten: 0, remaining: 0 });
    expect(inbox.get(kept.id)?.replyNote).toBe(line);
    expect(redactIMessageEntries(state.storage, ['secret plan'], '[forgotten]')).toEqual({ rewritten: 1, remaining: 0 });
    expect(inbox.get(kept.id)).not.toHaveProperty('replyNote');
    expect(inbox.get(kept.id)?.text).toBe('Move it?');
    const running = inbox.claim(kept.id, true)!;
    expect(iMessageTurnParts(running, null)).toBeNull();
  });
});

it('the owner\'s reply to Waldo\'s message reads one host-note line quoting it, beside their own words, on that turn only', async () => {
  const w = await world();
  await w.activate();
  const sent = await w.exchange('What should I focus on today?');
  await w.exchange('Can you move that to the afternoon?', sent);
  expect(proof.turns).toHaveLength(2);
  const said = ownerInput(proof.turns[1]!);
  expect(count(said, REPLYING)).toBe(1);
  expect(said).toContain('Can you move that to the afternoon?');
  await w.exchange('Thanks.');
  expect(ownerInput(proof.turns[2]!)).not.toContain('Replying to');
});

it('a reply to the owner\'s own message, to one not on record, or to a send for another owner or another chat quotes nothing', async () => {
  const w = await world();
  await w.activate();
  const seen = handoffs();
  await w.exchange('Hello');
  const record = await w.firstRecord();
  await w.seed(record.binding, 'sent-to-another-owner', 'imsg-another-owner', CHAT, 'A message that went to someone else.');
  await w.seed(record.binding, 'sent-to-another-chat', record.ownerDoName, 'iMessage;-;alias@example.invalid', 'A message that went elsewhere.');
  const own = w.host.message('a message of the owner\'s own').messageGuid;
  for (const target of [own, 'sim-guid-never-seen', 'sent-to-another-owner', 'sent-to-another-chat']) {
    await w.exchange('What about this one?', target);
    expect(ownerInput(proof.turns.at(-1)!)).not.toContain('Replying to');
  }
  expect(seen.map(input => input.replyQuote)).toEqual([undefined, undefined, undefined, undefined, undefined]);
});

it('the quote withholds a health reading before the 80-character cut, in what the bridge hands over and what the model reads', async () => {
  const w = await world();
  await w.activate();
  const seen = handoffs();
  await w.exchange('Hello');
  const record = await w.firstRecord();
  const text = `${'a '.repeat(30)}ab Your HRV was 52 ms last night, a little lower than usual.`;
  expect([...text].slice(0, 80).join('')).toMatch(/52 m$/);
  await w.seed(record.binding, 'sent-with-reading', record.ownerDoName, CHAT, text);
  await w.exchange('Why was that?', 'sent-with-reading');
  const quote = seen.at(-1)!.replyQuote!;
  expect(quote).not.toMatch(/52|5 ?m|HRV was 5/);
  expect(quote).toContain(HEALTH_SPAN_MARKER.slice(0, 7));
  expect([...quote].length).toBeLessThanOrEqual(81);
  const said = ownerInput(proof.turns.at(-1)!);
  expect(said).toContain('[Replying to your message: "a a a');
  expect(said).not.toMatch(/HRV was 52/);
});

// Outbound: the turn's reply threads onto the owner's message it answers where a thread helps (the owner wrote it as a reply, or
// wrote again before Waldo answered), and only where the bridge's host verified replies.
const REPLIES = { receive: true, send: true, exactTarget: true, verified: true };
// The owner writes (as a reply to `replyTo` when given); the reply command the host then pulls, and the owner's message it answers.
const ask = async (w: Awaited<ReturnType<typeof world>>, text: string, replyTo?: string) => {
  const asked = { ...w.host.message(text), ...(replyTo ? { replyToGuid: replyTo } : {}) };
  expect((await w.host.send(asked)).status).toBe(200);
  await w.pump();
  const delivery = (await w.host.pull()).delivery!;
  return { asked, delivery, command: JSON.parse(delivery.body) };
};
const sent = async (w: Awaited<ReturnType<typeof world>>, delivery: Delivery) => {
  expect((await w.host.postResult(delivery, await w.host.execute(delivery))).status).toBe(200);
  await w.pump(2);
};
const replyRecords = (w: Awaited<ReturnType<typeof world>>) => runInDurableObject(w.ownerStub, async (_i, state) => new IMessageFinalOutbox(state.storage).records().filter(row => row.replyRef.startsWith('reply:')));

it('with replies verified on the host, a reply to the owner\'s latest message, written plainly, still goes out plain', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, false, REPLIES)).status).toBe(200);
  const { delivery, command } = await ask(w, 'Booked the dentist for Friday!');
  expect(command).toMatchObject({ operation: 'send', text: proof.reply });
  expect(command.target).toEqual({ bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT });
  await sent(w, delivery);
  expect(w.host.nativeSends).toEqual([{ commandId: command.commandId, text: proof.reply }]);
});

it('a message the owner wrote as a reply gets its answer threaded onto it', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, false, REPLIES)).status).toBe(200);
  const { asked, delivery, command } = await ask(w, 'Booked the dentist for Friday!', 'some-earlier-message');
  expect(command).toMatchObject({ operation: 'send', text: proof.reply, target: { chatGuid: CHAT, messageGuid: asked.messageGuid, partIndex: 0 }, binding: { subject: SUBJECT, chatGuid: CHAT } });
  expect(command).not.toHaveProperty('replyTo');
  await sent(w, delivery);
  expect(w.host.nativeSends).toEqual([{ commandId: command.commandId, text: proof.reply, replyTo: { messageGuid: asked.messageGuid, partIndex: 0 } }]);
  expect(await replyRecords(w)).toMatchObject([{ state: 'settled', commandId: command.commandId, result: { state: 'local_recorded' } }]);
});

it('when the owner writes again before Waldo answers, the earlier answer threads onto its message and the latest goes out plain', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, false, REPLIES)).status).toBe(200);
  const first = w.host.message('Is the dentist booked?'), second = w.host.message('Also, what time is my flight?');
  expect((await w.host.send(first)).status).toBe(200);
  expect((await w.host.send(second)).status).toBe(200);
  await w.pump();
  const one = (await w.host.pull()).delivery!;
  expect(JSON.parse(one.body).target).toMatchObject({ messageGuid: first.messageGuid, partIndex: 0 });
  await sent(w, one);
  // The second reply froze while the bridge's one mailbox slot held the first: it is handed over at the busy retry.
  await new Promise(resolve => setTimeout(resolve, IMESSAGE_BUSY_RETRY_MS + 100));
  await w.pump();
  const two = (await w.host.pull()).delivery!;
  expect(JSON.parse(two.body).target).toEqual({ bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT });
  await sent(w, two);
  expect(w.host.nativeSends.map(send => send.replyTo ?? null)).toEqual([{ messageGuid: first.messageGuid, partIndex: 0 }, null]);
}, 20_000);

it('without replies sent, verified and exact on the host, the reply goes out plain, exactly as before', async () => {
  const w = await world();
  await w.activate();
  for (const flag of [false, { ...REPLIES, verified: false }, { ...REPLIES, exactTarget: false }, { ...REPLIES, send: false }]) {
    expect((await w.host.capabilities(true, false, flag)).status).toBe(200);
    const { delivery, command } = await ask(w, 'Hi');
    expect(command).toMatchObject({ operation: 'send', text: proof.reply });
    expect(command.target).toEqual({ bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT });
    await sent(w, delivery);
  }
  expect(w.host.nativeSends.map(send => Object.keys(send))).toEqual(Array(4).fill(['commandId', 'text']));
  expect((await replyRecords(w)).map(row => row.result?.state)).toEqual(Array(4).fill('local_recorded'));
});

it('a host that stops verifying replies while the turn runs still gets the reply, plain: never refused, never held', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, false, REPLIES)).status).toBe(200);
  proof.before.push(async () => expect((await w.host.capabilities(true, false, { ...REPLIES, verified: false })).status).toBe(200));
  const { delivery, command } = await ask(w, 'Running late.', 'some-earlier-message');
  expect(command).toMatchObject({ operation: 'send', text: proof.reply });
  expect(command.target).not.toHaveProperty('messageGuid');
  await sent(w, delivery);
  expect(await replyRecords(w)).toMatchObject([{ state: 'settled', result: { state: 'local_recorded' } }]);
});

it('the bridge refuses a reply whose thread target is outside the bound chat, and threads one inside it', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, false, REPLIES)).status).toBe(200);
  const first = await ask(w, 'Hello');
  await sent(w, first.delivery);
  const record = await w.firstRecord();
  const handoff = { replyRef: `reply:${record.id}-probe`, text: 'Probe reply.', ownerDoName: record.ownerDoName, revision: record.revision, bindingDigest: record.bindingDigest, subject: SUBJECT };
  expect(await w.bridgeStub().enqueueReply({ ...handoff, commandId: 'wrc_probe_outside', replyTo: { chatGuid: 'iMessage;-;other@example.invalid', messageGuid: 'sim-guid-elsewhere', partIndex: 0 } }))
    .toMatchObject({ kind: 'terminal', result: { state: 'rejected', disposition: 'not_started', reason: 'target_not_in_chat' } });
  expect((await w.host.pull()).delivery).toBeNull();
  expect(await w.bridgeStub().enqueueReply({ ...handoff, commandId: 'wrc_probe_inside', replyTo: { chatGuid: CHAT, messageGuid: 'sim-guid-inside', partIndex: 1 } })).toEqual({ kind: 'queued' });
  expect(JSON.parse((await w.host.pull()).delivery!.body)).toMatchObject({ commandId: 'wrc_probe_inside', target: { chatGuid: CHAT, messageGuid: 'sim-guid-inside', partIndex: 1 } });
});

// A threaded send's target names the owner's message, never the one it sent: that stays the result's own messageGuid, so the
// bridge's record of what Waldo sent maps only Waldo's own message to the send.
it('a threaded send is recorded under the message it sent; a result naming the owner\'s message as the one sent is refused', async () => {
  const w = await world();
  await w.activate();
  expect((await w.host.capabilities(true, false, REPLIES)).status).toBe(200);
  const first = await ask(w, 'What is next?', 'some-earlier-message');
  expect(first.command.target.messageGuid).toBe(first.asked.messageGuid);
  await sent(w, first.delivery);
  const sentGuid = `sim-sent-${first.command.commandId}`;
  const recorded = () => runInDurableObject(w.bridgeStub(), async (_i, state) => state.storage.sql.exec<{ message_guid: string }>('SELECT message_guid FROM sent_messages ORDER BY message_guid').toArray().map(row => row.message_guid));
  expect(await recorded()).toEqual([sentGuid]);
  // The owner replying to their own earlier message quotes nothing; replying to Waldo's threaded reply quotes it.
  await w.exchange('And this?', first.asked.messageGuid);
  expect(ownerInput(proof.turns.at(-1)!)).not.toContain('Replying to');
  await w.exchange('And that?', sentGuid);
  expect(count(ownerInput(proof.turns.at(-1)!), REPLYING)).toBe(1);
  // A host that reports the replied-to message as the one it sent is refused, and records nothing under the owner's message.
  const third = await ask(w, 'One more.', 'some-earlier-message');
  const confused = { ...await w.host.execute(third.delivery), messageGuid: third.asked.messageGuid };
  expect((await w.host.postResult(third.delivery, confused)).status).toBe(409);
  expect(await recorded()).not.toContain(third.asked.messageGuid);
});

// No model argument picks a thread target: only the turn's own reply carries the owner's message it answers, and only where it helps.
it('only the turn\'s reply is frozen with the owner\'s message as its thread target; notices, notes, links and copies are not', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`imsg-thread-${crypto.randomUUID()}`)), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage);
    const binding = { ownerId: 'o', presenceId: 'p', subject: SUBJECT, bridgeId: 'b', accountId: 'a', chatGuid: CHAT, verified: true as const, conversationKind: 'direct' as const, service: 'iMessage' as const };
    const record = (id: string, messageRef?: { messageGuid: string; partIndex: number }): IMessageInboxRecord => ({ id, updateId: 1, dedupKey: id, digest: 'x', text: 'hi', conversationRef: 'c', binding,
      bindingDigest: 'd', revision: 'r', environment: 'test', bridgeDoName: 'bridge', ownerDoName: 'owner', commandId: `wrc_${id}`, occurredAt: 1, admittedAt: 1, state: 'running', ...(messageRef ? { messageRef } : {}) });
    const answered = { ...record('imsg-1', { messageGuid: 'owner-message', partIndex: 2 }), ownerThreaded: true as const };
    expect(outbox.freeze(answered, 'Reply.').replyTo).toEqual({ chatGuid: CHAT, messageGuid: 'owner-message', partIndex: 2 });
    expect(outbox.freeze(answered, 'Console link.', 'console').replyTo).toBeUndefined();
    expect(outbox.freezeFailure(answered, 'Notice.').replyTo).toBeUndefined();
    expect(outbox.freezeProgress(answered, 1, 'Still on it.').replyTo).toBeUndefined();
    expect(outbox.freezeProactive('job-1', 'wpc_job-1', targetOf(answered), 'A copy.').replyTo).toBeUndefined();
    expect(outbox.freeze(record('imsg-2'), 'Reply.').replyTo).toBeUndefined();
  });
});

it('a plain reply threads only once the owner has written again in the same chat; a message in another chat does not count', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`imsg-thread-${crypto.randomUUID()}`)), async (_i, state) => {
    const inbox = new IMessageOwnerInbox(state.storage), outbox = new IMessageFinalOutbox(state.storage);
    const binding = { ownerId: 'o', presenceId: 'p', subject: SUBJECT, bridgeId: 'b', accountId: 'a', chatGuid: CHAT, verified: true as const, conversationKind: 'direct' as const, service: 'iMessage' as const };
    const admit = async (id: string, conversationRef: string) => {
      const r = await inbox.admit({ dedupKey: id, digest: 'x', text: id, conversationRef, binding, bindingDigest: 'd', revision: 'r', environment: 'test', bridgeDoName: 'bridge',
        ownerDoName: 'owner', commandId: `wrc_${id}`, occurredAt: 1, messageRef: { messageGuid: `guid-${id}`, partIndex: 0 } });
      if (r.kind !== 'admitted') throw new Error(r.kind);
      return r.record;
    };
    const first = await admit('m1', 'chat');
    await admit('elsewhere', 'other-chat');
    expect(outbox.freeze(first, 'Plain.').replyTo).toBeUndefined();
    const second = await admit('m2', 'chat');
    await admit('m3', 'chat');
    expect(outbox.freeze(second, 'Threaded.').replyTo).toEqual({ chatGuid: CHAT, messageGuid: 'guid-m2', partIndex: 0 });
  });
});
