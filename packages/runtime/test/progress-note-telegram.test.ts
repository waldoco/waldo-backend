import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { claimStore } from '../src/memory/claims';
import { persistInboxWake } from '../src/scheduler/alarm-slot';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// A directory-backed Telegram owner asks for a long errand. The scripted model posts one progress note, then answers. The
// note leaves while the turn runs, straight to the chat; the reply leaves later, on the alarm that drains the final outbox.
const NOTE = 'Found two hotels under budget near the station; checking reviews on a third.';
const world = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], sends: [] as { text: string; chat?: number }[], next: 500, final: 'Here are three hotels near the station.' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    if (request.response_format) return { ok: true as const, data: { model: request.model, text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    world.requests.push(request);
    const first = !request.tool_turns?.length;
    return { ok: true as const, data: { model: request.model, text: first ? '' : world.final, ...(first ? { tool_calls: [{ call_id: 'note-1', name: 'send_progress_note', arguments: JSON.stringify({ text: NOTE }) }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: { chat_id?: number; text?: string }) => {
  if (method === 'getMe') return { username: 'fixture_bot' };
  if (method !== 'sendMessage') return true;
  const message_id = world.next++;
  world.sends.push({ text: body.text ?? '', chat: body.chat_id });
  return { message_id, chat: { id: body.chat_id, type: 'private' }, text: body.text };
} }));
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5c2e66cc-bab5-47a4-83f9-5d8fde89849c';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  world.requests = []; world.sends = []; world.final = 'Here are three hotels near the station.';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'common_owner_authority') return Response.json({ admission_revision: '5', auth_user_id: OWNER_ID, do_name: asked.p_do_name, owner_id: OWNER_ID, presence_id: '0d6b1f22-9c4e-4a7b-8e21-5f3a9c7d1b44', provider: asked.p_provider, state_version: 1, subject: asked.p_subject });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

type Owner = Readonly<{ send(update: number, text: string): Promise<string | undefined>; deliver(update: number): Promise<string | undefined>; state: DurableObjectState; logged(): string }>;
const telegramOwner = (name: string, run: (owner: Owner) => Promise<void>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  await state.storage.put({ telegram_subject: '42', do_name: name, origin: 'https://waldo.fixture.invalid' });
  const lines: unknown[][] = [];
  const spies = (['log', 'error', 'warn', 'info'] as const).map(level => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args); }));
  // No Langfuse keys: text capture is off, as in production.
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7.fixture', TELEGRAM_WEBHOOK_SECRET: 'synthetic-inbox-secret', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
  const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
  const stateOf = async (update: number) => (await inbox.records()).find(row => row.updateId === update)?.state;
  try {
    await run({
      state,
      send: async (update, text) => {
        await inbox.admit({ bot: '7.fixture', subject: '42', doName: name }, update, JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text } }));
        await (owner as unknown as { drainInbox(): Promise<void> }).drainInbox();
        return stateOf(update);
      },
      deliver: async update => {
        const now = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        for (let pass = 1; pass <= 4 && await stateOf(update) !== 'completed'; pass++) { vi.setSystemTime(now + pass * 1_000); await owner.alarm(); }
        return stateOf(update);
      },
      logged: () => JSON.stringify(lines),
    });
  } finally { for (const spy of spies) spy.mockRestore(); await state.storage.deleteAlarm(); }
});
const stored = (state: DurableObjectState) => {
  const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
  return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
};

it('the note reaches the Telegram chat while the turn runs, before the reply leaves', async () => {
  await telegramOwner('progress-note-telegram-order', async owner => {
    expect(await owner.send(950001, 'Find me a hotel near the station for Friday.')).toBe('awaiting_delivery');
    expect(world.requests[0]!.tools?.map(tool => tool.name)).toContain('send_progress_note');
    // The turn has finished thinking; only the note has reached the chat so far.
    expect(world.sends).toEqual([{ text: NOTE, chat: 42 }]);
    expect(JSON.stringify(world.requests[1]!.tool_turns)).toContain('\\"sent\\":true');
    expect(await owner.deliver(950001)).toBe('completed');
    expect(world.sends.map(sent => sent.text)).toEqual([NOTE, world.final]);
  });
});

it('the note is not the reply and is kept out of storage, logs and traces', async () => {
  await telegramOwner('progress-note-telegram-privacy', async owner => {
    expect(await owner.send(950011, 'Find me a hotel near the station for Friday.')).toBe('awaiting_delivery');
    expect(await owner.deliver(950011)).toBe('completed');
    expect(world.sends.map(sent => sent.text)).toEqual([NOTE, world.final]);
    // The scan is not vacuous: the reply itself is stored as the turn's answer.
    const everything = stored(owner.state);
    expect(everything).toContain(world.final);
    expect(owner.state.storage.sql.exec("SELECT hop FROM trace_log WHERE hop IN ('progress_note', 'tool_send_progress_note')").toArray().map(row => row.hop).sort()).toEqual(['progress_note', 'tool_send_progress_note']);
    for (const [sink, text] of Object.entries({ stored: everything, logs: owner.logged() })) expect(text, sink).not.toContain('hotels under budget');
  });
});

it('a turn whose final reply is empty is not answered by its note', async () => {
  await telegramOwner('progress-note-telegram-empty', async owner => {
    world.final = '';
    expect(await owner.send(950021, 'Find me a hotel near the station for Friday.')).toBe('quarantined');
    expect(world.sends[0]).toEqual({ text: NOTE, chat: 42 });
    expect(stored(owner.state)).not.toContain('hotels under budget');
    // A quarantined turn is not retried: later alarms neither deliver a reply nor send the note again.
    expect(await owner.deliver(950021)).toBe('quarantined');
    expect(world.sends.filter(sent => sent.text === NOTE)).toHaveLength(1);
  });
});
