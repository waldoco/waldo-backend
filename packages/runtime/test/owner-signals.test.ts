import { describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import type { OpenAIResponsesClient } from '../src/llm/openai';
import {
  handleOwnerSignal, localClock, MAX_PROACTIVE_TURNS_PER_DAY, NO_MESSAGE, nextLocalTime, proactiveInstruction,
  triggerEntry, type OwnerSignalEnv, type ProactiveTrigger,
} from '../src/channels/owner-signals';
import { ProactiveOwner, type ProactiveOwnerOptions } from '../src/channels/proactive-owner';
import { createTelegramResponder, type ProactiveTurn } from '../src/channels/telegram-turn';
import type { ConversationStore } from '../src/channels/conversation-store';

const SECRET = 'signal-secret-0123456789';
const KOLKATA = 'Asia/Kolkata';
// 2026-11-02 00:30 UTC = 06:00 in Kolkata.
const DAWN = Date.UTC(2026, 10, 2, 0, 30);
const MINUTE = 60_000;

const namespace = () => {
  const fetch = vi.fn(async () => new Response('ok'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};

const post = (body: string, secret: string | null = SECRET) => new Request('https://w.test/signals', {
  method: 'POST', body, headers: secret === null ? {} : { 'x-waldo-signal-secret': secret },
});

describe('handleOwnerSignal', () => {
  it('hands a verified, well-formed signal to the owner Durable Object and answers 202 at once', async () => {
    const { fetch, idFromName, ns } = namespace();
    const pending: Promise<unknown>[] = [];
    const env: OwnerSignalEnv = { TELEGRAM_OWNER_DO: ns, WALDO_OWNER_TELEGRAM_ID: '42', WALDO_SIGNAL_SECRET: SECRET };
    const response = await handleOwnerSignal(
      post(JSON.stringify({ kind: 'woke_up', context: { weather: '  Sunny ' } })), env, (work) => pending.push(work),
    );
    expect(response.status).toBe(202);
    await Promise.all(pending);
    expect(idFromName).toHaveBeenCalledWith('42');
    expect(fetch).toHaveBeenCalledWith('https://telegram-owner/signal', {
      method: 'POST', body: JSON.stringify({ kind: 'woke_up', context: { weather: 'Sunny' } }),
    });
  });

  it('rejects bad secrets, malformed or physiological payloads, and hides the route when unconfigured', async () => {
    const { fetch, ns } = namespace();
    const env: OwnerSignalEnv = { TELEGRAM_OWNER_DO: ns, WALDO_OWNER_TELEGRAM_ID: '42', WALDO_SIGNAL_SECRET: SECRET };
    const noop = () => undefined;
    const valid = JSON.stringify({ kind: 'woke_up' });
    expect((await handleOwnerSignal(post(valid, null), env, noop)).status).toBe(403);
    expect((await handleOwnerSignal(post(valid, `${SECRET}x`), env, noop)).status).toBe(403);
    expect((await handleOwnerSignal(post('{not json'), env, noop)).status).toBe(400);
    expect((await handleOwnerSignal(post(JSON.stringify({ kind: 'workout_ended', calories: 400 })), env, noop)).status).toBe(400);
    expect((await handleOwnerSignal(post('x'.repeat(300_000)), env, noop)).status).toBe(413);
    expect((await handleOwnerSignal(new Request('https://w.test/signals'), env, noop)).status).toBe(404);
    expect((await handleOwnerSignal(post(valid), { ...env, WALDO_SIGNAL_SECRET: undefined }, noop)).status).toBe(404);
    expect((await handleOwnerSignal(post(valid, 'short'), { ...env, WALDO_SIGNAL_SECRET: 'short' }, noop)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('local time', () => {
  it('reads the owner wall clock in their timezone', () => {
    expect(localClock(DAWN, KOLKATA)).toMatchObject({ date: '2026-11-02', time: '06:00', timeZone: KOLKATA });
    expect(localClock(DAWN, 'America/Los_Angeles')).toMatchObject({ date: '2026-11-01', time: '16:30' });
  });

  it('finds the next local deadline, rolling to tomorrow and across a DST change', () => {
    expect(nextLocalTime(DAWN, KOLKATA, '09:30')).toBe(Date.UTC(2026, 10, 2, 4, 0));
    expect(nextLocalTime(Date.UTC(2026, 10, 2, 5, 0), KOLKATA, '09:30')).toBe(Date.UTC(2026, 10, 3, 4, 0));
    // New York leaves daylight time on 2026-11-01: 09:30 is 13:30Z the day before, 14:30Z after.
    expect(nextLocalTime(Date.UTC(2026, 9, 31, 2, 0), 'America/New_York', '09:30')).toBe(Date.UTC(2026, 9, 31, 13, 30));
    expect(nextLocalTime(Date.UTC(2026, 9, 31, 20, 0), 'America/New_York', '09:30')).toBe(Date.UTC(2026, 10, 1, 14, 30));
  });
});

describe('proactive prompt', () => {
  const clock = localClock(DAWN, KOLKATA);

  it('keeps clock time out of the persisted entry but gives it to the model', () => {
    const wake: ProactiveTrigger = { kind: 'woke_up', context: { weather: 'Haze', calendar: '10:00 Design review' } };
    const entry = triggerEntry(wake);
    expect(entry).toContain('just woke up');
    expect(entry).toContain('Weather now: Haze');
    expect(entry).toContain('10:00 Design review');
    expect(entry).not.toContain('06:00');
    const instruction = proactiveInstruction(wake, clock);
    expect(instruction).toContain('06:00');
    expect(instruction).toContain(NO_MESSAGE);
  });

  it('frames each moment for the model', () => {
    expect(proactiveInstruction({ kind: 'workout_ended' }, clock)).toMatch(/No calorie/);
    expect(proactiveInstruction({ kind: 'meeting_notes', notes: 'x' }, clock)).toMatch(/moved/);
    expect(proactiveInstruction({ kind: 'winding_down' }, clock)).toMatch(/end-of-day/);
    expect(triggerEntry({ kind: 'meeting_notes', title: 'Investor call', notes: '- Send deck' })).toContain('- Send deck');
  });
});

type Reply = string | null | Error;

const harness = (overrides: Partial<ProactiveOwnerOptions> = {}, replies: Reply[] = []) => {
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  let now = DAWN;
  const turns: ProactiveTurn[] = [];
  const sent: string[] = [];
  const committed: string[] = [];
  const logs: object[] = [];
  const owner = new ProactiveOwner({
    storage: {
      get: (async (key: string) => kv.get(key)) as DurableObjectStorage['get'],
      put: (async (key: string, value: unknown) => { kv.set(key, value); }) as DurableObjectStorage['put'],
      getAlarm: async () => alarm,
    },
    arm: async (at) => { alarm = at; },
    responder: {
      async proactive(turn) {
        turns.push(turn);
        const reply = replies.length > 0 ? replies.shift() as Reply : 'Morning! Design review at 10.';
        if (reply instanceof Error) throw reply;
        if (reply === null) return null;
        return { text: reply, commit: async () => { committed.push(turn.id); } };
      },
    },
    send: async (text) => { sent.push(text); },
    ownerChatId: 42,
    timeZone: KOLKATA,
    morningDeadline: '09:30',
    now: () => now,
    log: (entry) => logs.push(entry),
    ...overrides,
  });
  return {
    owner, turns, sent, committed, logs,
    get alarm() { return alarm; },
    at(ms: number) { now = ms; },
  };
};

describe('ProactiveOwner', () => {
  it('sends a good-morning message when the watch reports wake-up, once per day', async () => {
    const h = harness();
    expect(await h.owner.handle({ kind: 'woke_up' })).toBe('sent');
    expect(h.sent).toEqual(['Morning! Design review at 10.']);
    expect(h.committed).toHaveLength(1);
    expect(h.turns[0]).toMatchObject({ chatId: 42 });
    expect(h.turns[0]?.instruction).toContain('06:00');

    h.at(DAWN + 20 * MINUTE);
    expect(await h.owner.handle({ kind: 'woke_up' })).toBe('already_handled');
    expect(h.turns).toHaveLength(1);
  });

  it('stays quiet when the model decides nothing is worth saying, and does not ask again', async () => {
    const h = harness({}, [null]);
    expect(await h.owner.handle({ kind: 'winding_down' })).toBe('quiet');
    expect(h.sent).toEqual([]);
    expect(h.committed).toEqual([]);
    expect(await h.owner.handle({ kind: 'winding_down' })).toBe('already_handled');
    expect(h.turns).toHaveLength(1);
  });

  it('falls back to the morning deadline only when no wake-up signal arrived', async () => {
    const quietMorning = harness();
    await quietMorning.owner.ensureArmed();
    expect(quietMorning.alarm).toBe(Date.UTC(2026, 10, 2, 4, 0));
    quietMorning.at(Date.UTC(2026, 10, 2, 4, 0));
    await quietMorning.owner.onAlarm();
    expect(quietMorning.turns[0]?.entryText).toContain('No wake-up signal');
    expect(quietMorning.sent).toHaveLength(1);
    expect(quietMorning.alarm).toBe(Date.UTC(2026, 10, 3, 4, 0));

    const earlyRiser = harness();
    await earlyRiser.owner.handle({ kind: 'woke_up' });
    earlyRiser.at(Date.UTC(2026, 10, 2, 4, 0));
    await earlyRiser.owner.onAlarm();
    expect(earlyRiser.turns).toHaveLength(1);
    expect(earlyRiser.alarm).toBe(Date.UTC(2026, 10, 3, 4, 0));

    const lateWake = harness();
    lateWake.at(Date.UTC(2026, 10, 2, 4, 0));
    await lateWake.owner.onAlarm();
    lateWake.at(Date.UTC(2026, 10, 2, 5, 0));
    expect(await lateWake.owner.handle({ kind: 'woke_up' })).toBe('already_handled');
    expect(lateWake.sent).toHaveLength(1);
  });

  it('does nothing before the deadline and needs a timezone to hold one', async () => {
    const early = harness();
    await early.owner.onAlarm();
    expect(early.turns).toEqual([]);
    expect(early.alarm).toBe(Date.UTC(2026, 10, 2, 4, 0));

    const noZone = harness({ timeZone: null });
    await noZone.owner.ensureArmed();
    await noZone.owner.onAlarm();
    expect(noZone.alarm).toBeNull();
    expect(await noZone.owner.handle({ kind: 'workout_ended', activity: 'Run' })).toBe('sent');
  });

  it('retries a failed morning brief later without marking it done', async () => {
    const h = harness({}, [new Error('provider down')]);
    h.at(Date.UTC(2026, 10, 2, 4, 0));
    await h.owner.onAlarm();
    expect(h.sent).toEqual([]);
    expect(h.alarm).toBe(Date.UTC(2026, 10, 2, 4, 15));
    expect(h.logs).toContainEqual(expect.objectContaining({ outcome: 'failed', error: 'provider down' }));

    h.at(Date.UTC(2026, 10, 2, 4, 15));
    await h.owner.onAlarm();
    expect(h.sent).toHaveLength(1);
    expect(h.alarm).toBe(Date.UTC(2026, 10, 3, 4, 0));
  });

  it('does not record a delivered message when sending fails', async () => {
    const h = harness({ send: async () => { throw new Error('telegram down'); } });
    expect(await h.owner.handle({ kind: 'woke_up' })).toBe('failed');
    expect(h.committed).toEqual([]);
  });

  it('bounds model calls per day, including failed ones, and resets the next day', async () => {
    const h = harness({}, Array.from({ length: MAX_PROACTIVE_TURNS_PER_DAY }, () => new Error('down')));
    for (let i = 0; i < MAX_PROACTIVE_TURNS_PER_DAY; i += 1) {
      expect(await h.owner.handle({ kind: 'meeting_notes', notes: `note ${i}` })).toBe('failed');
    }
    expect(await h.owner.handle({ kind: 'meeting_notes', notes: 'one more' })).toBe('daily_cap');
    expect(h.turns).toHaveLength(MAX_PROACTIVE_TURNS_PER_DAY);

    h.at(DAWN + 24 * 60 * MINUTE);
    expect(await h.owner.handle({ kind: 'meeting_notes', notes: 'one more' })).toBe('sent');
  });

  it('handles each meeting note once, by id or by content', async () => {
    const h = harness();
    expect(await h.owner.handle({ kind: 'meeting_notes', id: 'n1', notes: 'a' })).toBe('sent');
    expect(await h.owner.handle({ kind: 'meeting_notes', id: 'n1', notes: 'a, edited' })).toBe('already_handled');
    expect(await h.owner.handle({ kind: 'meeting_notes', notes: 'b' })).toBe('sent');
    expect(await h.owner.handle({ kind: 'meeting_notes', notes: 'b' })).toBe('already_handled');
    expect(await h.owner.handle({ kind: 'meeting_notes', notes: 'c' })).toBe('sent');
  });
});

describe('telegram responder proactive turns', () => {
  const fakeModel = (replies: string[]) => {
    const inputs: Array<{ instructions: string; input: string }> = [];
    const client = {
      responses: {
        create: async (body: { instructions: string; input: string }) => {
          inputs.push(body);
          return { id: `resp_${inputs.length}`, output_text: replies.shift() ?? 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    } as unknown as OpenAIResponsesClient;
    return { client, inputs };
  };
  const memoryStore = () => {
    const saved: ConversationEntry[] = [];
    const store: ConversationStore = {
      load: async () => ({ entries: [], leafId: null }),
      save: async (entries) => { saved.push(...entries); },
    };
    return { store, saved };
  };
  const turn = (id: string, instruction: string): ProactiveTurn => ({
    id,
    chatId: 42,
    entryText: triggerEntry({
      kind: 'woke_up',
      context: { weather: 'Light rain, 14°C', calendar: '10:00 Design review\n15:00 Investor call with Priya' },
    }),
    instruction,
  });

  it('keeps a delivered proactive message in the conversation so the owner can reply to it', async () => {
    const model = fakeModel(['Morning! Design review at 10.', 'Moved it to 11.']);
    const { store, saved } = memoryStore();
    const responder = createTelegramResponder('test-key', store, undefined, undefined, model.client);
    const reply = await responder.proactive(turn('a', 'PROACTIVE-INSTRUCTION'));
    expect(reply?.text).toBe('Morning! Design review at 10.');
    expect(model.inputs[0]?.instructions).toContain('PROACTIVE-INSTRUCTION');
    expect(model.inputs[0]?.input).toContain('15:00 Investor call with Priya');
    await reply!.commit();
    expect(saved.map((entry) => entry.id)).toEqual(['signal-a', 'signal-a-reply']);

    await responder.respond(
      { updateId: 7, chatId: 42, senderId: 42, messageId: 1, text: 'Can we push it an hour?', sentAt: null },
      async (_hop, work) => work(),
    );
    expect(model.inputs[1]?.input).toContain('Morning! Design review at 10.');
    expect(model.inputs[1]?.instructions).not.toContain('PROACTIVE-INSTRUCTION');
  });

  it('returns null and persists nothing when the model chooses silence', async () => {
    const model = fakeModel([NO_MESSAGE]);
    const { store, saved } = memoryStore();
    const responder = createTelegramResponder('test-key', store, undefined, undefined, model.client);
    expect(await responder.proactive(turn('b', 'x'))).toBeNull();
    expect(saved).toEqual([]);
  });
});
