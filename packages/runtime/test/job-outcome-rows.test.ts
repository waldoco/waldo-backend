import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { localIso } from '../src/channels/reminders';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { MAIL_ONLY_GOOGLE } from './helpers/google-grant';

// A job's prompt is the job's own working material: it stays out of the owner's chain, and the chain keeps one compact
// outcome row per job, so a day of cards costs later turns only what the owner was actually sent.
const CARD_TEXT = 'Your morning is clear until noon.';
const REPLY_TEXT = 'Noted.';
const model = vi.hoisted(() => ({ requests: [] as string[], fail: false }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    model.requests.push(JSON.stringify(request.request));
    if (model.fail) throw new Error('synthetic provider outage');
    const text = model.requests.length === 1 ? CARD_TEXT : REPLY_TEXT;
    return { ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

beforeEach(() => {
  model.requests = []; model.fail = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read' || fn === 'assert_channel_presence') return Response.json(fn === 'assert_channel_presence' ? true : null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
const withAppOwner = async <T>(name: string, switches: Readonly<Record<string, string>>, run: (owner: () => Owner, state: DurableObjectState) => Promise<T>): Promise<T> => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (instance, state) => {
    const poolAlarm = vi.spyOn(instance as InstanceType<typeof OwnerDO>, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    state.storage.kv.put('timezone_confirmed', true);
    await state.storage.put('google:accounts', MAIL_ONLY_GOOGLE);
    const make = () => new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, ...switches, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
    let current = make();
    try { return await run(() => current, state); } finally { await state.storage.deleteAlarm(); poolAlarm.mockRestore(); void (current = make()); }
  });
};

const dueBrief = async (state: DurableObjectState, at = Date.now() - 60_000) => {
  dayPlanBook(state.storage.sql).save(localIso(Date.now(), 'UTC').slice(0, 10), { card: 'card:brief', time: '00:00', reason: 'planned' });
  await new Scheduler(state.storage.sql, state.storage, productionDeps())
    .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: at, dueAt: at, recurrence: null });
};
// The opening of the job's own text as the model received it: the last user message of the first model call.
const jobPrompt = (request: string) => {
  const messages = (JSON.parse(request) as { messages: { role: string; content: unknown }[] }).messages;
  const last = [...messages].reverse().find(message => message.role === 'user')!.content;
  // As it would sit inside a stored JSON value.
  return JSON.stringify((typeof last === 'string' ? last : JSON.stringify(last)).slice(0, 300)).slice(1, -1);
};
// Every stored copy in the owner object: KV values and the rows of every table it can read.
const storedText = (state: DurableObjectState) => {
  const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
  return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
};
// The owner's chain as stored: its rows and their episode index.
const chainText = (state: DurableObjectState) => [
  ...[...state.storage.kv.list({ prefix: 'canonical-owner-v1:' })].map(([key, value]) => `${key} ${JSON.stringify(value)}`),
  ...state.storage.sql.exec("SELECT * FROM sqlite_master WHERE name = 'episodes'").toArray().length
    ? state.storage.sql.exec('SELECT * FROM episodes').toArray().map(row => JSON.stringify(row)) : [],
].join('\n');
const appChat = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
  expect(response.status).toBe(200);
  return (await response.json() as { messages: { role: string; text: string }[] }).messages.map(({ role, text }) => ({ role, text }));
};
const ownerSays = async (owner: Owner, name: string, clientId: string, text: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST',
    headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ client_message_id: clientId, text }) }));
  expect(sent.status).toBe(202);
  await vi.waitFor(async () => expect((await appChat(owner, name)).filter(message => message.text === REPLY_TEXT)).toHaveLength(1), { timeout: 10_000, interval: 20 });
};
const ON = { WALDO_JOB_OUTCOME_ROWS: '1' } as const;

describe('a background job leaves its outcome in the owner\'s chain, never its prompt', () => {
  it('a day card on a chain with no history adds one outcome row the owner can read, and no stored copy of its prompt', async () => {
    const name = 'job-outcome-golden';
    await withAppOwner(name, ON, async (owner, state) => {
      await dueBrief(state);
      await owner().alarm();
      expect(await appChat(owner(), name)).toEqual([{ role: 'assistant', text: CARD_TEXT }]);
      expect(storedText(state)).not.toContain(jobPrompt(model.requests[0]!));
      // Done-when for this step: a day of cards adds under 2k tokens (~8k characters) to the chain. One card stays inside a third.
      const chain = chainText(state);
      expect(chain).toContain(CARD_TEXT);
      expect(chain.length).toBeLessThan(8_000 / 3);
    });
  });

  it('the owner\'s next turn reads the card it was sent, not the card\'s prompt', async () => {
    const name = 'job-outcome-next-turn';
    await withAppOwner(name, ON, async (owner, state) => {
      await dueBrief(state);
      await owner().alarm();
      await ownerSays(owner(), name, 'outcome-next-0001', 'Thanks, anything else today?');
      const next = model.requests.at(-1)!;
      expect(next).toContain(CARD_TEXT);
      expect(next).not.toContain(jobPrompt(model.requests[0]!));
    });
  });

  it('a job retried after a crash, with the same id and text, replays its saved outcome and asks no model again', async () => {
    const name = 'job-outcome-replay';
    await withAppOwner(name, ON, async (owner) => {
      type Host = Readonly<{ setup(channel: 'app'): Readonly<{ owner: number; macFollowup: (...args: unknown[]) => Promise<string> }>; asOwnerJob<T>(job: string, key: string, work: () => Promise<T>): Promise<T> }>;
      const host = owner() as unknown as Host, runtime = host.setup('app');
      const job = 'Report this Mac result briefly: the export finished.';
      // A retried turn runs as the owner job the jobs lane admits, under the id of the turn it retries.
      const run = () => host.asOwnerJob('retry_turn', 'retry:replay-1', () => runtime.macFollowup('retry:replay-1', runtime.owner, job, async (_hop: string, work: () => Promise<unknown>) => work()));
      expect(await run()).toBe(CARD_TEXT);
      const calls = model.requests.length;
      expect(await run()).toBe(CARD_TEXT);
      expect(model.requests.length).toBe(calls);
    });
  });

  it('a card whose model call fails leaves nothing in the chain', async () => {
    const name = 'job-outcome-failed';
    await withAppOwner(name, ON, async (owner, state) => {
      model.fail = true;
      await dueBrief(state);
      await owner().alarm().catch(() => undefined);
      expect(await appChat(owner(), name)).toEqual([]);
      expect(storedText(state)).not.toContain(jobPrompt(model.requests[0]!));
    });
  });

  it('with the switch off, a day card is stored as it was before: its prompt as a row under the card', async () => {
    const name = 'job-outcome-off';
    await withAppOwner(name, {}, async (owner, state) => {
      await dueBrief(state);
      await owner().alarm();
      expect(chainText(state)).toContain(jobPrompt(model.requests[0]!));
    });
  });
});
