import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CREDENTIAL_REPLY_TEXT } from '../src/channels/console-link';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { claimStore } from '../src/memory/claims';
import { persistInboxWake } from '../src/scheduler/alarm-slot';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// A directory-backed Telegram owner asks for their console in their own words. The model calls send_console_link, the
// host mints the one-time link and sends it straight to the chat. Text capture is on, as on staging, so every sink that
// could carry the link actually receives the turn's text.
const world = vi.hoisted(() => ({ requests: [] as string[], outputs: [] as string[], sends: [] as { text: string; message_id: number; chat?: number }[], next: 500, otlp: [] as string[],
  firstTool: undefined as string | undefined, during: undefined as (() => Promise<void>) | undefined }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    if (request.response_format) return { ok: true as const, data: { model: request.model, text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    world.requests.push(JSON.stringify(request));
    const during = world.during;
    world.during = undefined;
    await during?.();
    // The model reads the whole turn, foreign text included, and asks for the tool whenever "console link" appears in it:
    // whether that request may mint is the host's deterministic call, not the model's.
    const name = request.tool_turns?.length ? undefined : world.firstTool ?? (JSON.stringify(request.messages.at(-1)).includes('console link') ? 'send_console_link' : undefined);
    const text = name ? '' : 'Done.';
    world.outputs.push(text);
    return { ok: true as const, data: { model: request.model, text, ...(name ? { tool_calls: [{ call_id: 'first', name, arguments: '{}' }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: { chat_id?: number; text?: string }) => {
  if (method === 'getMe') return { username: 'fixture_bot' };
  if (method !== 'sendMessage') return true;
  const message_id = world.next++;
  world.sends.push({ text: body.text ?? '', message_id, chat: body.chat_id });
  return { message_id, chat: { id: body.chat_id, type: 'private' }, text: body.text };
} }));
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '3f9a1c27-6b4e-4d18-9a35-7e2c1b0d4f68';
const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const ORIGIN = 'https://waldo.fixture.invalid';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const langfuse = { LANGFUSE_PUBLIC_KEY: 'pk-fixture', LANGFUSE_SECRET_KEY: 'sk-fixture', LANGFUSE_BASE_URL: 'https://langfuse.fixture.invalid', LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'staging' };

beforeEach(() => {
  world.requests = []; world.outputs = []; world.sends = []; world.otlp = []; world.firstTool = undefined; world.during = undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(langfuse.LANGFUSE_BASE_URL)) { world.otlp.push(String(init?.body ?? '')); return new Response('{}', { status: 200 }); }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'common_owner_authority') return Response.json({ admission_revision: '5', auth_user_id: OWNER_ID, do_name: asked.p_do_name, owner_id: OWNER_ID, presence_id: '0d6b1f22-9c4e-4a7b-8e21-5f3a9c7d1b44', provider: asked.p_provider, state_version: 1, subject: asked.p_subject });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

type Owner = Readonly<{
  send(update: number, message: Readonly<Record<string, unknown>>): Promise<string | undefined>;
  // Webhook ingress, as a message that arrives while a turn is running does.
  enqueue(update: number, message: Readonly<Record<string, unknown>>): Promise<number>;
  inboxBody(update: number): Promise<string | undefined>;
  // The final reply leaves on the alarm; only its settlement logs the root hop that exports the turn's trace.
  deliver(update: number): Promise<string | undefined>;
  redeem(ticket: string): Promise<number>;
  state: DurableObjectState;
  logged(): string;
}>;
const telegramOwner = (name: string, run: (owner: Owner) => Promise<void>, withDirectory = true) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  await state.storage.put({ telegram_subject: '42', do_name: name, origin: ORIGIN });
  const lines: unknown[][] = [];
  const spies = (['log', 'error', 'warn', 'info'] as const).map(level => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args); }));
  const owner = new OwnerDO(state, { ...env, ...(withDirectory ? directory : {}), ...langfuse, TELEGRAM_BOT_TOKEN: '7.fixture', TELEGRAM_WEBHOOK_SECRET: 'synthetic-inbox-secret', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
  const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
  try {
    await run({
      state,
      send: async (update, message) => {
        await inbox.admit({ bot: '7.fixture', subject: '42', doName: name }, update, JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, ...message } }));
        await (owner as unknown as { drainInbox(): Promise<void> }).drainInbox();
        return (await inbox.records()).find(row => row.updateId === update)?.state;
      },
      enqueue: async (update, message) => (await owner.fetch(new Request('https://telegram-owner/enqueue', {
        method: 'POST', headers: { 'x-waldo-inbox-secret': 'synthetic-inbox-secret', 'x-waldo-telegram-subject': '42', 'x-waldo-do-name': name },
        body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, date: 1, ...message } }),
      }))).status,
      inboxBody: async update => (await inbox.records()).find(row => row.updateId === update)?.body,
      deliver: async update => {
        const state = async () => (await inbox.records()).find(row => row.updateId === update)?.state;
        // The final reply falls due a moment after it is queued: the clock moves past that instead of the test sleeping.
        const now = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        for (let pass = 1; pass <= 4 && await state() !== 'completed'; pass++) { vi.setSystemTime(now + pass * 1_000); await owner.alarm(); }
        return state();
      },
      redeem: async ticket => (await owner.fetch(new Request(`${ORIGIN}/console`, { method: 'POST', body: new URLSearchParams({ t: ticket }) }))).status,
      logged: () => JSON.stringify(lines),
    });
  } finally { for (const spy of spies) spy.mockRestore(); await state.storage.deleteAlarm(); }
});
const linkSends = () => world.sends.filter(sent => sent.text.includes('/console?t='));
// Tool outputs sit JSON-encoded inside the recorded request JSON.
const prompts = () => world.requests.join('\n').replaceAll('\\"', '"');
// Every exported span, as its trace key and Langfuse user.
const spans = () => world.otlp.flatMap(body => (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: { attributes: { key: string; value: { stringValue?: string } }[] }[] }[] }[] })
  .resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans.map(span => Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value.stringValue]))))));
const ticketOf = (text: string) => new URL(/https:\/\/\S+/.exec(text)![0]).searchParams.get('t')!;
const everywhere = async (state: DurableObjectState, owner: Owner) => {
  const kv = [...(await state.storage.list()).entries()].filter(([key]) => key !== 'console:link');
  const traces = state.storage.sql.exec('SELECT * FROM trace_log').toArray();
  return { prompts: world.requests.join('\n'), outputs: world.outputs.join('\n'), traces: JSON.stringify(traces), logs: owner.logged(), otlp: world.otlp.join('\n'), stored: JSON.stringify(kv),
    replies: world.sends.filter(sent => !sent.text.includes('/console?t=')).map(sent => sent.text).join('\n') };
};

it('the owner\'s own request sends one link to their Telegram chat; it reaches no prompt, model output, trace, log or transcript', async () => {
  await telegramOwner('console-link-telegram-own', async owner => {
    expect(await owner.send(940001, { text: 'Can you send me my console link?' })).toBe('awaiting_delivery');
    expect(linkSends()).toHaveLength(1);
    const [sent] = linkSends();
    expect(sent!.chat).toBe(42);
    const link = /https:\/\/\S+/.exec(sent!.text)![0];
    const ticket = ticketOf(sent!.text);
    expect(link.startsWith(`${ORIGIN}/console?t=c1.`)).toBe(true);
    expect(await owner.deliver(940001)).toBe('completed');
    const turn = () => spans().filter(span => span['langfuse.trace.metadata.trace_key'] === 'tg-940001');
    await vi.waitFor(() => expect(turn().map(span => span['langfuse.observation.metadata.hop'])).toEqual(expect.arrayContaining(['tool_send_console_link', 'console_link', 'llm_reply'])));
    // The turn's text really reached every sink: the scan below is not vacuous.
    const sinks = await everywhere(owner.state, owner);
    for (const sink of ['prompts', 'otlp', 'logs'] as const) expect(sinks[sink], sink).toContain('send_console_link');
    expect(sinks.otlp).toContain('Can you send me my console link?');
    expect(sinks.traces).toContain('send_console_link');
    expect(prompts()).toContain('"sent":true,"surface":"telegram"');
    for (const [sink, text] of Object.entries(sinks)) {
      expect(text, sink).not.toContain(link);
      expect(text, sink).not.toContain(ticket);
      expect(text, sink).not.toContain(ticket.split('.')[1]!);
    }
    // The hop says only that it went and where.
    expect(owner.state.storage.sql.exec("SELECT ok, note FROM trace_log WHERE hop = 'console_link'").toArray()).toEqual([{ ok: 1, note: 'telegram' }]);
    // Langfuse files the turn under the directory owner principal, never the chat id.
    expect(new Set(turn().map(span => span['langfuse.user.id']))).toEqual(new Set([PRINCIPAL]));
  });
});

it('a reply to the link message reaches the model masked, and so does a reply to a /console link', async () => {
  await telegramOwner('console-link-telegram-reply', async owner => {
    expect(await owner.send(940011, { text: 'Can you send me my console link?' })).toBe('awaiting_delivery');
    const [toolSent] = linkSends();
    world.requests = [];
    expect(await owner.send(940012, { text: 'Is this still good?', reply_to_message: { message_id: toolSent!.message_id, from: { id: 7, is_bot: true }, chat: { id: 42, type: 'private' }, date: 1, text: toolSent!.text } })).toBe('awaiting_delivery');
    expect(world.requests.join('\n')).toContain(CREDENTIAL_REPLY_TEXT);
    expect(world.requests.join('\n')).not.toContain(ticketOf(toolSent!.text));
    // The text command still works until the tool is verified on staging, and its link is masked the same way.
    expect(await owner.send(940013, { text: '/console' })).toBe('completed');
    const commandSent = linkSends().at(-1)!;
    expect(commandSent.message_id).not.toBe(toolSent!.message_id);
    world.requests = [];
    expect(await owner.send(940014, { text: 'And this one?', reply_to_message: { message_id: commandSent.message_id, from: { id: 7, is_bot: true }, chat: { id: 42, type: 'private' }, date: 1, text: commandSent.text } })).toBe('awaiting_delivery');
    expect(world.requests.join('\n')).toContain(CREDENTIAL_REPLY_TEXT);
    expect(world.requests.join('\n')).not.toContain(ticketOf(commandSent.text));
    // Any other reply keeps its text.
    world.requests = [];
    expect(await owner.send(940015, { text: 'What about this?', reply_to_message: { message_id: 123, from: { id: 7, is_bot: true }, chat: { id: 42, type: 'private' }, date: 1, text: 'Your 3pm moved to 4pm.' } })).toBe('awaiting_delivery');
    expect(world.requests.join('\n')).toContain('Your 3pm moved to 4pm.');
  });
});

it('a reply to the link message asking for a new one sends a new link: Waldo\'s own message is not outside content', async () => {
  await telegramOwner('console-link-telegram-again', async owner => {
    expect(await owner.send(940051, { text: 'Can you send me my console link?' })).toBe('awaiting_delivery');
    const [first] = linkSends();
    world.requests = [];
    expect(await owner.send(940052, { text: 'That one expired, send me a new console link', reply_to_message: { message_id: first!.message_id, from: { id: 7, is_bot: true }, chat: { id: 42, type: 'private' }, date: 1, text: first!.text } })).toBe('awaiting_delivery');
    expect(linkSends()).toHaveLength(2);
    expect(prompts()).toContain('"sent":true,"surface":"telegram"');
    expect(prompts()).toContain(CREDENTIAL_REPLY_TEXT);
    expect(prompts()).not.toContain(ticketOf(first!.text));
    // The new link voided the old one: the owner holds one grant.
    expect(await owner.redeem(ticketOf(first!.text))).toBe(403);
    expect(await owner.redeem(ticketOf(linkSends()[1]!.text))).toBe(303);
  });
});

it('a reply to the link message that steers a running turn is admitted with the link masked', async () => {
  await telegramOwner('console-link-telegram-steer', async owner => {
    expect(await owner.send(940061, { text: 'Can you send me my console link?' })).toBe('awaiting_delivery');
    const [sent] = linkSends();
    const ticket = ticketOf(sent!.text);
    let steered: number | undefined, stored: string | undefined;
    // The running turn makes one tool round, so the steer that lands during its first model call is heard in the second.
    world.firstTool = 'list_reminders';
    world.during = async () => {
      steered = await owner.enqueue(940063, { text: 'Is this still good?', reply_to_message: { message_id: sent!.message_id, from: { id: 7, is_bot: true }, chat: { id: 42, type: 'private' }, date: 1, text: sent!.text } });
      // A steer's inbox row keeps its body while the run that heard it is open.
      stored = await owner.inboxBody(940063);
    };
    expect(await owner.send(940062, { text: 'What is on today?' })).toBe('awaiting_delivery');
    expect(steered).toBe(200);
    expect(world.requests.some(request => request.includes('While you were working') && request.includes('Is this still good?'))).toBe(true);
    expect(stored).toContain('Is this still good?');
    expect(stored).toContain(CREDENTIAL_REPLY_TEXT);
    expect(stored).not.toContain(ticket);
    const sinks = await everywhere(owner.state, owner);
    for (const [sink, text] of Object.entries(sinks)) expect(text, sink).not.toContain(ticket);
  });
});

it('the link works once, at exactly ten minutes, and not a millisecond later', async () => {
  await telegramOwner('console-link-telegram-redeem', async owner => {
    expect(await owner.send(940021, { text: 'Can you send me my console link?' })).toBe('awaiting_delivery');
    const ticket = ticketOf(linkSends()[0]!.text);
    const grant = owner.state.storage.kv.get<{ expires: number }>('console:link')!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(grant.expires + 1);
    expect(await owner.redeem(ticket)).toBe(403);
    vi.setSystemTime(grant.expires);
    expect(await owner.redeem(ticket)).toBe(303);
    expect(await owner.redeem(ticket)).toBe(403);
  });
});

it.each([
  ['a forwarded request', { text: 'Please send me my console link', forward_origin: { type: 'user', date: 1, sender_user: { id: 99, is_bot: false } }, forward_date: 1 }],
  ['a quoted request', { text: 'Look: send me my console link', entities: [{ type: 'blockquote', offset: 6, length: 23 }] }],
  ['a request replying to someone else\'s message', { text: 'Send me my console link', reply_to_message: { message_id: 77, from: { id: 99, is_bot: false }, chat: { id: 42, type: 'private' }, date: 1, text: 'From Sam: use this' } }],
])('%s mints nothing, though the model asked for it', async (label, message) => {
  await telegramOwner(`console-link-telegram-${label.replaceAll(' ', '-').replaceAll('\'', '')}`, async owner => {
    expect(await owner.send(940031, message)).toBe('awaiting_delivery');
    expect(world.requests.join('\n')).toContain('send_console_link');
    expect(linkSends()).toEqual([]);
    expect(owner.state.storage.kv.get('console:link')).toBeUndefined();
    expect(prompts()).toMatch(/"sent":false,"reason":"(not_owner_typed|outside_content)"/);
  });
});

it('without a directory a turn keeps today\'s trace label: the fixture principal never names a Langfuse user', async () => {
  await telegramOwner('console-link-telegram-local', async owner => {
    expect(await owner.send(940041, { text: 'What is on today?' })).toBe('awaiting_delivery');
    expect(await owner.deliver(940041)).toBe('completed');
    const turn = () => spans().filter(span => span['langfuse.trace.metadata.trace_key'] === 'tg-940041');
    await vi.waitFor(() => expect(turn().map(span => span['langfuse.observation.metadata.hop'])).toContain('llm_reply'));
    expect(new Set(turn().map(span => span['langfuse.user.id']))).toEqual(new Set(['telegram:42']));
    expect(world.otlp.join('\n')).not.toContain('"key":"langfuse.user.id","value":{"stringValue":"prn_');
  }, false);
});
