// iMessage replies to a specific message, through the signed bridge, the owner DO and a scripted model. Inbound, the owner's
// reply to a message Waldo sent them in their bound chat is one host-note line their turn reads; anything else adds nothing.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { buildTextReply, iMessageBridgeName, type IMessageTurnHandoff } from '../src/channels/imessage/bridge-do';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { iMessageTurnParts } from '../src/channels/imessage/owner-runtime';
import { receivedView, renderForModel } from '../src/channels/owner-inbound-turn';
import { OwnerDO } from '../src/channels/owner-do';
import { HEALTH_SPAN_MARKER } from '../src/scribe/sanitiser';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

const proof = vi.hoisted(() => ({ turns: [] as string[], reply: 'Scripted owner reply.' }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) proof.turns.push(JSON.stringify(input.input ?? ''));
  if (format === 'progress_note') return { id: 'scripted', output: [], output_text: JSON.stringify({ note: null }), usage: { input_tokens: 1, output_tokens: 1 } };
  return { id: 'scripted', output: [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.reply, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
const REPLYING = '[Replying to your message: "Scripted owner reply."]';

afterEach(() => { vi.restoreAllMocks(); proof.turns = []; });

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
