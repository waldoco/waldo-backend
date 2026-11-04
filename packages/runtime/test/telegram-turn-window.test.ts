// A Telegram owner turn runs for minutes, like an app or iMessage turn, and still ends inside the alarm handler that runs it.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { ALARM_JOB_MIN_MS, ALARM_TURN_BUDGET_MS, ALARM_TURN_MIN_MS, RUN_CLOSE_MARGIN_MS, toolRoundsFor, TOOL_ROUNDS_CEILING, turnDeadlineFor } from '../src/llm/time-budget';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const SUBJECT = '81301';
const ALARM_WALL_MS = 15 * 60_000;

const claimedTurn = async (name: string) => {
  let seen: { scope: RunEffectScope; at: number } | undefined;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const instance = new OwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: '123456:fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-inbox-secret', OPENAI_API_KEY: 'fictional-model-key',
    });
    const drain = instance as unknown as { drainInbox(): Promise<void>; turn(update: unknown, channel: string, durable: boolean, scope?: RunEffectScope): Promise<void> };
    vi.spyOn(drain, 'turn').mockImplementation(async (_update, _channel, _durable, scope) => { if (scope) seen = { scope, at: Date.now() }; });
    const response = await instance.fetch(new Request('https://telegram-owner/enqueue', {
      method: 'POST',
      headers: { 'x-waldo-inbox-secret': 'fictional-inbox-secret', 'x-waldo-telegram-subject': SUBJECT, 'x-waldo-do-name': name },
      body: JSON.stringify({ update_id: 7101, message: { message_id: 1, date: 1, from: { id: Number(SUBJECT), is_bot: false, first_name: 'T' }, chat: { id: Number(SUBJECT), type: 'private' }, text: 'Work through my week and draft the replies.' } }),
    }));
    expect(response.status).toBe(200);
    await drain.drainInbox();
    await state.storage.deleteAlarm();
  });
  if (!seen) throw new Error('the Telegram turn never ran under a run scope');
  return seen;
};

describe('a Telegram owner turn', () => {
  it('gets minutes to work, not two', async () => {
    const { scope, at } = await claimedTurn('telegram-turn-window');
    const turnTime = turnDeadlineFor(scope, at) - at;
    expect(turnTime).toBeGreaterThanOrEqual(13 * 60_000);
    expect(toolRoundsFor(turnTime)).toBe(TOOL_ROUNDS_CEILING);
  });

  it('closes its run before the alarm handler that runs it is stopped', async () => {
    const { scope, at } = await claimedTurn('telegram-turn-ceiling');
    expect(scope.deadline - at).toBeLessThan(ALARM_WALL_MS);
    expect(scope.deadline - turnDeadlineFor(scope, at)).toBe(RUN_CLOSE_MARGIN_MS);
  });
});

// One alarm invocation runs the app drain before the Telegram drain; the app turn here takes the given time.
type OwnerInternals = {
  drainApp(alarmEnd?: number): Promise<void>; drainIMessage(alarmEnd?: number): Promise<void>;
  turn(update: unknown, channel: string, durable: boolean, scope?: RunEffectScope): Promise<void>;
  serial<T>(work: () => Promise<T>): Promise<T>;
  setup(): { scheduler: { hasDue(): boolean; dispatchDue(executors: unknown, canStart?: () => boolean): Promise<readonly unknown[]> } };
};
const ownerIn = (state: DurableObjectState, name: string) => new OwnerDO(state, {
  ...env, TELEGRAM_BOT_TOKEN: '123456:fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-inbox-secret', OPENAI_API_KEY: 'fictional-model-key',
}) as unknown as OwnerInternals & { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };

// One alarm invocation runs the app drain before the Telegram drain and the scheduler; the app turn here takes the given
// time. With `telegram`, a Telegram row waits; otherwise a scheduled job is due.
const alarmAfterAppTurn = async (name: string, appTurnMs: number, telegram = true) => {
  let seen: { scope: RunEffectScope; at: number } | undefined;
  let alarmStart = 0, rowState: string | undefined, armed: number | null = null;
  const drainEnds: Array<number | undefined> = [];
  let jobMayStart: boolean | undefined;
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
      const owner = ownerIn(state, name);
      vi.spyOn(owner, 'drainApp').mockImplementation(async (end) => { drainEnds.push(end); vi.setSystemTime(Date.now() + appTurnMs); });
      vi.spyOn(owner, 'drainIMessage').mockImplementation(async (end) => { drainEnds.push(end); });
      vi.spyOn(owner, 'turn').mockImplementation(async (_update, _channel, _durable, scope) => { if (scope) seen = { scope, at: Date.now() }; });
      if (telegram) {
        const response = await owner.fetch(new Request('https://telegram-owner/enqueue', {
          method: 'POST',
          headers: { 'x-waldo-inbox-secret': 'fictional-inbox-secret', 'x-waldo-telegram-subject': SUBJECT, 'x-waldo-do-name': name },
          body: JSON.stringify({ update_id: 7102, message: { message_id: 2, date: 1, from: { id: Number(SUBJECT), is_bot: false, first_name: 'T' }, chat: { id: Number(SUBJECT), type: 'private' }, text: 'Draft the replies.' } }),
        }));
        expect(response.status).toBe(200);
      } else {
        const { scheduler } = owner.setup();
        vi.spyOn(scheduler, 'hasDue').mockReturnValue(true);
        vi.spyOn(scheduler, 'dispatchDue').mockImplementation(async (_executors, canStart) => { jobMayStart = canStart?.(); return []; });
      }
      alarmStart = Date.now();
      await owner.alarm();
      rowState = (state.storage.kv.get<Array<{ updateId: number; state: string }>>('telegram_owner_inbox_v1') ?? []).find(row => row.updateId === 7102)?.state;
      armed = await state.storage.getAlarm();
      await state.storage.deleteAlarm();
    });
  } finally { vi.useRealTimers(); }
  return { seen, alarmStart, rowState, armed, drainEnds, jobMayStart };
};

describe('a Telegram owner turn after an app turn in the same alarm', () => {
  it('gets only what is left of the alarm budget', async () => {
    const { seen, alarmStart } = await alarmAfterAppTurn('telegram-turn-after-app', 10 * 60_000);
    expect(seen).toBeDefined();
    expect(seen!.scope.deadline).toBeLessThanOrEqual(alarmStart + ALARM_TURN_BUDGET_MS);
    expect(seen!.scope.deadline - seen!.at).toBeGreaterThan(3 * 60_000);
  });

  it('hands the alarm budget to the app and iMessage drains it runs', async () => {
    const { alarmStart, drainEnds } = await alarmAfterAppTurn('telegram-turn-drain-ends', 0);
    expect(drainEnds).toEqual([alarmStart + ALARM_TURN_BUDGET_MS, alarmStart + ALARM_TURN_BUDGET_MS]);
  });

  it('starts a scheduled job only with time for its turn left in the alarm', async () => {
    expect((await alarmAfterAppTurn('alarm-job-in-time', 60_000, false)).jobMayStart).toBe(true);
    expect((await alarmAfterAppTurn('alarm-job-too-late', ALARM_TURN_BUDGET_MS - ALARM_JOB_MIN_MS + 1_000, false)).jobMayStart).toBe(false);
  });

  it('waits for a fresh alarm when too little of the budget is left', async () => {
    const { seen, alarmStart, rowState, armed } = await alarmAfterAppTurn('telegram-turn-deferred', ALARM_TURN_BUDGET_MS - ALARM_TURN_MIN_MS + 1_000);
    expect(seen).toBeUndefined();
    expect(rowState).toBe('admitted');
    expect(armed).not.toBeNull();
    expect(armed!).toBeLessThanOrEqual(alarmStart + ALARM_TURN_BUDGET_MS);
  });
});

describe('an alarm queued behind a turn a request started', () => {
  it('gives up its place before its budget runs out, runs none of its lanes, and leaves a fresh alarm armed', async () => {
    let done = false, appDrains = 0, armed: number | null = null;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('alarm-behind-request-turn')), async (_instance, state) => {
        const owner = ownerIn(state, 'alarm-behind-request-turn');
        vi.spyOn(owner, 'drainApp').mockImplementation(async () => { appDrains += 1; });
        const response = await owner.fetch(new Request('https://telegram-owner/enqueue', {
          method: 'POST',
          headers: { 'x-waldo-inbox-secret': 'fictional-inbox-secret', 'x-waldo-telegram-subject': SUBJECT, 'x-waldo-do-name': 'alarm-behind-request-turn' },
          body: JSON.stringify({ update_id: 7104, message: { message_id: 4, date: 1, from: { id: Number(SUBJECT), is_bot: false, first_name: 'T' }, chat: { id: Number(SUBJECT), type: 'private' }, text: 'Book it.' } }),
        }));
        expect(response.status).toBe(200);
        await state.storage.deleteAlarm();
        let release!: () => void;
        const requestTurn = owner.serial(() => new Promise<void>(resolve => { release = resolve; }));
        const pass = owner.alarm().then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(ALARM_TURN_BUDGET_MS);
        expect(done).toBe(true);
        armed = await state.storage.getAlarm();
        expect((state.storage.kv.get<Array<{ updateId: number; state: string }>>('telegram_owner_inbox_v1') ?? []).find(row => row.updateId === 7104)?.state).toBe('admitted');
        release(); await requestTurn; await pass;
        await vi.advanceTimersByTimeAsync(0);
        await state.storage.deleteAlarm();
      });
    } finally { vi.useRealTimers(); }
    expect(appDrains).toBe(0);
    expect(armed).not.toBeNull();
  });
});
