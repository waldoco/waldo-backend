import { describe, expect, it } from 'vitest';
import { SEND_NOW_ONLY } from '../src/channels/delivery-routes';
import { PROACTIVE_SURFACE_KEY, WHATSAPP_COPY_PREFIX, WHATSAPP_SUBJECTS_KEY, proactiveSurface, proactiveTargets, refusingUnreachableCheckBacks, rememberWhatsAppSubject, setProactiveSurface, UNREACHABLE_CHECK_BACK, wantedTargets,
  waitingForWhatsApp, whatsappSubjects, withCopy, type ProactiveSurface } from '../src/channels/proactive-surface';
import { appCaller } from '../src/channels/surfaces/app';
import type { FinalRecord } from '../src/channels/telegram-final-outbox';

const memoryKv = () => {
  const map = new Map<string, unknown>();
  return { map, get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); } };
};

describe('the owner\'s proactive surface setting', () => {
  it('is the app until the owner chooses, and an unknown stored value reads as the app', () => {
    const kv = memoryKv();
    expect(proactiveSurface(kv)).toBe('app');
    kv.put(PROACTIVE_SURFACE_KEY, 'telegram');
    expect(proactiveSurface(kv)).toBe('app');
  });

  it('stores each of its four values and refuses anything else without changing the stored one', () => {
    const kv = memoryKv();
    for (const value of ['whatsapp', 'both', 'app_imessage', 'app'] as const) {
      expect(setProactiveSurface(kv, value)).toBe(true);
      expect(proactiveSurface(kv)).toBe(value);
    }
    setProactiveSurface(kv, 'both');
    for (const value of ['telegram', 'imessage', 'iMessage', 'APP', ' app', '', 'app|both']) expect(setProactiveSurface(kv, value)).toBe(false);
    expect(kv.map.get(PROACTIVE_SURFACE_KEY)).toBe('both');
  });
});

describe('where proactive work goes', () => {
  // The setting chooses between the surfaces the owner can be reached on now; with one, that one; with none, nowhere.
  const table: readonly (readonly [ProactiveSurface, boolean, boolean, readonly string[]])[] = [
    ['app', true, true, ['app']],
    ['app', true, false, ['app']],
    ['app', false, true, ['whatsapp']],
    ['app', false, false, []],
    ['whatsapp', true, true, ['whatsapp']],
    ['whatsapp', true, false, ['app']],
    ['whatsapp', false, true, ['whatsapp']],
    ['whatsapp', false, false, []],
    ['both', true, true, ['app', 'whatsapp']],
    ['both', true, false, ['app']],
    ['both', false, true, ['whatsapp']],
    ['both', false, false, []],
  ];
  it.each(table)('setting %s, app reachable %s, WhatsApp reachable %s: %j', (setting, app, whatsapp, targets) => {
    expect(proactiveTargets(wantedTargets(setting), { app, whatsapp })).toEqual(targets);
    // An iMessage that is not reachable changes nothing for the app and WhatsApp choices.
    expect(proactiveTargets(wantedTargets(setting), { app, whatsapp, imessage: false })).toEqual(targets);
  });

  // iMessage only ever gets a copy of what the app takes: its bridge's report never reaches the job that sent the message, so
  // it cannot be what settles a job. Without the app, it gets nothing.
  const imessage: readonly (readonly [ProactiveSurface, boolean, boolean, boolean, readonly string[]])[] = [
    ['app_imessage', true, false, true, ['app', 'imessage']],
    ['app_imessage', true, false, false, ['app']],
    ['app_imessage', false, false, true, []],
    ['app_imessage', false, true, true, ['whatsapp']],
    ['app_imessage', false, false, false, []],
    ['app', false, false, true, []],
  ];
  it.each(imessage)('setting %s, app reachable %s, WhatsApp reachable %s, iMessage reachable %s: %j', (setting, app, whatsapp, reachable, targets) => {
    expect(proactiveTargets(wantedTargets(setting), { app, whatsapp, imessage: reachable })).toEqual(targets);
  });
  it('never lets iMessage take the work first, whatever list asks for it', () => {
    expect(proactiveTargets(['imessage', 'app'], { app: true, imessage: true })).toEqual(['app']);
    expect(proactiveTargets(['imessage'], { app: false, whatsapp: false, imessage: true })).toEqual([]);
  });
});

describe('the WhatsApp copy of an app message', () => {
  const sends = () => {
    const queued: { id: string; text: string }[] = [], reports: string[] = [], delivered: { text: string; nowOnly: boolean }[] = [];
    let row = 0;
    const deliver = async (text: string, send?: Readonly<{ nowOnly?: boolean }>) => { delivered.push({ text, nowOnly: send?.nowOnly === true }); row += 1; return `scheduled-${row}`; };
    return { queued, reports, delivered, deliver };
  };

  it('is queued once per app message, after the app has it, under an id naming that message', async () => {
    const { queued, reports, delivered, deliver } = sends();
    const copied = withCopy(WHATSAPP_COPY_PREFIX, deliver, async (id, text) => { queued.push({ id, text }); }, code => reports.push(code));
    expect(await copied('The Brief.')).toBe('scheduled-1');
    expect(await copied('A reminder.')).toBe('scheduled-2');
    expect(delivered.map(row => row.text)).toEqual(['The Brief.', 'A reminder.']);
    expect(queued).toEqual([{ id: `${WHATSAPP_COPY_PREFIX}scheduled-1`, text: 'The Brief.' }, { id: `${WHATSAPP_COPY_PREFIX}scheduled-2`, text: 'A reminder.' }]);
    expect(reports).toEqual([]);
  });

  it('is never queued for a one-time code or a short-lived link, which WhatsApp could hold for later', async () => {
    const { queued, delivered, deliver } = sends();
    const copied = withCopy(WHATSAPP_COPY_PREFIX, deliver, async (id, text) => { queued.push({ id, text }); }, () => undefined);
    await copied('From bank:\nCode: 482913', { nowOnly: true });
    expect(delivered).toEqual([{ text: 'From bank:\nCode: 482913', nowOnly: true }]);
    expect(queued).toEqual([]);
  });

  it('keeps the app message when the copy cannot be queued, and reports it by its code alone', async () => {
    const { reports, deliver } = sends();
    const copied = withCopy(WHATSAPP_COPY_PREFIX, deliver, async () => { throw new Error('final outbox capacity'); }, code => reports.push(code));
    expect(await copied('The Brief.')).toBe('scheduled-1');
    expect(reports).toEqual(['copy_failed']);
  });

  it('is not queued for a message the app did not take', async () => {
    const queued: string[] = [];
    const copied = withCopy(WHATSAPP_COPY_PREFIX, async () => { throw new Error('app transcript write failed'); }, async id => { queued.push(id); }, () => undefined);
    await expect(copied('The Brief.')).rejects.toThrow('app transcript write failed');
    expect(queued).toEqual([]);
  });

  it('learns from the app send path whether a send is only worth delivering now', async () => {
    const seen: (boolean | undefined)[] = [];
    const call = appCaller(() => async (_text, send) => { seen.push(send?.nowOnly); return 'scheduled-1'; });
    await call('sendMessage', { chat_id: 1, text: 'Card.' });
    await call('sendMessage', { chat_id: 1, text: 'Code: 1', [SEND_NOW_ONLY]: true });
    expect(seen).toEqual([false, true]);
  });
});

describe('messages still waiting for WhatsApp', () => {
  const reminder = { id: 'rem-1', occurrence: 1, runId: 'run-1', schedulerRunId: null, once: true };
  const record = (changed: Partial<FinalRecord> = {}): FinalRecord => ({ id: 'reminder:rem-1:1', trace: 't', payload: { chat_id: 15550001111, text: 'Call Sam.' }, digest: 'd',
    ownerSubject: '15550001111', doName: 'owner', status: 'pending', dueAt: 0, createdAt: 0, attempts: 0, reminder, ...changed });

  it('are what a scheduled job queued for a WhatsApp number this owner used; a copy of an app message and a reply are not', () => {
    const waiting = waitingForWhatsApp(new Set(['15550001111', '15550002222']));
    expect(waiting(record())).toBe(true);
    expect(waiting(record({ ownerSubject: '15550002222', payload: { chat_id: 15550002222, text: 'Old number.' } }))).toBe(true);
    expect(waiting(record({ id: 'heartbeat:hb:1', reminder: undefined, heartbeat: { id: 'hb', occurrence: 1, schedulerRunId: 'r', loops: [] } }))).toBe(true);
    expect(waiting(record({ id: 'day-card:2026-10-03:card:brief', reminder: undefined, dayCard: { day: '2026-10-03', card: 'card:brief', foldUpTo: 0 } }))).toBe(true);
    expect(waiting(record({ id: 'standing-order:order:ord1:1', reminder: undefined, standingOrder: { runId: 'run-3', gate: 'act_and_report' } }))).toBe(true);
    expect(waiting(record({ id: `${WHATSAPP_COPY_PREFIX}scheduled-1`, reminder: undefined }))).toBe(false);
    expect(waiting(record({ id: 'turn:wa-1', reminder: undefined, inbox: { id: 'in-1', runId: 'run-2', attempt: 'a' } }))).toBe(false);
    // Another surface's record, and one whose chat and owner disagree, are never taken for WhatsApp's.
    expect(waiting(record({ ownerSubject: '7', payload: { chat_id: 7, text: 'Telegram.' } }))).toBe(false);
    expect(waiting(record({ payload: { chat_id: 7, text: 'Mismatched.' } }))).toBe(false);
    expect(waitingForWhatsApp(new Set())(record())).toBe(false);
  });

  it('never include a message WhatsApp took any part of: it is on the owner\'s phone in part, so the app must not get the rest alone', () => {
    const waiting = waitingForWhatsApp(new Set(['15550001111']));
    expect(waiting(record({ providerMessageIds: [null, 'wamid.2'], deliveredParts: 1 }))).toBe(false);
    expect(waiting(record({ providerMessageIds: ['wamid.1', null], deliveredParts: 1 }))).toBe(false);
    expect(waiting(record({ providerMessageIds: [null, null] }))).toBe(true);
  });

  it('are found by every number the owner bound, newest last and a few at most, so a replaced number is still found', () => {
    const kv = memoryKv();
    rememberWhatsAppSubject(kv, '15550001111');
    rememberWhatsAppSubject(kv, '15550001111');
    rememberWhatsAppSubject(kv, '15550002222');
    rememberWhatsAppSubject(kv, '15550001111');
    expect(kv.map.get(WHATSAPP_SUBJECTS_KEY)).toEqual(['15550002222', '15550001111']);
    for (let n = 0; n < 12; n += 1) rememberWhatsAppSubject(kv, String(15550003000 + n));
    expect(whatsappSubjects(kv).size).toBe(8);
    expect(whatsappSubjects(kv).has('15550003011')).toBe(true);
  });
});

// iMessage replies leave through their own outbox, so outside a turn a send with no delivery bound is not acknowledged:
// the producer that sent it records nothing as sent.
describe('a send on a surface that acknowledges only in its turn', () => {
  it('returns no message outside a turn with no delivery bound, and a receipt when one is bound', async () => {
    let turn = false;
    let bound: ((text: string) => Promise<string>) | null = null;
    const call = appCaller(() => bound, () => turn);
    expect(await call('sendMessage', { chat_id: 7, text: 'Time to call Sam.' })).toBeUndefined();
    turn = true;
    expect(await call('sendMessage', { chat_id: 7, text: 'Time to call Sam.' })).toMatchObject({ message_id: 1 });
    turn = false;
    bound = async () => 'proactive:rem-1';
    expect(await call('sendMessage', { chat_id: 7, text: 'Time to call Sam.' })).toMatchObject({ app_row_id: 'proactive:rem-1' });
  });
});

describe('a check-back for an owner Waldo cannot message first', () => {
  const handled: string[] = [];
  const handler = (name: string) => ({ name, handle: async (args: never) => { handled.push(`${name}:${JSON.stringify(args)}`); return { ok: true as const, data: {}, source_taint: null }; } });
  const tools = [handler('set_reminder'), handler('set_standing_order'), handler('open_loop'), handler('start_task'), handler('read_memory')];
  const call = (reachable: boolean, name: string, args: object) => refusingUnreachableCheckBacks(tools, () => reachable).find((tool) => tool.name === name)!.handle(args as never);

  it.each([
    ['set_reminder', { note: 'call Sam', at: '2026-10-22T09:00', repeat: 'none' }],
    ['set_standing_order', { scope: 'send me a mail digest', trigger: 'daily', at: '08:00' }],
    ['open_loop', { title: 'Check the visa appointment', due: '2026-10-23' }],
    ['start_task', { profile: 'reader', title: 'Inbox since Monday', goal: 'Who is waiting on me', context: '', done_when: 'A list' }],
  ] as const)('refuses %s with the reason and schedules nothing', async (name, args) => {
    handled.length = 0;
    expect(await call(false, name, args)).toEqual({ ok: false, code: 'rejected', error: UNREACHABLE_CHECK_BACK, source_taint: null });
    expect(handled).toEqual([]);
    expect(await call(true, name, args)).toMatchObject({ ok: true });
    expect(handled).toHaveLength(1);
  });

  it.each([
    ['set_standing_order', { scope: 'keep replies short', trigger: 'every_turn' }],
    ['open_loop', { title: 'Check the visa appointment', due: null }],
    ['read_memory', { query: 'visa' }],
  ] as const)('keeps %s that needs no message from Waldo first', async (name, args) => {
    handled.length = 0;
    expect(await call(false, name, args)).toMatchObject({ ok: true });
    expect(handled).toHaveLength(1);
  });
});
