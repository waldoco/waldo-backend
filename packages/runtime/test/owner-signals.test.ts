import { describe, expect, it, vi } from 'vitest';
import type { ConversationEntry, OwnerSignal } from '@waldo/contracts';
import type { OpenAIResponsesClient } from '../src/llm/openai';
import {
  handleOwnerSignal, localClock, MAX_PROACTIVE_TURNS_PER_DAY, NO_MESSAGE, nextLocalTime, parseReply, proactiveInstruction,
  triggerEntry, type OwnerSignalEnv, type ProactiveTrigger,
} from '../src/channels/owner-signals';
import { MAX_PENDING_CHECK_BACKS, ProactiveOwner, type ProactiveOwnerOptions } from '../src/channels/proactive-owner';
import { createTelegramResponder, type ProactiveTurn } from '../src/channels/telegram-turn';
import type { ConversationStore } from '../src/channels/conversation-store';

const SECRET = 'signal-secret-0123456789';
const KOLKATA = 'Asia/Kolkata';
// 2026-11-02 00:30 UTC = 06:00 in Kolkata.
const DAWN = Date.UTC(2026, 10, 2, 0, 30);
// 09:30 Kolkata on 2026-11-02 and 2026-11-03.
const DEADLINE = Date.UTC(2026, 10, 2, 4, 0);
const NEXT_DEADLINE = Date.UTC(2026, 10, 3, 4, 0);
const MINUTE = 60_000;

const signal = (value: OwnerSignal): ProactiveTrigger => ({ origin: 'signal', signal: value });
const WAKE = signal({ source: 'health', event: 'woke_up' });

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
      post(JSON.stringify({ source: 'Location', event: 'arrived', detail: '  School gate ' })), env, (work) => pending.push(work),
    );
    expect(response.status).toBe(202);
    await Promise.all(pending);
    expect(idFromName).toHaveBeenCalledWith('42');
    expect(fetch).toHaveBeenCalledWith('https://telegram-owner/signal', {
      method: 'POST', body: JSON.stringify({ source: 'location', event: 'arrived', detail: 'School gate' }),
    });
  });

  it('rejects bad secrets, malformed or physiological payloads, and hides the route when unconfigured', async () => {
    const { fetch, ns } = namespace();
    const env: OwnerSignalEnv = { TELEGRAM_OWNER_DO: ns, WALDO_OWNER_TELEGRAM_ID: '42', WALDO_SIGNAL_SECRET: SECRET };
    const noop = () => undefined;
    const valid = JSON.stringify({ source: 'health', event: 'woke_up' });
    expect((await handleOwnerSignal(post(valid, null), env, noop)).status).toBe(403);
    expect((await handleOwnerSignal(post(valid, `${SECRET}x`), env, noop)).status).toBe(403);
    expect((await handleOwnerSignal(post('{not json'), env, noop)).status).toBe(400);
    expect((await handleOwnerSignal(post(JSON.stringify({ source: 'health', event: 'workout_ended', calories: 400 })), env, noop)).status).toBe(400);
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

  it('finds the next local time, rolling to tomorrow and across a DST change', () => {
    expect(nextLocalTime(DAWN, KOLKATA, '09:30')).toBe(DEADLINE);
    expect(nextLocalTime(Date.UTC(2026, 10, 2, 5, 0), KOLKATA, '09:30')).toBe(NEXT_DEADLINE);
    // New York leaves daylight time on 2026-11-01: 09:30 is 13:30Z the day before, 14:30Z after.
    expect(nextLocalTime(Date.UTC(2026, 9, 31, 2, 0), 'America/New_York', '09:30')).toBe(Date.UTC(2026, 9, 31, 13, 30));
    expect(nextLocalTime(Date.UTC(2026, 9, 31, 20, 0), 'America/New_York', '09:30')).toBe(Date.UTC(2026, 10, 1, 14, 30));
  });
});

describe('proactive prompt', () => {
  it('describes any moment with its detail and context, without clock time', () => {
    const entry = triggerEntry(signal({
      source: 'calendar', event: 'meeting_moved', detail: 'Investor call moved from 15:00 to 17:00',
      context: { weather: 'Haze', notes: 'Bring Q3 numbers' },
    }));
    expect(entry).toContain('Signal from calendar: meeting_moved');
    expect(entry).toContain('Investor call moved from 15:00 to 17:00');
    expect(entry).toContain('weather:\nHaze');
    expect(entry).toContain('Bring Q3 numbers');
    expect(triggerEntry(WAKE)).toContain('just woke up');
    expect(triggerEntry(WAKE)).not.toMatch(/\d/);
    expect(triggerEntry(signal({ source: 'health', event: 'workout_ended', activity: 'Swim' }))).toContain('Activity: Swim.');
    expect(triggerEntry({ origin: 'check_back', id: 'c', why: 'did the notes arrive?' })).toContain('did the notes arrive?');
    expect(triggerEntry({ origin: 'morning_deadline' })).toContain('No wake-up signal');
  });

  it('gives the model the local time, the silence option and the check-back protocol', () => {
    const instruction = proactiveInstruction(localClock(DAWN, KOLKATA));
    expect(instruction).toContain('06:00');
    expect(instruction).toContain(NO_MESSAGE);
    expect(instruction).toContain('CHECK_BACK HH:MM');
  });

  it('separates the message from check-back requests', () => {
    expect(parseReply('Morning!\nCHECK_BACK 17:45 see whether the investor notes arrived')).toEqual({
      message: 'Morning!', checkBacks: [{ at: '17:45', why: 'see whether the investor notes arrived' }],
    });
    expect(parseReply(`${NO_MESSAGE}\nCHECK_BACK: 08:05 remind about pickup`)).toEqual({
      message: null, checkBacks: [{ at: '08:05', why: 'remind about pickup' }],
    });
    expect(parseReply(` ${NO_MESSAGE} `)).toEqual({ message: null, checkBacks: [] });
    expect(parseReply('CHECK_BACK 25:00 nope')).toEqual({ message: 'CHECK_BACK 25:00 nope', checkBacks: [] });
  });
});

type Reply = string | Error;

const harness = (overrides: Partial<ProactiveOwnerOptions> = {}, replies: Reply[] = []) => {
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  let now = DAWN;
  let ids = 0;
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
        return { text: reply, commit: async () => { committed.push(turn.id); } };
      },
    },
    send: async (text) => { sent.push(text); },
    ownerChatId: 42,
    timeZone: KOLKATA,
    morningDeadline: '09:30',
    now: () => now,
    log: (entry) => logs.push(entry),
    newId: () => `id-${(ids += 1)}`,
    ...overrides,
  });
  return {
    owner, turns, sent, committed, logs,
    get alarm() { return alarm; },
    at(ms: number) { now = ms; },
  };
};

describe('ProactiveOwner', () => {
  it('responds to moments from any part of anyone\'s day', async () => {
    const h = harness({}, ['Pickup is in 20 min, traffic is heavy.', NO_MESSAGE, 'Gate change: B12.']);
    expect(await h.owner.handle(signal({ source: 'location', event: 'left', detail: 'Left the office' }))).toBe('sent');
    expect(await h.owner.handle(signal({ source: 'focus', event: 'driving_on' }))).toBe('quiet');
    expect(await h.owner.handle(signal({ source: 'airline', event: 'gate_changed', detail: 'BA142 now B12' }))).toBe('sent');
    expect(h.sent).toEqual(['Pickup is in 20 min, traffic is heavy.', 'Gate change: B12.']);
    expect(h.committed).toEqual(['id-1', 'id-3']);
    expect(h.turns[0]?.entryText).toContain('Signal from location: left');
    expect(h.turns[0]?.instruction).toContain('06:00');
  });

  it('handles the wake-up once per day and stays quiet when the model says so', async () => {
    const h = harness();
    expect(await h.owner.handle(WAKE)).toBe('sent');
    h.at(DAWN + 20 * MINUTE);
    expect(await h.owner.handle(WAKE)).toBe('already_handled');
    expect(h.turns).toHaveLength(1);

    const quiet = harness({}, [NO_MESSAGE]);
    expect(await quiet.owner.handle(signal({ source: 'health', event: 'wind_down' }))).toBe('quiet');
    expect(quiet.sent).toEqual([]);
    expect(await quiet.owner.handle(signal({ source: 'health', event: 'wind_down' }))).toBe('already_handled');
  });

  it('dedupes by sender id, or by content within the hour', async () => {
    const h = harness();
    const note = { source: 'granola', event: 'note_ready', id: 'n1', detail: 'a' } as const;
    expect(await h.owner.handle(signal(note))).toBe('sent');
    expect(await h.owner.handle(signal({ ...note, detail: 'a, edited' }))).toBe('already_handled');
    const mail = signal({ source: 'mail', event: 'received', detail: 'Invoice from Acme' });
    expect(await h.owner.handle(mail)).toBe('sent');
    expect(await h.owner.handle(mail)).toBe('already_handled');
    h.at(DAWN + 61 * MINUTE);
    expect(await h.owner.handle(mail)).toBe('sent');
  });

  it('lets the model schedule its own check-back and runs it when due', async () => {
    const h = harness({}, [
      'Good morning.',
      'Your investor call moved to 17:00.\nCHECK_BACK 18:15 see whether the call notes arrived',
      'No notes yet from the investor call. Want me to draft the follow-up anyway?',
    ]);
    await h.owner.handle(WAKE);
    expect(h.alarm).toBe(NEXT_DEADLINE);
    await h.owner.handle(signal({ source: 'calendar', event: 'meeting_moved', detail: 'Investor call 15:00 -> 17:00' }));
    expect(h.sent).toEqual(['Good morning.', 'Your investor call moved to 17:00.']);
    expect(h.logs).toContainEqual(expect.objectContaining({ outcome: 'sent', check_backs: 1 }));
    // 18:15 Kolkata = 12:45Z, earlier than tomorrow's deadline, so it owns the alarm.
    const checkAt = Date.UTC(2026, 10, 2, 12, 45);
    expect(h.alarm).toBe(checkAt);

    h.at(checkAt);
    await h.owner.onAlarm();
    expect(h.turns[2]?.entryText).toContain('see whether the call notes arrived');
    expect(h.sent).toHaveLength(3);
    expect(h.alarm).toBe(NEXT_DEADLINE);

    await h.owner.onAlarm();
    expect(h.turns).toHaveLength(3);
  });

  it('can stay quiet now and still look again later', async () => {
    const h = harness({}, [`${NO_MESSAGE}\nCHECK_BACK 08:00 nudge about leaving for the airport`]);
    expect(await h.owner.handle(signal({ source: 'calendar', event: 'flight_tomorrow' }))).toBe('quiet');
    // 08:00 Kolkata comes before the 09:30 deadline.
    expect(h.alarm).toBe(Date.UTC(2026, 10, 2, 2, 30));
  });

  it('bounds pending check-backs and needs a timezone to hold them', async () => {
    const many = Array.from({ length: MAX_PENDING_CHECK_BACKS + 2 }, (_, i) => `CHECK_BACK 2${i % 4}:0${i} look ${i}`).join('\n');
    const h = harness({}, [`Hi\n${many}`]);
    await h.owner.handle(signal({ source: 'test', event: 'burst' }));
    expect(h.logs).toContainEqual(expect.objectContaining({ check_backs: MAX_PENDING_CHECK_BACKS }));
    expect(h.logs).toContainEqual(expect.objectContaining({ outcome: 'check_back_dropped', reason: 'too_many_pending' }));

    const noZone = harness({ timeZone: null }, ['Hi\nCHECK_BACK 18:00 later']);
    expect(await noZone.owner.handle(signal({ source: 'test', event: 'x' }))).toBe('sent');
    expect(noZone.logs).toContainEqual(expect.objectContaining({ outcome: 'check_back_dropped', reason: 'no_timezone' }));
    expect(noZone.alarm).toBeNull();
  });

  it('falls back to the morning deadline only when no wake-up signal arrived', async () => {
    const quietMorning = harness();
    await quietMorning.owner.ensureArmed();
    expect(quietMorning.alarm).toBe(DEADLINE);
    quietMorning.at(DEADLINE);
    await quietMorning.owner.onAlarm();
    expect(quietMorning.turns[0]?.entryText).toContain('No wake-up signal');
    expect(quietMorning.alarm).toBe(NEXT_DEADLINE);

    const earlyRiser = harness();
    await earlyRiser.owner.handle(WAKE);
    earlyRiser.at(DEADLINE);
    await earlyRiser.owner.onAlarm();
    expect(earlyRiser.turns).toHaveLength(1);

    const lateWake = harness();
    lateWake.at(DEADLINE);
    await lateWake.owner.onAlarm();
    lateWake.at(DEADLINE + 60 * MINUTE);
    expect(await lateWake.owner.handle(WAKE)).toBe('already_handled');
    expect(lateWake.sent).toHaveLength(1);

    const beforeDeadline = harness();
    await beforeDeadline.owner.onAlarm();
    expect(beforeDeadline.turns).toEqual([]);
    const nightShift = harness({ morningDeadline: null }, ['Good evening. Handover at 19:30.\nCHECK_BACK 19:10 remind to leave']);
    await nightShift.owner.ensureArmed();
    expect(nightShift.alarm).toBeNull();
    nightShift.at(DEADLINE);
    await nightShift.owner.onAlarm();
    expect(nightShift.turns).toEqual([]);
    // Wakes at 18:40 local before a night shift: the wake-up is their "morning".
    nightShift.at(Date.UTC(2026, 10, 2, 13, 10));
    expect(await nightShift.owner.handle(WAKE)).toBe('sent');
    expect(nightShift.alarm).toBe(Date.UTC(2026, 10, 2, 13, 40));
  });

  it('retries a failed morning brief and does not record undelivered messages', async () => {
    const h = harness({}, [new Error('provider down')]);
    h.at(DEADLINE);
    await h.owner.onAlarm();
    expect(h.sent).toEqual([]);
    expect(h.alarm).toBe(DEADLINE + 15 * MINUTE);
    expect(h.logs).toContainEqual(expect.objectContaining({ outcome: 'failed', error: 'provider down' }));
    h.at(DEADLINE + 15 * MINUTE);
    await h.owner.onAlarm();
    expect(h.sent).toHaveLength(1);

    const sendFails = harness({ send: async () => { throw new Error('telegram down'); } });
    expect(await sendFails.owner.handle(WAKE)).toBe('failed');
    expect(sendFails.committed).toEqual([]);
  });

  it('bounds model calls per day, including failed ones and check-backs, and resets the next day', async () => {
    const h = harness({}, Array.from({ length: MAX_PROACTIVE_TURNS_PER_DAY }, () => new Error('down')));
    for (let i = 0; i < MAX_PROACTIVE_TURNS_PER_DAY; i += 1) {
      expect(await h.owner.handle(signal({ source: 'mail', event: 'received', detail: `mail ${i}` }))).toBe('failed');
    }
    expect(await h.owner.handle(signal({ source: 'mail', event: 'received', detail: 'one more' }))).toBe('daily_cap');
    expect(h.turns).toHaveLength(MAX_PROACTIVE_TURNS_PER_DAY);
    h.at(DAWN + 24 * 60 * MINUTE);
    expect(await h.owner.handle(signal({ source: 'mail', event: 'received', detail: 'one more' }))).toBe('sent');
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

  it('keeps a delivered proactive message in the conversation so the owner can reply to it', async () => {
    const model = fakeModel(['Morning! Design review at 10.', 'Moved it to 11.']);
    const saved: ConversationEntry[] = [];
    const store: ConversationStore = {
      load: async () => ({ entries: [], leafId: null }),
      save: async (entries) => { saved.push(...entries); },
    };
    const responder = createTelegramResponder('test-key', store, undefined, undefined, model.client);
    const reply = await responder.proactive({
      id: 'a',
      chatId: 42,
      entryText: triggerEntry(signal({
        source: 'health', event: 'woke_up',
        context: { weather: 'Light rain, 14°C', calendar: '10:00 Design review\n15:00 Investor call with Priya' },
      })),
      instruction: 'PROACTIVE-INSTRUCTION',
    });
    expect(reply.text).toBe('Morning! Design review at 10.');
    expect(model.inputs[0]?.instructions).toContain('PROACTIVE-INSTRUCTION');
    expect(model.inputs[0]?.input).toContain('15:00 Investor call with Priya');
    await reply.commit();
    expect(saved.map((entry) => entry.id)).toEqual(['signal-a', 'signal-a-reply']);

    await responder.respond(
      { updateId: 7, chatId: 42, senderId: 42, messageId: 1, text: 'Can we push it an hour?', sentAt: null },
      async (_hop, work) => work(),
    );
    expect(model.inputs[1]?.input).toContain('Morning! Design review at 10.');
    expect(model.inputs[1]?.instructions).not.toContain('PROACTIVE-INSTRUCTION');
  });
});
