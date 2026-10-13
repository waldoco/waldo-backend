import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import type { GoogleClient } from '../src/connectors/google';

// "Move my 4pm to 5pm": the card and the receipt show what the event moves from and to, in the owner's zone.
type Event = Readonly<{ start: string; end: string; all_day?: boolean }>;
const iso = (s: string) => s as never;
const move = async (name: string, before: Event, to: Readonly<{ start: string; end: string }>) => {
  const cards: string[] = [];
  let summary = '';
  let receipt = { toast: '', message: '' };
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const client = {
      event: async (id: string) => ({ id, title: 'QA', all_day: false, etag: 'v1', ...before }),
      moveEvent: async (id: string, start: string, end: string) => ({ id, title: 'QA', start, end, all_day: false, etag: 'v2' }),
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      owner: 42, call: async (method, body) => { if (method === 'sendMessage') cards.push((body as { text: string }).text); return {}; },
      google: async () => client, newId: () => '1', now: () => Date.UTC(2026, 9, 13, 4, 0), timezone: 'Asia/Kolkata', log: () => undefined,
    });
    const id = await desk.propose({ action: 'move', event_id: 'e1', title: 'QA', start: iso(to.start), end: iso(to.end), reason: 'owner asked' });
    summary = desk.pending(Date.UTC(2026, 9, 13, 4, 0)).find(item => item.id === id)!.summary;
    receipt = await desk.decide(id, 'a', 'test');
  });
  return { card: cards[0], summary, receipt };
};

describe('a calendar move', () => {
  it('shows the time it moves from and to on the card, in the approvals list and in the receipt', async () => {
    const { card, summary, receipt } = await move('calendar-move-card', { start: '2026-10-13T16:00:00+05:30', end: '2026-10-13T17:00:00+05:30' }, { start: '2026-10-13T17:00:00+05:30', end: '2026-10-13T18:00:00+05:30' });
    expect(card).toBe('Proposed: Move "QA" from Tue 13 Oct, 16:00–17:00 to Tue 13 Oct, 17:00–18:00. owner asked');
    expect(summary).toBe('Move "QA" from Tue 13 Oct, 16:00–17:00 to Tue 13 Oct, 17:00–18:00. owner asked');
    expect(receipt).toEqual({ toast: 'Done', message: 'Done: Move "QA" from Tue 13 Oct, 16:00–17:00 to Tue 13 Oct, 17:00–18:00. Undo is available for 10 minutes.' });
  });

  it('names both days when a time crosses midnight', async () => {
    const { card } = await move('calendar-move-midnight', { start: '2026-10-13T23:00:00+05:30', end: '2026-10-14T00:30:00+05:30' }, { start: '2026-10-14T09:00:00+05:30', end: '2026-10-14T10:30:00+05:30' });
    expect(card).toBe('Proposed: Move "QA" from Tue 13 Oct, 23:00 to Wed 14 Oct, 00:30 to Wed 14 Oct, 09:00–10:30. owner asked');
  });

  it('leaves out the from-time of an all-day event, which has no clock time', async () => {
    const { card } = await move('calendar-move-all-day', { start: '2026-10-13', end: '2026-10-14', all_day: true }, { start: '2026-10-13T17:00:00+05:30', end: '2026-10-13T18:00:00+05:30' });
    expect(card).toBe('Proposed: Move "QA" to Tue 13 Oct, 17:00–18:00. owner asked');
  });

  it('is Done when its response was lost and Google writes the same instant in another offset', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('calendar-move-readback')), async (_instance, state) => {
      const effects = ownerEffectLedger(state.storage, () => 1000);
      let marker = '', moves = 0;
      const client = {
        event: async (id: string) => marker
          ? { id, title: 'QA', start: '2026-10-13T17:00:00+05:30', end: '2026-10-13T18:00:00+05:30', all_day: false, etag: 'v2', operation_marker: marker }
          : { id, title: 'QA', start: '2026-10-13T16:00:00+05:30', end: '2026-10-13T17:00:00+05:30', all_day: false, etag: 'v1' },
        moveEvent: async (_id: string, _start: string, _end: string, _etag: string, applied: string) => { moves++; marker = applied; throw Error('lost response'); },
      } as unknown as GoogleClient;
      const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => ({}), google: async () => client, newId: () => '1', now: () => 1000, timezone: 'Asia/Kolkata', log: () => undefined, effects });
      const id = await desk.propose({ action: 'move', event_id: 'e1', title: 'QA', start: iso('2026-10-13T11:30:00Z'), end: iso('2026-10-13T12:30:00Z'), reason: 'owner asked' });
      expect((await desk.decide(id, 'a', 'test')).toast).toBe('Done');
      expect(moves).toBe(1);
    });
  });
});
