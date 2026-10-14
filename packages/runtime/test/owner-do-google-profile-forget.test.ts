import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { CONSOLE_ACTION_PATH, CONSOLE_COOKIE, consoleAccess } from '../src/channels/console';
import { GOOGLE_FINISH_PATH } from '../src/channels/google-oauth';
import { startConsent, type ConsentFlow } from '../src/connectors/google-consent';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// The owner forgets what their Google account says about them without disconnecting it. A forget names the fact either by
// its exact text or, when the owner's words don't spell it out ("forget my name"), by the field the model names. A
// forgotten name is hidden from every line, after a reconnect too, and the forget settles; a forgotten phone is deleted,
// and a reconnect does not store it again. The owner can still give their name in their own words. A forget of anything
// else leaves the name, and a disconnect still removes the whole record.
const MAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'];
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const OWNER_ID = '3b8e5c1d-9f2a-4d7e-b6c0-1a4f8e2d5c97';
const BASE = 'https://directory.fixture.invalid';
const PHONE = '+15550100777';
const NAMES = { name: 'Zoë Okonkwo-Ström', given_name: 'Zoë', family_name: 'Okonkwo-Ström' };
const LABEL = "From the owner's Google account, not yet confirmed by the owner";
const ON_RECORD = 'the only name on record is the unconfirmed one from their Google account';
const NO_NAME = 'no name is on record';
const DAY = 86_400_000;

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], calls: [] as { name: string; arguments: string }[] }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => method === 'sendMessage' ? { message_id: 1, chat: { id: payload.chat_id } } : true };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const format = request.request.response_format?.name;
    const answer = (text: string, calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...(calls ? { tool_calls: calls } : {}) } });
    if (format === 'task_source_scope') return answer('{"decision":"retain","sources":[]}');
    if (format !== undefined) return answer('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const call = model.calls.shift();
    return call ? answer('', [{ call_id: `call-${model.requests.length}`, ...call }]) : answer('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); model.requests = []; model.calls = []; });

type Edge = { id: string; email: string; profile: unknown };
const directory = (edge: Edge) => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const raw = init?.body ? String(init.body) : '';
  if (url === `${BASE}/functions/v1/connector-proxy`) {
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (body.op === 'exchange') return Response.json({ id: edge.id, email: edge.email, scopes: [...MAIL, CALENDAR], profile: edge.profile });
    if (body.op === 'gmail_watch') return Response.json({ data: { historyId: '555', expiration: Date.now() + 7 * DAY } });
    if (body.op === 'calendar_watch') return Response.json({ data: { channelId: body.channel_id, resourceId: 'res-1', expiration: Date.now() + 7 * DAY } });
    if (body.op === 'call') return Response.json({ data: [] });
    return Response.json({ error: { status: 404, message: 'unknown operation' } });
  }
  const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
  const args = raw ? JSON.parse(raw) as Record<string, string> : {};
  if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
  if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
  if (fn === 'assert_channel_presence') return Response.json(true);
  if (fn === 'health_context_read') return Response.json(null);
  if (fn === 'connection_revoke') return Response.json(true);
  return new Response('unexpected', { status: 500 });
});
const ownerFor = async (name: string, state: DurableObjectState) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  await state.storage.put('origin', 'https://fixture.invalid');
  return new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
};
// One consent attempt, settled through the owner object's own finish route.
const connect = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState) => {
  const store = { read: async () => (await state.storage.get<Record<string, ConsentFlow>>('google:consents')) ?? {}, write: (flows: Record<string, ConsentFlow>) => state.storage.put('google:consents', flows) };
  const { nonce } = await startConsent({ store, now: () => Date.now() }, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://fixture.invalid/oauth/google/callback' }, 'state-secret-fixture', '7');
  const reply = await owner.fetch(new Request(`https://owner.invalid${GOOGLE_FINISH_PATH}`, { method: 'POST', body: JSON.stringify({ nonce, code: 'synthetic-code', error: null }) }));
  expect((await reply.json() as { outcome: { kind: string } }).outcome.kind).toBe('linked');
};
// One app turn, run to completion. A queued call is what the model answers with first; the next round replies.
const send = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState, name: string, text: string, call?: { name: string; args: unknown }) => {
  if (call) model.calls.push({ name: call.name, arguments: JSON.stringify(call.args) });
  const sent = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${text.replace(/\W+/g, '-')}`, text }) }));
  expect(sent.status, await sent.clone().text()).toBe(202);
  const { message_id: id } = await sent.json() as { message_id: string };
  await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
};
const repliesTo = (text: string) => model.requests.filter(request => request.response_format === undefined && JSON.stringify(request.messages.at(-1)?.content ?? '').includes(text));
// What a tool told the model, from the round that follows the call.
const receiptOf = (tool: string) => {
  const outputs = model.requests.flatMap(request => (request.tool_turns ?? []).filter(turn => turn.call.name === tool).map(turn => turn.output));
  expect(outputs.length, `the ${tool} call reached the tool`).toBeGreaterThan(0);
  return outputs.at(-1)!;
};
const forgetReceipt = () => receiptOf('forget_memory');
const count = (text: string, part: string) => text.split(part).length - 1;
const settled = (state: DurableObjectState) => {
  const memory = claimStore(state.storage.sql);
  expect(memory.pendingTopics(), 'no forget topic is left pending').toEqual([]);
  expect(memory.incompleteTopics(), 'no forget topic is left incomplete').toEqual([]);
};
const listed = async (state: DurableObjectState) => JSON.stringify([...(await state.storage.list())]);

it('"forget my name" hides the Google name from the next turn, both lines, and after a reconnect; the forget settles; a disconnect still removes the record', async () => {
  const edge: Edge = { id: 'conn-1', email: 'owner@example.test', profile: { ...NAMES, phone: PHONE } };
  directory(edge);
  const name = 'google-profile-forget-name';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    try {
      await connect(owner, state);
      await send(owner, state, name, 'what should you call me?');
      const before = repliesTo('what should you call me?');
      expect(before.length, 'the owner turn reached the model').toBeGreaterThan(0);
      for (const request of before) {
        expect(count(request.system ?? '', LABEL), 'before the forget the name line is there').toBe(1);
        expect(request.system).toContain(ON_RECORD);
      }

      // The owner's words name no value, so the model names the field.
      await send(owner, state, name, 'Please forget my name', { name: 'forget_memory', args: { provider_fields: ['name'], scope_note: 'their name' } });
      const receipt = forgetReceipt();
      expect(receipt, 'the forget settles with a success receipt').toContain('"ok":true');
      expect(receipt, 'the receipt names the provider fact, never its value').toContain('provider_facts');
      expect(receipt).not.toContain('Okonkwo');
      expect(receipt, 'nothing in memory carried it, and the receipt does not claim otherwise').not.toContain('removed from memory');
      settled(state);
      // A second field forget adds to the first rather than replacing it.
      await send(owner, state, name, 'And my phone number', { name: 'forget_memory', args: { provider_fields: ['phone'], scope_note: 'their phone number' } });
      expect(forgetReceipt()).toContain('"ok":true');

      const after = async (text: string, absent: readonly string[]) => {
        await send(owner, state, name, text);
        const replies = repliesTo(text);
        expect(replies.length, 'the owner turn reached the model').toBeGreaterThan(0);
        for (const request of replies) {
          expect(request.system, 'no Google name line').not.toContain(LABEL);
          expect(request.system, 'the first-conversation line knows no name').toContain(NO_NAME);
          expect(request.system).not.toContain(ON_RECORD);
          for (const part of absent) expect(JSON.stringify(request), 'no part of the request carries the name').not.toContain(part);
        }
      };
      await after('what should you call me now?', ['Okonkwo']);

      // A reconnect replaces the stored profile wholesale, here under a name that shares no part with the forgotten one.
      // The owner forgot the field, not only its old value, so the line stays out.
      edge.profile = { name: 'Zed Strand', given_name: 'Zed', family_name: 'Strand' };
      await connect(owner, state);
      await after('and after the reconnect?', ['Okonkwo', 'Strand']);

      const access = consoleAccess(state.storage);
      const token = await access.grant();
      const { csrf } = (await access.session(token))!;
      await owner.fetch(new Request(`https://owner.invalid${CONSOLE_ACTION_PATH}`, { method: 'POST', headers: { cookie: `${CONSOLE_COOKIE}=${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, action: 'google.disconnect', id: 'conn-1' }) }));
      expect(await state.storage.get('google:accounts')).toEqual([]);
      expect(await state.storage.get('google:profiles'), 'the disconnect removes the record, the hidden name included').toEqual({});
      const left = await listed(state);
      for (const kept of [PHONE, ...Object.values(NAMES), 'Strand']) expect(left, 'no object KV entry carries the phone or a name').not.toContain(kept);

      // The forget is the owner's, not the account's: connecting again after the disconnect does not bring the name back.
      await connect(owner, state);
      await after('and after connecting again?', ['Okonkwo', 'Strand']);
    } finally { await state.storage.deleteAlarm(); }
  });
}, 30_000);

it('"forget my phone number" deletes the Google phone by field, a reconnect does not store it again, and the name stays', async () => {
  const edge: Edge = { id: 'conn-1', email: 'owner@example.test', profile: { ...NAMES, phone: PHONE } };
  directory(edge);
  const name = 'google-profile-forget-phone-field';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    try {
      await connect(owner, state);
      await send(owner, state, name, 'Forget my phone number', { name: 'forget_memory', args: { provider_fields: ['phone'], scope_note: 'their phone number' } });
      const receipt = forgetReceipt();
      expect(receipt).toContain('"ok":true');
      expect(receipt).not.toContain(PHONE);
      settled(state);
      expect(await state.storage.get('google:profiles'), 'the phone is deleted and the name kept').toEqual({ 'conn-1': { ...NAMES, at: expect.any(Number) } });

      await connect(owner, state);
      expect(await state.storage.get('google:profiles'), 'a reconnect does not store the forgotten phone').toEqual({ 'conn-1': { ...NAMES, at: expect.any(Number) } });
      expect(await listed(state)).not.toContain(PHONE);
      await send(owner, state, name, 'what should you call me?');
      const replies = repliesTo('what should you call me?');
      expect(replies.length).toBeGreaterThan(0);
      for (const request of replies) expect(count(request.system ?? '', LABEL), 'a phone forget leaves the name line').toBe(1);
    } finally { await state.storage.deleteAlarm(); }
  });
}, 30_000);

it('a forget by field with no connected account fails honestly, and the turn completes', async () => {
  directory({ id: 'conn-1', email: 'owner@example.test', profile: NAMES });
  const name = 'google-profile-forget-no-account';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    try {
      await send(owner, state, name, 'Please forget my name', { name: 'forget_memory', args: { provider_fields: ['name'], scope_note: 'their name' } });
      const receipt = forgetReceipt();
      expect(receipt).toContain('"ok":false');
      expect(receipt).toContain('No connected account');
      expect(claimStore(state.storage.sql).barriers(), 'nothing was barred').toEqual([]);
      expect(await state.storage.get('google:forgotten'), 'nothing was hidden ahead of a future connect').toBeUndefined();
    } finally { await state.storage.deleteAlarm(); }
  });
}, 30_000);

it('after "forget my name", the owner\'s own words win: their name, said as a bare word, is remembered and the model can read it', async () => {
  directory({ id: 'conn-1', email: 'owner@example.test', profile: NAMES });
  const name = 'google-profile-forget-correction';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    try {
      await connect(owner, state);
      await send(owner, state, name, 'Please forget my name', { name: 'forget_memory', args: { provider_fields: ['name'], scope_note: 'their name' } });
      expect(forgetReceipt()).toContain('"ok":true');

      // The owner answers with the given name alone, so the quote and the alias are exactly the name Google gave.
      await send(owner, state, name, 'Zoë', { name: 'remember', args: { kind: 'preference', text: 'The owner wants to be called Zoë', evidence_quote: 'Zoë', aliases: ['Zoë'] } });
      expect(receiptOf('remember'), 'a forgotten Google name never blocks the owner saying it').toContain('"status":"stored"');
      await send(owner, state, name, 'what do you know about me?', { name: 'read_memory', args: { limit: 10 } });
      expect(receiptOf('read_memory')).toContain('The owner wants to be called Zoë');
      const replies = repliesTo('what do you know about me?');
      expect(replies.length).toBeGreaterThan(0);
      for (const request of replies) expect(request.system, 'the Google line stays hidden').not.toContain(LABEL);
    } finally { await state.storage.deleteAlarm(); }
  });
}, 30_000);

it('forgetting the Google phone by its exact text deletes it, no prompt or log carries it, a reconnect does not store it again, and the name stays', async () => {
  const edge: Edge = { id: 'conn-1', email: 'owner@example.test', profile: { ...NAMES, phone: PHONE } };
  directory(edge);
  const name = 'google-profile-forget-phone';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    const logs = vi.spyOn(console, 'log');
    try {
      await connect(owner, state);
      expect(await listed(state), 'the scan finds the kept phone').toContain(PHONE);

      await send(owner, state, name, `Forget my number ${PHONE}`, { name: 'forget_memory', args: { topic: PHONE, scope_note: 'their phone number' } });
      expect(forgetReceipt(), 'the forget settles with a success receipt').toContain('"ok":true');
      settled(state);
      expect(await state.storage.get('google:profiles'), 'the phone is deleted and the name kept').toEqual({ 'conn-1': { ...NAMES, at: expect.any(Number) } });
      expect(await listed(state), 'no object KV entry carries the phone').not.toContain(PHONE);

      await send(owner, state, name, 'what should you call me?');
      const replies = repliesTo('what should you call me?');
      expect(replies.length).toBeGreaterThan(0);
      for (const request of replies) {
        expect(count(request.system ?? '', LABEL), 'a phone forget leaves the name line').toBe(1);
        expect(JSON.stringify(request), 'no part of the next prompt carries the phone').not.toContain(PHONE);
      }

      await connect(owner, state);
      expect(await state.storage.get('google:profiles'), 'a reconnect does not store the forgotten phone').toEqual({ 'conn-1': { ...NAMES, at: expect.any(Number) } });
      expect(await listed(state)).not.toContain(PHONE);
      expect(JSON.stringify(logs.mock.calls), 'no log carries the phone').not.toContain(PHONE);
    } finally { logs.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 30_000);

// The forgotten fact shares a word with the family name, which an exact match must not take for the name.
it('forgetting something else leaves the Google name, and its receipt claims no provider fact', async () => {
  const edge: Edge = { id: 'conn-1', email: 'owner@example.test', profile: NAMES };
  directory(edge);
  const name = 'google-profile-forget-unrelated';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    try {
      await connect(owner, state);
      await send(owner, state, name, 'My manager is Mr Okonkwo', { name: 'remember', args: { kind: 'fact', text: 'Manager is Mr Okonkwo', evidence_quote: 'My manager is Mr Okonkwo' } });
      expect(claimStore(state.storage.sql).claims().map(claim => claim.text)).toEqual(['Manager is Mr Okonkwo']);
      await send(owner, state, name, 'Forget Okonkwo', { name: 'forget_memory', args: { topic: 'Okonkwo', scope_note: 'their manager' } });
      const receipt = forgetReceipt();
      expect(receipt).toContain('"ok":true');
      expect(receipt).not.toContain('provider_facts');
      expect(claimStore(state.storage.sql).claims()).toEqual([]);

      await send(owner, state, name, 'what should you call me?');
      const replies = repliesTo('what should you call me?');
      expect(replies.length).toBeGreaterThan(0);
      for (const request of replies) {
        expect(count(request.system ?? '', LABEL), 'the name line stays').toBe(1);
        expect(request.system).toContain('"Zoë Okonkwo-Ström"');
      }
    } finally { await state.storage.deleteAlarm(); }
  });
}, 30_000);

it('a forgotten name hides only the account it belongs to: another account with a different name still gives the line', async () => {
  const edge: Edge = { id: 'conn-work', email: 'work@example.test', profile: NAMES };
  directory(edge);
  const name = 'google-profile-forget-two-accounts';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    try {
      await connect(owner, state);
      Object.assign(edge, { id: 'conn-home', email: 'home@example.test', profile: { name: 'Zo Ström', given_name: 'Zo' } });
      await connect(owner, state);
      await send(owner, state, name, 'Forget Zoë Okonkwo-Ström', { name: 'forget_memory', args: { topic: 'Zoë Okonkwo-Ström', scope_note: 'the work account name' } });
      expect(forgetReceipt()).toContain('"ok":true');

      await send(owner, state, name, 'what should you call me?');
      const replies = repliesTo('what should you call me?');
      expect(replies.length).toBeGreaterThan(0);
      for (const request of replies) {
        expect(count(request.system ?? '', LABEL), 'the other account still gives the line').toBe(1);
        expect(request.system).toContain('"Zo Ström"');
        expect(request.system).not.toContain('Okonkwo');
      }
    } finally { await state.storage.deleteAlarm(); }
  });
}, 30_000);
