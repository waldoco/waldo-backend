import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, UNDO_WINDOW_MS } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import type { CalendarItem, GoogleClient } from '../src/connectors/google';

// "Cancel my 7am": the cancel undoes in one tap, the way a create or a move does, by putting the same event back.
const NOW = Date.UTC(2026, 10, 2, 0, 0);
type Run = Readonly<{ undoCancels: boolean; editedAfter?: boolean; oldConnector?: boolean }>;
const cancelThenUndo = async (name: string, run: Run) => {
  let event: CalendarItem = { id: 'e1', title: 'Intervals', start: '2026-11-02T07:00:00+05:30', end: '2026-11-02T08:00:00+05:30', all_day: false, etag: 'v1', status: 'confirmed' };
  const restores: string[] = [];
  const out: { done?: { toast: string; message: string }; undone?: { toast: string; message: string }; app?: unknown } = {};
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const client = {
      event: async () => event,
      // A connector that predates restores answers a cancel with nothing.
      cancelEvent: async (_id: string, _etag: string, marker: string) => {
        event = { ...event, status: 'cancelled', etag: 'v2', operation_marker: marker };
        const applied = event;
        if (run.editedAfter) event = { ...event, etag: 'v3' };
        return run.oldConnector ? undefined : applied;
      },
      restoreEvent: async (_id: string, etag: string, marker: string) => {
        restores.push(etag);
        event = { ...event, status: 'confirmed', etag: 'v4', operation_marker: marker };
        return event;
      },
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      owner: 42, call: async () => ({}), google: async () => client, newId: () => '1', now: () => NOW, timezone: 'Asia/Kolkata', log: () => undefined,
      effects: ownerEffectLedger(state.storage, () => NOW), undoCancels: run.undoCancels,
    });
    const id = await desk.propose({ action: 'cancel', event_id: 'e1', title: 'Intervals', reason: 'short night' });
    out.done = await desk.decide(id, 'a', 'test');
    out.app = (await desk.approvals(NOW)).find(a => a.approval_id === id);
    out.undone = await desk.decide(id, 'u', 'test');
  });
  return { event, restores, out };
};

describe('undoing a calendar cancel', () => {
  it('puts the event back in one tap, on the version the cancel left, and the app counts the undo down', async () => {
    const { event, restores, out } = await cancelThenUndo('cancel-undo', { undoCancels: true });
    expect(out.done).toEqual({ toast: 'Done', message: 'Done: Cancel "Intervals". Undo is available for 10 minutes.' });
    expect(out.app).toMatchObject({ state: 'done', actions: ['undo'], undo_until: NOW + UNDO_WINDOW_MS });
    expect(out.undone).toEqual({ toast: 'Undone', message: 'Undone: Cancel "Intervals".' });
    expect(restores).toEqual(['v2']);
    expect(event.status).toBe('confirmed');
  });

  it('offers no undo while it is off, as before', async () => {
    const { restores, out } = await cancelThenUndo('cancel-undo-off', { undoCancels: false });
    expect(out.done?.message).toBe('Done: Cancel "Intervals". This one can\'t be undone from here.');
    expect(out.app).not.toHaveProperty('undo_until');
    expect(restores).toEqual([]);
  });

  it('offers no undo when the connector does not say which version the cancel left', async () => {
    const { restores, out } = await cancelThenUndo('cancel-undo-old-connector', { undoCancels: true, oldConnector: true });
    expect(out.done?.message).toBe('Done: Cancel "Intervals". This one can\'t be undone from here.');
    expect(restores).toEqual([]);
  });

  it('leaves the event as it is when it changed after the cancel', async () => {
    const { event, restores, out } = await cancelThenUndo('cancel-undo-edited', { undoCancels: true, editedAfter: true });
    expect(out.undone?.toast).toBe('The event changed');
    expect(restores).toEqual([]);
    expect(event.status).toBe('cancelled');
  });
});
