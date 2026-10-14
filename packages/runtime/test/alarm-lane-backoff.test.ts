import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { alarmPass, alarmRetryDelay, armAlarm, persistInboxWake, persistTransportWake, rearmSharedAlarm, WAKE_DUE_KEYS } from '../src/scheduler/alarm-slot';
import { HEARTBEAT_EVERY_MS } from '../src/channels/heartbeat';
import { TelegramFinalOutbox } from '../src/channels/telegram-final-outbox';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { LINK_MODE, TelegramLinkInbox } from '../src/channels/telegram-link-inbox';

// Per-lane backoff on workerd's own alarm scheduler. This pool binds a Telegram token and a model key, so a pass that
// holds one lane gets through the owner runtime to the others. Sends are recorded here and model calls are refused.
const sent = vi.hoisted(() => [] as { chat_id: number; text: string }[]);
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, payload: { chat_id: number; text: string }) => {
    if (method === 'sendMessage') sent.push(payload);
    return { message_id: sent.length, chat: { id: payload.chat_id } };
  } }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('lane fixture forbids model calls'); } }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');
type Lanes = { alarm(info?: AlarmInvocationInfo): Promise<void>; drainApp(): Promise<void>; drainInbox(): Promise<void> };
type Owner = Lanes & { ctx: DurableObjectState };
const proto = OwnerDO.prototype as unknown as Lanes;
const real = { alarm: proto.alarm, drainApp: proto.drainApp, drainInbox: proto.drainInbox };
// The spies sit on the prototype, so each test acts only on its own owner; any other owner's pass runs the real code.
const idOf = (name: string) => env.OWNER_DO!.idFromName(name).toString();
const lane = (method: 'drainApp' | 'drainInbox', name: string, ...steps: ((owner: Owner) => Promise<void>)[]) => {
  const ran: number[] = [], id = idOf(name);
  const spy = vi.spyOn(proto, method).mockImplementation(async function (this: Owner) {
    if (this.ctx.id.toString() !== id) return real[method].call(this);
    ran.push(Date.now());
    return steps[Math.min(ran.length, steps.length) - 1]!(this);
  });
  return { ran, restore: () => spy.mockRestore() };
};
const fails = async () => { throw new Error('synthetic lane failure'); };
const consumesInbound = async (owner: Owner) => { owner.ctx.storage.kv.delete('telegram_owner_inbox_v1'); owner.ctx.storage.kv.delete('telegram_owner_inbox_due_v1'); };
const FAILURES = 'owner_alarm_failures_v1', LANE = 'owner_alarm_failed_lane_v1', RETRY_DUE = 'owner_alarm_retry_due_v1';
const BOT = env.TELEGRAM_BOT_TOKEN!.split(':')[0]!;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (done: () => boolean | Promise<boolean>, withinMs: number) => {
  const deadline = Date.now() + withinMs;
  while (!await done() && Date.now() < deadline) await sleep(25);
};
const record = (state: DurableObjectState) => ({ streak: state.storage.kv.get(FAILURES), lane: state.storage.kv.get(LANE), retryDue: state.storage.kv.get<number>(RETRY_DUE) });
const reply = (doName: string, text: string, subject: string) =>
  ({ id: `reply:${text}`, trace: `reply:${text}`, payload: { chat_id: Number(subject), text }, bot: BOT, ownerSubject: subject, doName });
// A streak a real run can't reach in a test, as a failed pass leaves it: the count, the lane and the retry.
const streak = (state: DurableObjectState, count: number, lane: string, retryDue: number) => {
  state.storage.kv.put(FAILURES, count); state.storage.kv.put(LANE, lane); state.storage.kv.put(RETRY_DUE, retryDue);
};

// Records when each pass starts and the platform's retry count for it; a firstPass replaces the first pass, for one that
// dies. Every key and the alarm go before the spies do, so no pass runs the real lanes on this owner afterwards.
const watch = async (name: string, seed: (state: DurableObjectState) => unknown, observe: (stub: DurableObjectStub, at: number[], retries: number[]) => Promise<void>,
  options: { firstPass?: (owner: Owner) => Promise<void>; arm?: boolean } = {}) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const inObject = <T>(work: (state: DurableObjectState) => Promise<T> | T) => runInDurableObject(stub, async (_instance, state) => work(state));
  const at: number[] = [], retries: number[] = [], start = Date.now(), id = stub.id.toString();
  const passes = vi.spyOn(proto, 'alarm').mockImplementation(async function (this: Owner, info?: AlarmInvocationInfo) {
    if (this.ctx.id.toString() !== id) return real.alarm.call(this, info);
    at.push(Date.now() - start); retries.push(info?.retryCount ?? 0);
    return options.firstPass && at.length === 1 ? options.firstPass(this) : real.alarm.call(this);
  });
  sent.length = 0;
  try {
    await inObject(async state => { await seed(state); if (options.arm !== false) await armAlarm(state.storage, Date.now() + 100); });
    await observe(stub, at, retries);
  } finally {
    await inObject(state => state.storage.deleteAlarm());
    await sleep(300);
    await inObject(async state => {
      await state.storage.delete([...WAKE_DUE_KEYS, FAILURES, LANE, RETRY_DUE, 'telegram_owner_inbox_v1', 'telegram_final_outbox_v1']);
      await state.storage.deleteAlarm();
    });
    const left = await inObject(state => state.storage.getAlarm());
    passes.mockRestore();
    expect(left).toBeNull();
  }
};
// Each test's owner has its own chat, so a send from another test's owner never counts here.
const ownedBy = (state: DurableObjectState, name: string, subject: string) => { state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', subject); };
const sentTo = (subject: string) => sent.filter(message => message.chat_id === Number(subject)).map(message => message.text);
const admitInbound = (state: DurableObjectState, name: string, subject: string) =>
  new TelegramOwnerInbox(state.storage, persistInboxWake).admit({ bot: BOT, subject, doName: name }, 1, JSON.stringify({ update_id: 1 }));

it('during an inbound-lane streak, a reply re-armed outside the handler goes out within the floor while the inbound lane waits for its retry', async () => {
  const name = 'lane-inbound-reply', subject = '701', lines = vi.spyOn(console, 'error').mockImplementation(() => undefined), inbound = lane('drainInbox', name, fails);
  try {
    await watch(name, async state => { ownedBy(state, name, subject); state.storage.kv.put(FAILURES, 4); await admitInbound(state, name, subject); }, async stub => {
      await until(async () => (await runInDurableObject(stub, (_instance, state) => state.storage.kv.get(FAILURES))) === 5, 3_000);
      // A reply already due sits in the outbox with its wake, and a turn ending re-arms through the arbiter.
      const queued = await runInDurableObject(stub, async (_instance, state) => {
        await new TelegramFinalOutbox(state.storage.kv, () => Date.now() - 1_000).enqueue(reply(name, 'reply during the streak', subject));
        await rearmSharedAlarm(state.storage, null, Date.now());
        return { at: Date.now(), ...record(state) };
      });
      await until(() => sentTo(subject).length > 0, 1_500);
      expect(sentTo(subject), `retry at +${queued.retryDue! - queued.at} ms`).toEqual(['reply during the streak']);
      expect(queued.lane).toBe('inbox');
      await sleep(500);
      expect(inbound.ran).toHaveLength(1);
      expect(await runInDurableObject(stub, (_instance, state) => record(state))).toEqual({ streak: 5, lane: 'inbox', retryDue: queued.retryDue });
    });
  } finally { inbound.restore(); lines.mockRestore(); }
}, 20_000);

it('the failing lane\'s retry fires at its stored time and runs that lane, and the streak clears when it succeeds', async () => {
  const name = 'lane-retry-fires', subject = '702', lines = vi.spyOn(console, 'error').mockImplementation(() => undefined), inbound = lane('drainInbox', name, fails, consumesInbound), ran = inbound.ran;
  try {
    await watch(name, async state => { ownedBy(state, name, subject); await admitInbound(state, name, subject); }, async stub => {
      await until(async () => (await runInDurableObject(stub, (_instance, state) => state.storage.kv.get(FAILURES))) === 1, 3_000);
      const failed = await runInDurableObject(stub, (_instance, state) => record(state));
      expect(failed.lane).toBe('inbox');
      await until(() => ran.length >= 2, 4_000);
      expect(ran.length, `inbound lane ran at ${ran.join(', ')}; retry stored for ${failed.retryDue}`).toBe(2);
      expect(ran[1]!).toBeGreaterThanOrEqual(failed.retryDue! - 50);
      expect(ran[1]!).toBeLessThanOrEqual(failed.retryDue! + 1_000);
      await sleep(200);
      expect(await runInDurableObject(stub, (_instance, state) => record(state))).toEqual({ streak: undefined, lane: undefined, retryDue: undefined });
    });
  } finally { inbound.restore(); lines.mockRestore(); }
}, 20_000);

// The round-robin cursor would pick the outbox next. If the retry pass ran that instead and completed, the streak would
// clear without the inbound lane having run, and its next failure would start the backoff over.
it('the retry pass runs the failing lane first, even when the round-robin points at another ready lane', async () => {
  const name = 'lane-retry-first', subject = '703', stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), inbound = lane('drainInbox', name, consumesInbound);
  const drained = vi.spyOn(TelegramFinalOutbox.prototype, 'drain');
  try {
    await runInDurableObject(stub, async (instance, state) => {
      ownedBy(state, name, subject);
      state.storage.kv.put('telegram_owner_inbox_v1', [{ id: 'row-1', digest: 'd', sequence: 1, updateId: 1, body: '{"update_id":1}', admittedAt: Date.now(), state: 'admitted', bot: BOT, subject, doName: name }]);
      await new TelegramFinalOutbox(state.storage.kv, () => Date.now() - 1_000).enqueue(reply(name, 'queued before the retry', subject));
      state.storage.kv.put('owner_alarm_last_v1', 0);
      streak(state, 3, 'inbox', Date.now() - 1);
      await (instance as unknown as Lanes).alarm();
      expect(inbound.ran).toHaveLength(1);
      expect(drained).not.toHaveBeenCalled();
      expect(record(state)).toEqual({ streak: undefined, lane: undefined, retryDue: undefined });
      await state.storage.delete([...WAKE_DUE_KEYS, 'telegram_owner_inbox_v1', 'telegram_final_outbox_v1', 'owner_alarm_last_v1']);
      await state.storage.deleteAlarm();
    });
  } finally { inbound.restore(); drained.mockRestore(); }
}, 20_000);

it('a held pass killed mid-work leaves its wake to the platform\'s retry, which runs the still-due lane while the failing one waits', async () => {
  const name = 'lane-held-pass-killed', subject = '704', retryDue = Date.now() + 60_000, app = lane('drainApp', name, fails);
  try {
    await watch(name, async state => {
      ownedBy(state, name, subject); streak(state, 5, 'app', retryDue);
      await new TelegramFinalOutbox(state.storage.kv, () => Date.now() - 1_000).enqueue(reply(name, 'still due', subject));
    }, async (stub, at, retries) => {
      await until(() => at.length >= 2 && sentTo(subject).length > 0, 5_000);
      await sleep(200);
      const after = await runInDurableObject(stub, async (_instance, state) => ({ ...record(state), armed: await state.storage.getAlarm() }));
      expect(retries[1], `passes at ${at.join(', ')} ms; retry counts ${retries.join(', ')}`).toBe(1);
      expect(sentTo(subject)).toEqual(['still due']);
      expect(app.ran).toHaveLength(0);
      expect(after).toMatchObject({ streak: 5, lane: 'app', retryDue });
      expect(after.armed, `armed ${after.armed}, retry ${retryDue}`).not.toBeNull();
      expect(after.armed!).toBeLessThanOrEqual(retryDue);
    }, { firstPass: owner => alarmPass(owner.ctx.storage, async () => { await rearmSharedAlarm(owner.ctx.storage, null, Date.now()); throw new Error('synthetic pass death'); }) });
  } finally { app.restore(); }
}, 20_000);

// The admission helpers still arm about 250 ms during a streak. The pass that wakes holds the failing lane and runs theirs.
it('an inbox admission and a transport enqueue during another lane\'s streak run their lanes now, while the failing lane waits', async () => {
  const name = 'lane-admission-probe', subject = '705', retryDue = Date.now() + 60_000, app = lane('drainApp', name, fails), inbound = lane('drainInbox', name, consumesInbound);
  try {
    await watch(name, state => { ownedBy(state, name, subject); streak(state, 5, 'app', retryDue); }, async stub => {
      await runInDurableObject(stub, async (_instance, state) => { await admitInbound(state, name, subject); });
      await until(() => inbound.ran.length > 0, 1_500);
      expect(inbound.ran, 'the inbox admission\'s pass').toHaveLength(1);
      await runInDurableObject(stub, async (_instance, state) => {
        await new TelegramFinalOutbox(state.storage.kv, Date.now, (rows, due) => persistTransportWake(state.storage, rows, due)).enqueue(reply(name, 'enqueued during the streak', subject));
      });
      await until(() => sentTo(subject).length > 0, 1_500);
      expect(sentTo(subject), 'the transport enqueue\'s pass').toEqual(['enqueued during the streak']);
      expect(app.ran).toHaveLength(0);
      expect(await runInDurableObject(stub, (_instance, state) => record(state))).toEqual({ streak: 5, lane: 'app', retryDue });
    }, { arm: false });
  } finally { app.restore(); inbound.restore(); }
}, 20_000);

// A link reply lives five minutes; a ninth failure's retry is further off than that, so holding the reply for it expires it.
it('a link reply goes out inside its five-minute life during an inbound-lane streak of 9', async () => {
  const subject = '424242', name = `telegram-link:${BOT}:${subject}`, linkInbound = vi.spyOn(TelegramLinkInbox.prototype, 'maintain');
  try {
    let retryDue = 0;
    await watch(name, async state => {
      retryDue = Date.now() + alarmRetryDelay(9, state.id.toString(), HEARTBEAT_EVERY_MS);
      expect(retryDue - Date.now()).toBeGreaterThan(5 * 60_000);
      await state.storage.put(LINK_MODE, { bot: BOT, subject, name });
      await new TelegramFinalOutbox(state.storage.kv, () => Date.now() - 1_000).enqueue({ ...reply(name, 'link reply', subject), expiresAt: Date.now() + 5 * 60_000 });
      streak(state, 9, 'inbox', retryDue);
    }, async stub => {
      await runInDurableObject(stub, (_instance, state) => rearmSharedAlarm(state.storage, null, Date.now()));
      await until(() => sentTo(subject).length > 0, 1_500);
      expect(sentTo(subject)).toEqual(['link reply']);
      expect(linkInbound).not.toHaveBeenCalled();
      expect(await runInDurableObject(stub, (_instance, state) => record(state))).toEqual({ streak: 9, lane: 'inbox', retryDue });
    }, { arm: false });
  } finally { linkInbound.mockRestore(); }
}, 20_000);
