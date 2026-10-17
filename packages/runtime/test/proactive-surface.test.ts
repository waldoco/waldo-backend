import { describe, expect, it } from 'vitest';
import { SEND_NOW_ONLY } from '../src/channels/delivery-routes';
import { PROACTIVE_SURFACE_KEY, WHATSAPP_COPY_PREFIX, WHATSAPP_SUBJECTS_KEY, proactiveSurface, proactiveTargets, rememberWhatsAppSubject, setProactiveSurface,
  waitingForWhatsApp, whatsappSubjects, withWhatsAppCopy, type ProactiveSurface } from '../src/channels/proactive-surface';
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

  it('stores each of its three values and refuses anything else without changing the stored one', () => {
    const kv = memoryKv();
    for (const value of ['whatsapp', 'both', 'app'] as const) {
      expect(setProactiveSurface(kv, value)).toBe(true);
      expect(proactiveSurface(kv)).toBe(value);
    }
    setProactiveSurface(kv, 'both');
    for (const value of ['telegram', 'imessage', 'APP', ' app', '', 'app|both']) expect(setProactiveSurface(kv, value)).toBe(false);
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
    expect(proactiveTargets(setting, { app, whatsapp })).toEqual(targets);
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
    const copied = withWhatsAppCopy(deliver, async (id, text) => { queued.push({ id, text }); }, code => reports.push(code));
    expect(await copied('The Brief.')).toBe('scheduled-1');
    expect(await copied('A reminder.')).toBe('scheduled-2');
    expect(delivered.map(row => row.text)).toEqual(['The Brief.', 'A reminder.']);
    expect(queued).toEqual([{ id: `${WHATSAPP_COPY_PREFIX}scheduled-1`, text: 'The Brief.' }, { id: `${WHATSAPP_COPY_PREFIX}scheduled-2`, text: 'A reminder.' }]);
    expect(reports).toEqual([]);
  });

  it('is never queued for a one-time code or a short-lived link, which WhatsApp could hold for later', async () => {
    const { queued, delivered, deliver } = sends();
    const copied = withWhatsAppCopy(deliver, async (id, text) => { queued.push({ id, text }); }, () => undefined);
    await copied('From bank:\nCode: 482913', { nowOnly: true });
    expect(delivered).toEqual([{ text: 'From bank:\nCode: 482913', nowOnly: true }]);
    expect(queued).toEqual([]);
  });

  it('keeps the app message when the copy cannot be queued, and reports it by its code alone', async () => {
    const { reports, deliver } = sends();
    const copied = withWhatsAppCopy(deliver, async () => { throw new Error('final outbox capacity'); }, code => reports.push(code));
    expect(await copied('The Brief.')).toBe('scheduled-1');
    expect(reports).toEqual(['copy_failed']);
  });

  it('is not queued for a message the app did not take', async () => {
    const queued: string[] = [];
    const copied = withWhatsAppCopy(async () => { throw new Error('app transcript write failed'); }, async id => { queued.push(id); }, () => undefined);
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
    expect(waiting(record({ id: `${WHATSAPP_COPY_PREFIX}scheduled-1`, reminder: undefined }))).toBe(false);
    expect(waiting(record({ id: 'turn:wa-1', reminder: undefined, inbox: { id: 'in-1', runId: 'run-2', attempt: 'a' } }))).toBe(false);
    // Another surface's record, and one whose chat and owner disagree, are never taken for WhatsApp's.
    expect(waiting(record({ ownerSubject: '7', payload: { chat_id: 7, text: 'Telegram.' } }))).toBe(false);
    expect(waiting(record({ payload: { chat_id: 7, text: 'Mismatched.' } }))).toBe(false);
    expect(waitingForWhatsApp(new Set())(record())).toBe(false);
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
