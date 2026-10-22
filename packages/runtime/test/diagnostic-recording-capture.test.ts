import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAGNOSTIC_RECORDING_WORDING } from '../src/identity/diagnostic-recording';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { consoleAccess } from '../src/channels/console';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { claimStore } from '../src/memory/claims';
import { persistInboxWake } from '../src/scheduler/alarm-slot';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// Staging exports a Telegram owner's turn to Langfuse. Message text rides that export only while the environment allows
// capture AND the owner's directory record holds a live agreement to the current wording; the agreement is read at the
// start of each turn, and anything short of a clear yes exports no text.
const world = vi.hoisted(() => ({ otlp: [] as string[], reads: 0, agreement: undefined as unknown, hang: false, writes: [] as Record<string, unknown>[], write: 'ok' as 'ok' | 'refused' | 'outage' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    if (request.response_format) return { ok: true as const, data: { model: request.model, text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    return { ok: true as const, data: { model: request.model, text: 'Noted, I will keep an eye on it.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: { chat_id?: number; text?: string }) => {
  if (method === 'getMe') return { username: 'fixture_bot' };
  if (method !== 'sendMessage') return true;
  return { message_id: 700, chat: { id: body.chat_id, type: 'private' }, text: body.text };
} }));
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const MESSAGE = 'My sleep felt short and my head is foggy this morning';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const langfuse = { LANGFUSE_PUBLIC_KEY: 'pk-fixture', LANGFUSE_SECRET_KEY: 'sk-fixture', LANGFUSE_BASE_URL: 'https://langfuse.fixture.invalid', LANGFUSE_CAPTURE_TEXT: 'true' };
const agreed = { agreed: true, version: DIAGNOSTIC_RECORDING_WORDING.version, agreed_at: '2026-10-22T09:00:00.000Z' };
const declined = { agreed: false, version: null, agreed_at: null };

beforeEach(() => {
  world.otlp = []; world.reads = 0; world.agreement = declined; world.hang = false; world.writes = []; world.write = 'ok';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(langfuse.LANGFUSE_BASE_URL)) { world.otlp.push(String(init?.body ?? '')); return new Response('{}', { status: 200 }); }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'diagnostic_recording_state') {
      world.reads++;
      if (world.hang) return new Promise<Response>(() => undefined);
      return world.agreement === 'outage' ? Response.json({ code: 'XX000', message: 'down' }, { status: 503 }) : Response.json(world.agreement);
    }
    if (fn === 'set_diagnostic_recording') {
      world.writes.push(asked);
      if (world.write === 'outage') return Response.json({ code: 'XX000', message: 'down' }, { status: 503 });
      if (world.write === 'refused') return Response.json(false);
      world.agreement = asked.p_agreed ? { agreed: true, version: asked.p_version, agreed_at: '2026-10-22T09:00:00.000Z' } : declined;
      return Response.json(true);
    }
    if (fn === 'console_session_list') return Response.json([]);
    if (fn === 'common_owner_authority') return Response.json({ admission_revision: '5', auth_user_id: OWNER_ID, do_name: asked.p_do_name, owner_id: OWNER_ID, presence_id: '0d6b1f22-9c4e-4a7b-8e21-5f3a9c7d1b44', provider: asked.p_provider, state_version: 1, subject: asked.p_subject });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

type Control = Readonly<{ state: string; recorded_here: boolean; version: string; label: string; detail: string }>;
type Owner = Readonly<{ turn(update: number): Promise<void>; traces(): string; control(): Promise<Control | undefined>; choose(value: string, request: string): Promise<{ status: number; receipt?: { state: string; message: string } }> }>;
const telegramOwner = (name: string, environment: string, run: (owner: Owner) => Promise<void>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  await state.storage.put({ telegram_subject: '42', do_name: name, origin: 'https://waldo.fixture.invalid' });
  const spies = (['log', 'error', 'warn', 'info'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
  const owner = new OwnerDO(state, { ...env, ...directory, ...langfuse, WALDO_ENVIRONMENT: environment, TELEGRAM_BOT_TOKEN: '7.fixture', TELEGRAM_WEBHOOK_SECRET: 'synthetic-inbox-secret', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
  const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
  const token = await consoleAccess(state.storage).grant();
  const read = async () => (await (await owner.fetch(new Request(`https://telegram-owner${CONTROLS_PATH}?view=day`, { headers: { cookie: `waldo_console=${token}` } }))).json()) as { csrf: string; revision: string; data: { diagnostic_recording?: Control } };
  try {
    await run({
      control: async () => (await read()).data.diagnostic_recording,
      choose: async (value, request) => {
        const before = await read();
        const response = await owner.fetch(new Request(`https://telegram-owner${CONTROL_ACTION_PATH}`, { method: 'POST', headers: { cookie: `waldo_console=${token}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf: before.csrf, revision: before.revision, view: 'day', action: 'diagnostic_recording.set', value, request_id: request }) }));
        return { status: response.status, ...(await response.json() as { receipt?: { state: string; message: string } }) };
      },
      turn: async update => {
        await inbox.admit({ bot: '7.fixture', subject: '42', doName: name }, update, JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text: MESSAGE } }));
        await (owner as unknown as { drainInbox(): Promise<void> }).drainInbox();
        // The final reply settles on the alarm, which logs the root hop that exports the turn.
        const now = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        for (let pass = 1; pass <= 4 && (await inbox.records()).find(row => row.updateId === update)?.state !== 'completed'; pass++) { vi.setSystemTime(now + pass * 1_000); await owner.alarm(); }
        vi.useRealTimers();
        await vi.waitFor(() => expect(spansOf(update).map(span => span['langfuse.observation.metadata.hop'])).toContain('llm_reply'));
      },
      traces: () => JSON.stringify(state.storage.sql.exec('SELECT * FROM trace_log').toArray()),
    });
  } finally { for (const spy of spies) spy.mockRestore(); await state.storage.deleteAlarm(); }
});
const spansOf = (update: number) => world.otlp.flatMap(body => (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: { attributes: { key: string; value: { stringValue?: string } }[] }[] }[] }[] })
  .resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans.map(span => Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value.stringValue]))))))
  .filter(span => span['langfuse.trace.metadata.trace_key'] === `tg-${update}`);
const textKeys = ['langfuse.trace.input', 'langfuse.trace.output', 'langfuse.observation.input', 'langfuse.observation.output'];
const carriesText = (update: number) => spansOf(update).some(span => textKeys.some(key => span[key] !== undefined));
const exportedMessage = (update: number) => JSON.stringify(spansOf(update)).includes(MESSAGE);

describe('diagnostic recording decides whether staging exports a turn\'s text', () => {
  it('exports the text of an owner who agreed to the current wording', async () => {
    world.agreement = agreed;
    await telegramOwner('diagnostic-agreed', 'staging', async owner => {
      await owner.turn(960001);
      expect(carriesText(960001)).toBe(true);
      expect(exportedMessage(960001)).toBe(true);
      expect(world.reads).toBeGreaterThan(0);
    });
  });

  it('exports no text for an owner who never agreed, though the staging switch is on', async () => {
    world.agreement = declined;
    await telegramOwner('diagnostic-unticked', 'staging', async owner => {
      await owner.turn(960011);
      expect(spansOf(960011).length).toBeGreaterThan(0);
      expect(carriesText(960011)).toBe(false);
      expect(exportedMessage(960011)).toBe(false);
      expect(owner.traces()).not.toContain(MESSAGE);
    });
  });

  it('stops exporting text from the next turn once the owner withdraws, in the same object', async () => {
    world.agreement = agreed;
    await telegramOwner('diagnostic-withdrawn', 'staging', async owner => {
      await owner.turn(960021);
      expect(carriesText(960021)).toBe(true);
      world.agreement = { ...declined };
      await owner.turn(960022);
      expect(carriesText(960022)).toBe(false);
      expect(exportedMessage(960022)).toBe(false);
    });
  });

  it('exports no text when the agreement cannot be read, and does not fall back to an earlier yes', async () => {
    world.agreement = agreed;
    await telegramOwner('diagnostic-outage', 'staging', async owner => {
      await owner.turn(960031);
      expect(carriesText(960031)).toBe(true);
      world.agreement = 'outage';
      await owner.turn(960032);
      expect(carriesText(960032)).toBe(false);
      world.agreement = { surprise: true };
      await owner.turn(960033);
      expect(carriesText(960033)).toBe(false);
    });
  });

  it('exports no text when the directory does not answer in time', async () => {
    world.hang = true;
    await telegramOwner('diagnostic-hang', 'staging', async owner => {
      await owner.turn(960041);
      expect(carriesText(960041)).toBe(false);
    });
  });

  it('exports no text for an agreement to older wording', async () => {
    world.agreement = { ...agreed, version: 'beta-2026-01-01' };
    await telegramOwner('diagnostic-old-wording', 'staging', async owner => {
      await owner.turn(960051);
      expect(carriesText(960051)).toBe(false);
    });
  });

  it('never exports text in production, even for an owner who agreed, and does not ask the directory', async () => {
    world.agreement = agreed;
    await telegramOwner('diagnostic-production', 'production', async owner => {
      await owner.turn(960061);
      expect(carriesText(960061)).toBe(false);
      expect(exportedMessage(960061)).toBe(false);
      expect(world.reads).toBe(0);
    });
  });
});

describe('the console control for diagnostic recording', () => {
  it('starts off for an existing owner, shows the wording, and turns on and off against the directory', async () => {
    await telegramOwner('diagnostic-console', 'staging', async owner => {
      expect(await owner.control()).toEqual({ state: 'off', recorded_here: true, ...DIAGNOSTIC_RECORDING_WORDING });
      const on = await owner.choose('on', 'diagnostic-request-01');
      expect(on).toMatchObject({ status: 200, receipt: { state: 'recorded' } });
      expect(world.writes.at(-1)).toMatchObject({ p_agreed: true, p_version: DIAGNOSTIC_RECORDING_WORDING.version, p_source: 'console', p_do_name: 'diagnostic-console' });
      expect((await owner.control())?.state).toBe('on');
      await owner.turn(960071);
      expect(carriesText(960071)).toBe(true);
      const off = await owner.choose('off', 'diagnostic-request-02');
      expect(off).toMatchObject({ status: 200, receipt: { state: 'recorded' } });
      expect(off.receipt?.message).toContain('woof@heywaldo.in');
      expect(world.writes.at(-1)).toMatchObject({ p_agreed: false, p_source: 'console' });
      expect((await owner.control())?.state).toBe('off');
      await owner.turn(960072);
      expect(carriesText(960072)).toBe(false);
    });
  });

  it('shows unknown, not off, when the directory cannot be read', async () => {
    world.agreement = 'outage';
    await telegramOwner('diagnostic-console-unknown', 'staging', async owner => {
      expect((await owner.control())?.state).toBe('unknown');
    });
  });

  it('says so when the directory refuses or cannot confirm a change, and refuses an unknown value', async () => {
    await telegramOwner('diagnostic-console-refused', 'staging', async owner => {
      world.write = 'refused';
      expect(await owner.choose('on', 'diagnostic-request-11')).toMatchObject({ status: 409, receipt: { state: 'rejected' } });
      world.write = 'outage';
      expect(await owner.choose('on', 'diagnostic-request-12')).toMatchObject({ status: 503, receipt: { state: 'unconfirmed' } });
      world.write = 'ok';
      expect(await owner.choose('always', 'diagnostic-request-13')).toMatchObject({ status: 409, receipt: { state: 'rejected' } });
      expect(world.writes.map(write => write.p_agreed)).toEqual([true, true]);
      expect((await owner.control())?.state).toBe('off');
    });
  });

  it('says where text is never recorded, whatever the owner chooses', async () => {
    await telegramOwner('diagnostic-console-production', 'production', async owner => {
      expect((await owner.control())?.recorded_here).toBe(false);
    });
  });
});
