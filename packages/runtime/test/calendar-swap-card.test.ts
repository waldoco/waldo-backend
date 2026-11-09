import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import type { GoogleClient } from '../src/connectors/google';

// "Swap the hard workout for an easy one": a move that renames the event in its slot, and an undo that gives the old name back.
const iso = (s: string) => s as never;
const slot = { start: '2026-11-02T07:00:00+05:30', end: '2026-11-02T08:00:00+05:30' };

const swap = async (name: string, renames: boolean, proxyKeepsTitle = false) => {
  const cards: string[] = [];
  const writes: { start: string; end: string; title?: string }[] = [];
  let event = { id: 'e1', title: 'Intervals', ...slot, all_day: false, etag: 'v1' };
  const out: { id?: string; error?: string; done?: { toast: string; message: string }; undone?: { toast: string; message: string } } = {};
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const client = {
      event: async () => event,
      moveEvent: async (id: string, start: string, end: string, _etag: string, _marker: string, options?: { title?: string }) => {
        writes.push({ start, end, ...(options?.title ? { title: options.title } : {}) });
        event = { ...event, start, end, ...(options?.title && !proxyKeepsTitle ? { title: options.title } : {}), etag: `v${writes.length + 1}` };
        return event;
      },
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      owner: 42, call: async (method, body) => { if (method === 'sendMessage') cards.push((body as { text: string }).text); return {}; },
      google: async () => client, newId: () => '1', now: () => Date.UTC(2026, 10, 2, 0, 0), timezone: 'Asia/Kolkata', log: () => undefined,
      effects: ownerEffectLedger(state.storage, () => Date.UTC(2026, 10, 2, 0, 0)), renames,
    });
    try {
      out.id = await desk.propose({ action: 'move', event_id: 'e1', title: 'Intervals', rename_to: 'Easy run', start: iso(slot.start), end: iso(slot.end), reason: 'short night' });
    } catch (error) { out.error = String(error); return; }
    out.done = await desk.decide(out.id, 'a', 'test');
    out.undone = await desk.decide(out.id, 'u', 'test');
  });
  return { cards, writes, out, event };
};

describe('a calendar swap', () => {
  it('renames the event in its slot on approval, says so on the card and the receipt, and undo gives the old name back', async () => {
    const { cards, writes, out, event } = await swap('calendar-swap', true);
    expect(cards[0]).toBe('Change "Intervals" to "Easy run", Mon 2 Nov, 07:00–08:00. short night');
    expect(out.done).toEqual({ toast: 'Done', message: 'Done: Change "Intervals" to "Easy run", Mon 2 Nov, 07:00–08:00. Undo is available for 10 minutes.' });
    expect(writes).toEqual([{ ...slot, title: 'Easy run' }, { ...slot, title: 'Intervals' }]);
    expect(out.undone?.toast).toBe('Undone');
    expect(event.title).toBe('Intervals');
  });

  it('says it was not renamed when the calendar kept the old name, as a connector that predates renames does', async () => {
    const { out, event } = await swap('calendar-swap-kept', true, true);
    expect(out.done).toEqual({ toast: 'Not renamed', message: 'Not renamed: the calendar kept the name "Intervals", so nothing changed.' });
    expect(event.title).toBe('Intervals');
  });

  it('is refused before any card while renames are off', async () => {
    const { cards, writes, out } = await swap('calendar-swap-off', false);
    expect(out.error).toContain('Renaming an event is not available yet');
    expect(cards).toEqual([]);
    expect(writes).toEqual([]);
  });
});
