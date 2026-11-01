import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { medicationBook, type MedicationRpc } from '../src/channels/medications';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// The medicine book against a scripted health plane: what it asks the plane, what it schedules in the owner object, and the
// words a reminder gets. Every value is synthetic.
const ID = '6e900000-0000-4000-8000-000000000001';
const stored = (over: Record<string, unknown> = {}) => ({ id: ID, name: 'Metformin 500 mg', times: ['13:00', '21:00'], supply: null, refill_at: null, created_at: '2026-11-01T00:00:00.000Z', doses: [], ...over });

const withBook = async (answers: (operation: string, payload: Record<string, unknown>) => unknown, body: (book: ReturnType<typeof medicationBook>, asked: { operation: string; payload: Record<string, unknown> }[], state: DurableObjectState) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`medications-book-${crypto.randomUUID()}`)), async (_unused, state) => {
    const asked: { operation: string; payload: Record<string, unknown> }[] = [];
    const rpc: MedicationRpc = async (operation, payload) => {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      asked.push({ operation, payload: parsed });
      return answers(operation, parsed);
    };
    ensureSchema(state.storage);
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    const book = medicationBook(state.storage.sql, scheduler, { now: () => new Date('2026-11-02T14:00:00Z'), timezone: 'Asia/Kolkata' } as never, rpc);
    await body(book, asked, state);
  });
};
const entries = (state: DurableObjectState) => state.storage.sql.exec<{ id: string; note: string }>('SELECT s.id, n.note FROM schedule s JOIN reminder_notes n ON n.id = s.id ORDER BY s.id').toArray();

describe('the medicine book', () => {
  it('tracks on the health plane and schedules each time under the opaque id with a name-free note', async () => {
    await withBook(() => stored(), async (book, asked, state) => {
      expect(await book.track({ name: 'Metformin 500 mg', times: ['13:00', '21:00'] })).toMatchObject({ id: ID, name: 'Metformin 500 mg', reminders: ['13:00', '21:00'] });
      expect(asked).toEqual([{ operation: 'medications_write', payload: { op: 'track', name: 'Metformin 500 mg', times: ['13:00', '21:00'] } }]);
      expect(entries(state)).toEqual([{ id: `reminder:med:${ID}:1300`, note: 'Medication reminder' }, { id: `reminder:med:${ID}:2100`, note: 'Medication reminder' }]);
    });
  });

  it('schedules nothing when the plane did not store it, and says why', async () => {
    for (const [answer, failed] of [[{ error: 'limit_reached' }, 'limit_reached'], [null, 'unavailable'], [{ id: 'not-a-medicine' }, 'unavailable']] as const) {
      await withBook(() => answer, async (book, _asked, state) => {
        expect(await book.track({ name: 'Metformin', times: ['13:00'] })).toEqual({ failed });
        expect(entries(state)).toEqual([]);
      });
    }
  });

  it('logs a dose on the scheduled time nearest what the owner said, in their zone', async () => {
    await withBook((operation) => operation === 'medications_read' ? { medications: [stored()] } : stored({ doses: [{ due_at: '2026-11-02T07:30:00Z', slot: '13:00', status: 'taken' }] }), async (book, asked) => {
      // 13:10 in Kolkata: the nearest dose is today's 13:00 local, 07:30 UTC.
      expect(await book.log({ medication_id: ID, status: 'taken', at: '2026-11-02T13:10' })).toMatchObject({ today: [{ at: '2026-11-02T13:00', status: 'taken' }, { at: '2026-11-02T21:00', status: 'upcoming' }] });
      expect(asked[1]).toEqual({ operation: 'medications_write', payload: { op: 'dose', medication_id: ID, slot: '13:00', due_at: '2026-11-02T07:30:00Z', status: 'taken' } });
    });
  });

  it('refuses a dose of a medicine it does not track, without writing', async () => {
    await withBook(() => ({ medications: [stored({ times: ['13:00'] })] }), async (book, asked) => {
      expect(await book.log({ medication_id: '6e900000-0000-4000-8000-000000000002', status: 'taken' })).toEqual({ failed: 'not_found' });
      expect(asked.every(entry => entry.operation === 'medications_read')).toBe(true);
    });
  });

  it('reads a dose with nothing said as missed six hours after its time', async () => {
    await withBook(() => ({ medications: [stored({ times: ['07:00'], created_at: '2026-10-30T00:00:00.000Z' })] }), async (book) => {
      // 07:00 Kolkata is 01:30 UTC; at 14:00 UTC it is more than six hours past.
      expect((await book.list())?.[0]).toMatchObject({ today: [{ at: '2026-11-02T07:00', status: 'missed' }] });
    });
  });

  it('stops on the plane and removes its reminders', async () => {
    await withBook((operation, payload) => payload.op === 'stop' ? { stopped: true } : stored(), async (book, _asked, state) => {
      await book.track({ name: 'Metformin 500 mg', times: ['13:00', '21:00'] });
      expect(await book.stop(ID)).toBe(true);
      expect(entries(state)).toEqual([]);
    });
  });

  it('words a reminder from the stored label and count only, and removes the reminders of a medicine that is gone', async () => {
    let meds: unknown[] = [stored({ supply: 3, refill_at: 5 })];
    await withBook((operation) => operation === 'medications_read' ? { medications: meds } : stored(), async (book, _asked, state) => {
      await book.track({ name: 'Metformin 500 mg', times: ['13:00', '21:00'] });
      expect(await book.reminder(`reminder:med:${ID}:1300`)).toEqual({ state: 'text', text: 'Time for your Metformin 500 mg (13:00). Reply "taken" when you\'ve had it, or "skip". By my count 3 are left, so it\'s time to reorder.' });
      meds = [stored({ supply: 0 })];
      expect(await book.reminder(`reminder:med:${ID}:1300`)).toEqual({ state: 'text', text: 'Time for your Metformin 500 mg (13:00). Reply "taken" when you\'ve had it, or "skip". By my count you have none left, so it\'s time to reorder.' });
      meds = [];
      expect(await book.reminder(`reminder:med:${ID}:1300`)).toEqual({ state: 'gone' });
      expect(entries(state)).toEqual([]);
    });
  });

  it('a failed read words nothing and keeps the reminders', async () => {
    await withBook((operation) => operation === 'medications_read' ? null : stored(), async (book, _asked, state) => {
      await book.track({ name: 'Metformin 500 mg', times: ['13:00'] });
      expect(await book.reminder(`reminder:med:${ID}:1300`)).toEqual({ state: 'unavailable' });
      expect(entries(state)).toHaveLength(2);
    });
  });
});
