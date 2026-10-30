// An iMessage turn reads the owner's skill book as an app turn does: through the signed bridge, the owner object and a
// scripted model, the model sees the index, loads a skill the owner never named, and the reply still goes out as a native
// iMessage send in the bound chat.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { iMessageBridgeName } from '../src/channels/imessage/bridge-do';
import { CURATED_SKILLS } from '../src/skills/curated-owner';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

const SKILL = CURATED_SKILLS.find(skill => skill.name === 'day-brief')!;
const REPLY = 'Three meetings today; the board prep at 11 matters most.';
const proof = vi.hoisted(() => ({ calls: [] as Array<{ instructions: string; tools: string[] }>, step: 0, load: { name: '', version: 0 } }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (format === 'claim_ops') return { id: 'scripted', output: [], output_text: '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', usage };
  if (format === 'progress_note') return { id: 'scripted', output: [], output_text: JSON.stringify({ note: null }), usage };
  if (format) return { id: 'scripted', output: [], output_text: '{}', usage };
  proof.calls.push({ instructions: String(input.instructions ?? ''), tools: (input.tools ?? []).map((tool: { name?: string }) => tool.name ?? '') });
  return proof.step++ === 0
    ? { id: 'scripted', output: [{ type: 'function_call', call_id: 'load', name: 'skills_load', arguments: JSON.stringify(proof.load) }], output_text: '', usage }
    : { id: 'scripted', output: [], output_text: 'Three meetings today; the board prep at 11 matters most.', usage };
} }; } }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
afterEach(() => { vi.restoreAllMocks(); proof.calls = []; proof.step = 0; });

it('an iMessage turn loads a reviewed skill unprompted, keeps its tools, and replies as a native send in the bound chat', async () => {
  proof.load = { name: SKILL.name, version: SKILL.version };
  const ownerName = `imsg-skills-${crypto.randomUUID()}`;
  const owners: FixtureOwner[] = [{ do_name: ownerName, owner_id: '10000000-0000-4000-8000-000000000002', state: 'active', state_version: 1, admission_revision: 1 }];
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
  const code = (await (await action('imessage.pair')).text()).split('\n')[0]!;
  expect((await host.redeem(code)).status).toBe(200);
  const challenge = (await (await action('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
  expect((await host.send(host.message(challenge))).status).toBe(200);
  expect((await action('imessage.activate', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
  expect((await host.heartbeat()).status).toBe(200);
  expect((await host.capabilities()).status).toBe(200);

  expect((await host.send(host.message('What does today look like?'))).status).toBe(200);
  await pump();
  expect(proof.calls).toHaveLength(2);
  expect(proof.calls[0]!.instructions).toContain(`- ${SKILL.name}@${SKILL.version}: ${SKILL.trigger_condition}`);
  expect(proof.calls[0]!.instructions).not.toContain(SKILL.body_markdown);
  expect(proof.calls[1]!.instructions).toContain(SKILL.body_markdown);
  expect(proof.calls[0]!.tools).toContain('skills_load');
  expect(proof.calls[1]!.tools).toEqual(proof.calls[0]!.tools);
  const { delivery } = await host.pull();
  const command = JSON.parse(delivery!.body);
  expect(command).toMatchObject({ operation: 'send', text: REPLY });
  expect(command.target).toEqual({ bridgeId: host.bridgeId, accountId: host.accountId, chatGuid: CHAT });
}, 60_000);
