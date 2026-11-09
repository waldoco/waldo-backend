import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dayPlanBook } from '../src/channels/day-cards';

// A revision of a delivered day card is counted once per outbox record, however many times the outbox settles it, and the
// Main chat row the app shows for it is the newest revision's own: a revision that reached the owner outside the app leaves
// no row, never an older revision's row under the newer time.
const DAY = '2026-10-20';
let seq = 0;
const withPlans = (work: (plans: ReturnType<typeof dayPlanBook>) => void) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`day-plan-revisions-${seq += 1}`)), async (_instance, state) => {
    const plans = dayPlanBook(state.storage.sql);
    plans.delivered(DAY, 'card:brief', 'row-0', 1_000);
    plans.sent(DAY, 'card:brief');
    work(plans);
  });

describe('a delivered card\'s revisions', () => {
  it('counts a record once when the outbox settles it again', async () => {
    await withPlans(plans => {
      plans.revisedRow(DAY, 'card:brief', 'row-1', 'update:a');
      plans.revised(DAY, 'card:brief', 2_000, 'update:a');
      plans.revised(DAY, 'card:brief', 2_500, 'update:a');
      expect(plans.revisions(DAY).get('card:brief')).toEqual({ revision: 1, revised_at: 2_000, message_id: 'row-1' });
      plans.revised(DAY, 'card:brief', 3_000, 'update:b');
      expect(plans.revisions(DAY).get('card:brief')).toMatchObject({ revision: 2, revised_at: 3_000 });
    });
  });

  it('a revision that reached the owner outside the app has no row, not the older revision\'s', async () => {
    await withPlans(plans => {
      plans.revisedRow(DAY, 'card:brief', 'row-1', 'update:a');
      plans.revised(DAY, 'card:brief', 2_000, 'update:a');
      plans.revised(DAY, 'card:brief', 3_000, 'update:b');
      expect(plans.revisions(DAY).get('card:brief')).toEqual({ revision: 2, revised_at: 3_000, message_id: null });
    });
  });

  it('a first revision delivered outside the app has no row either', async () => {
    await withPlans(plans => {
      plans.revised(DAY, 'card:brief', 2_000, 'update:a');
      expect(plans.revisions(DAY).get('card:brief')).toEqual({ revision: 1, revised_at: 2_000, message_id: null });
    });
  });
});
