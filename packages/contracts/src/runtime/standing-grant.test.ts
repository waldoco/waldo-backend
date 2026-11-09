import { describe, expect, it } from 'vitest';
import { runOriginSchema, standingGrantRecordSchema } from './standing-grant';

const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 3);
const record = {
  grant_id: 'g_blocks_01', revision: 1, created_at: T, created_via: 'app', ended: null,
  terms: {
    scope: { class: 'calendar.move_own_block', account: 'sam@example.com', window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30 },
    limits: { max_per_day: 3, timezone: 'Asia/Kolkata' }, valid_from: T, expires_at: T + 30 * DAY,
  },
};

describe('standing grant record', () => {
  it('accepts a stored grant and an ended one', () => {
    expect(standingGrantRecordSchema.parse(record)).toEqual(record);
    expect(standingGrantRecordSchema.parse({ ...record, revision: 2, ended: { at: T + 1, reason: 'revoked' } }).ended?.reason).toBe('revoked');
  });

  it('refuses a grant past 90 days, a zero revision, an unknown surface, an unknown end and extra fields', () => {
    expect(standingGrantRecordSchema.safeParse({ ...record, terms: { ...record.terms, expires_at: T + 91 * DAY } }).success).toBe(false);
    expect(standingGrantRecordSchema.safeParse({ ...record, revision: 0 }).success).toBe(false);
    expect(standingGrantRecordSchema.safeParse({ ...record, created_via: 'email' }).success).toBe(false);
    expect(standingGrantRecordSchema.safeParse({ ...record, ended: { at: T + 1, reason: 'expired' } }).success).toBe(false);
    expect(standingGrantRecordSchema.safeParse({ ...record, level: 'auto' }).success).toBe(false);
  });

  it('names exactly four run origins', () => {
    expect(runOriginSchema.options).toEqual(['owner', 'owner_standing', 'waldo', 'external']);
    expect(runOriginSchema.safeParse('health').success).toBe(false);
  });
});
