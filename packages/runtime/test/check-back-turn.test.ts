import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { HEARTBEAT_ID } from '../src/channels/heartbeat';
import { traceBook } from '../src/channels/harness';
import { loopBook } from '../src/channels/loops';
import { reminderBook } from '../src/channels/reminders';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// A due check-back is a fresh machine turn: the model reads the current state with read tools and decides what, if anything,
// to say. The stored note or loop title is context for that turn, never the message.
const NOTE = 'check whether the launch email draft exists';
const LOOP_TITLE = 'check back on the launch email';
const FOUND = 'I looked: no launch email draft yet.';
type Call = Readonly<{ call_id: string; name: string; arguments: string }>;
// script decides each round: the calls to make, or the reply once tools have run.
const fixture = vi.hoisted(() => ({
  requests: [] as LLMGatewayRequest['request'][],
  script: undefined as ((request: LLMGatewayRequest['request'], asked: string) => { text: string; calls?: Call[] }) | undefined,
}));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    fixture.requests.push(request);
    const done = (text: string, tool_calls?: Call[]) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls?.length ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    const step = fixture.script?.(request, asked) ?? { text: 'SKIP' };
    return done(step.text, step.calls);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway as never; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7d5e6f70-8a9b-4cad-9e0f-2a3b4c5d6e7f';
const PRESENCE_ID = '8e6f7081-9bac-4dbe-8f10-3b4c5d6e7f80';
const AT = Date.parse('2026-10-03T09:00:00Z');
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { authority: 'current' as 'current' | 'revoked', sent: [] as string[] };
const clock = { now: AT };

beforeEach(() => {
  fixture.requests = []; fixture.script = undefined; wire.authority = 'current'; wire.sent = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'common_owner_authority') return Response.json(wire.authority === 'revoked' ? null : { owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name,
      presence_id: PRESENCE_ID, provider: asked.p_provider, subject: asked.p_subject, state_version: 1, admission_revision: '3' });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/.test(url)) {
      wire.sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return Response.json({ ok: true, result: { message_id: 40 + wire.sent.length, chat: { id: 7 } } });
    }
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: true });
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; alarm(): Promise<void>; serial(work: () => Promise<void>): Promise<void> }>;
const withOwner = async (name: string, run: (owner: Owner, state: DurableObjectState) => Promise<void>) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const originalNow = Date.now;
    clock.now = AT;
    Date.now = () => clock.now;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
      state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' }) as unknown as Owner;
      await owner.setup('telegram').ready;
      await owner.serial(async () => undefined);
      state.storage.sql.exec('DELETE FROM schedule');
      fixture.requests = []; wire.sent = [];
      await run(owner, state);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};
const schedulePass = async (owner: Owner, state: DurableObjectState) => { state.storage.kv.put('owner_alarm_last_v1', 1); await owner.alarm(); };
// The outbox holds a fresh record a moment before sending it.
const transportPass = async (owner: Owner, state: DurableObjectState) => { clock.now += 1000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); };
const outbox = (state: DurableObjectState) => state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? [];
const dueReminder = (state: DurableObjectState) => reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: () => new Date(AT - 3_600_000) }, () => 'rem-1')
  .set({ note: NOTE, at: new Date(AT - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
const dueLoop = (state: DurableObjectState) => {
  const loop = loopBook(state.storage.sql, { now: () => AT - 3_600_000, newId: () => 'launch' }).open({ title: LOOP_TITLE, due: '2026-10-03T08:30' });
  return loop;
};
const dueHeartbeat = (state: DurableObjectState) => new Scheduler(state.storage.sql, state.storage, productionDeps())
  .schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', payloadRefs: { id: HEARTBEAT_ID }, occurrenceAt: AT - 1000, dueAt: AT - 1000, recurrence: null });
const offered = (request: LLMGatewayRequest['request']) => (request.tools ?? []).map(tool => tool.name);
const checkBackRequests = () => fixture.requests.filter(request => !request.response_format);
// A first round that reads, then a reply that reports what the read found.
const looksThen = (reply: string, extra: (asked: string) => Call[] = () => []) => (request: LLMGatewayRequest['request'], asked: string) =>
  request.tool_turns?.length ? { text: reply } : { text: '', calls: [{ call_id: 'look', name: 'get_context', arguments: '{}' }, ...extra(asked)] };

describe('a due reminder runs a fresh check-back turn', () => {
  it('reads the current state with read-only tools and sends what it found, not the stored note', async () => {
    await withOwner('check-back-reminder', async (owner, state) => {
      await dueReminder(state);
      fixture.script = looksThen(FOUND);
      await schedulePass(owner, state);
      const [first, second] = checkBackRequests();
      expect(first!.messages.at(-1)!.content).toContain(NOTE);
      expect(first!.messages.at(-1)!.content).not.toContain('Send the reminder briefly');
      expect(offered(first!)).toEqual(expect.arrayContaining(['get_context', 'read_memory', 'search_episodes']));
      for (const effect of ['send_email', 'draft_email', 'set_reminder', 'open_loop', 'remember', 'browse_act']) expect(offered(first!)).not.toContain(effect);
      expect(second!.tool_turns?.map(turn => turn.call.name)).toEqual(['get_context']);
      await transportPass(owner, state);
      expect(wire.sent).toEqual([FOUND]);
    });
  });

  it('can end silent when the model decides nothing needs saying, and never falls back to the note', async () => {
    await withOwner('check-back-reminder-silent', async (owner, state) => {
      const reminder = await dueReminder(state);
      fixture.script = looksThen('SKIP');
      await schedulePass(owner, state);
      await transportPass(owner, state);
      expect(wire.sent).toEqual([]);
      expect(outbox(state)).toEqual([]);
      expect(state.storage.sql.exec('SELECT 1 FROM reminder_notes WHERE id = ?', reminder.id).toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT status, summary FROM background_runs WHERE kind = 'reminder'").toArray()).toEqual([{ status: 'completed', summary: 'reminder checked; nothing to send' }]);
      expect(state.storage.sql.exec("SELECT outcome FROM schedule_runs WHERE kind = 'reminder'").toArray()).toEqual([{ outcome: 'ok' }]);
    });
  });

  it('a blank model reply fails the attempt for the scheduler to retry, and never sends the stored note', async () => {
    await withOwner('check-back-reminder-empty', async (owner, state) => {
      await dueReminder(state);
      fixture.script = looksThen(' ');
      await schedulePass(owner, state);
      await transportPass(owner, state);
      expect(wire.sent).toEqual([]);
      expect(outbox(state)).toEqual([]);
      expect(state.storage.sql.exec("SELECT outcome FROM schedule_runs WHERE kind = 'reminder'").toArray()).toEqual([{ outcome: 'failed' }]);
    });
  });

  it('a reminder the owner cancels after the turn queued its reply is never sent', async () => {
    await withOwner('check-back-reminder-cancelled', async (owner, state) => {
      const reminder = await dueReminder(state);
      fixture.script = looksThen(FOUND);
      await schedulePass(owner, state);
      expect(outbox(state).map(record => record.payload.text)).toEqual([FOUND]);
      await reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: () => new Date(AT) }, () => 'x').cancel(reminder.id);
      await transportPass(owner, state);
      expect(wire.sent).toEqual([]);
      expect(state.storage.sql.exec("SELECT status FROM background_runs WHERE kind = 'reminder'").toArray()).toEqual([{ status: 'stopped' }]);
    });
  });

  it('a reminder cancelled before it is due never runs a turn', async () => {
    await withOwner('check-back-reminder-cancelled-early', async (owner, state) => {
      const reminder = await dueReminder(state);
      await reminderBook(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { timezone: 'UTC', now: () => new Date(AT) }, () => 'x').cancel(reminder.id);
      fixture.script = looksThen(FOUND);
      await schedulePass(owner, state);
      await transportPass(owner, state);
      expect(checkBackRequests()).toEqual([]);
      expect(wire.sent).toEqual([]);
    });
  });

  it('a revoked owner\'s check-back runs no turn and sends nothing', async () => {
    await withOwner('check-back-reminder-revoked', async (owner, state) => {
      await dueReminder(state);
      wire.authority = 'revoked';
      fixture.script = looksThen(FOUND);
      await schedulePass(owner, state);
      await transportPass(owner, state);
      expect(checkBackRequests()).toEqual([]);
      expect(wire.sent).toEqual([]);
    });
  });
});

describe('a past-due loop Waldo took on runs a fresh check-back turn from the heartbeat', () => {
  it('the turn reads, may close the loop, and its reply is what goes out instead of the stored title list', async () => {
    await withOwner('check-back-loop', async (owner, state) => {
      const loop = dueLoop(state);
      await dueHeartbeat(state);
      fixture.script = looksThen(FOUND, () => [{ call_id: 'close', name: 'close_loop', arguments: JSON.stringify({ id: loop.id, outcome: 'done' }) }]);
      await schedulePass(owner, state);
      const [first] = checkBackRequests();
      expect(first!.messages.at(-1)!.content).toContain(LOOP_TITLE);
      expect(first!.messages.at(-1)!.content).toContain(loop.id);
      expect(offered(first!)).toEqual(expect.arrayContaining(['get_context', 'read_memory', 'close_loop']));
      for (const effect of ['send_email', 'set_reminder', 'open_loop', 'remember']) expect(offered(first!)).not.toContain(effect);
      expect(state.storage.sql.exec('SELECT status FROM loops WHERE id = ?', loop.id).toArray()).toEqual([{ status: 'done' }]);
      await transportPass(owner, state);
      expect(wire.sent).toEqual([FOUND]);
      expect(wire.sent.join('\n')).not.toContain('From your list');
      expect(state.storage.sql.exec("SELECT delivery FROM schedule_runs WHERE kind = 'heartbeat'").toArray()).toEqual([{ delivery: 'sent' }]);
    });
  });

  it('a check-back whose subject is resolved can end silent, and the next tick does not ask again inside the cooldown', async () => {
    await withOwner('check-back-loop-silent', async (owner, state) => {
      const loop = dueLoop(state);
      await dueHeartbeat(state);
      fixture.script = looksThen('SKIP');
      await schedulePass(owner, state);
      await transportPass(owner, state);
      expect(wire.sent).toEqual([]);
      expect(outbox(state)).toEqual([]);
      expect(state.storage.sql.exec('SELECT status FROM loops WHERE id = ?', loop.id).toArray()).toEqual([{ status: 'open' }]);
      expect(state.storage.sql.exec("SELECT heartbeat_result FROM schedule_runs WHERE kind = 'heartbeat'").toArray()).toEqual([{ heartbeat_result: 'quiet' }]);
      fixture.requests = [];
      await dueHeartbeat(state);
      await schedulePass(owner, state);
      expect(checkBackRequests()).toEqual([]);
    });
  });

  it('a loop the owner drops after the turn queued its reply is never sent', async () => {
    await withOwner('check-back-loop-cancelled', async (owner, state) => {
      const loop = dueLoop(state);
      await dueHeartbeat(state);
      fixture.script = looksThen(FOUND);
      await schedulePass(owner, state);
      expect(outbox(state).map(record => record.payload.text)).toEqual([FOUND]);
      loopBook(state.storage.sql, { now: () => AT, newId: () => 'x' }).close(loop.id, 'dropped');
      await transportPass(owner, state);
      expect(wire.sent).toEqual([]);
    });
  });

  it('a revoked owner\'s heartbeat runs no check-back turn', async () => {
    await withOwner('check-back-loop-revoked', async (owner, state) => {
      dueLoop(state);
      await dueHeartbeat(state);
      wire.authority = 'revoked';
      fixture.script = looksThen(FOUND);
      await schedulePass(owner, state);
      await transportPass(owner, state);
      expect(checkBackRequests()).toEqual([]);
      expect(wire.sent).toEqual([]);
    });
  });
});
