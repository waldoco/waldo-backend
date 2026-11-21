import { describe, expect, it } from 'vitest';
import { getCrsArgsSchema, getCrsResultSchema } from './reads';

// get_crs's answer: each day's three pillars and parts as the engine stored them, the newest day's bands with what they cover,
// and today's readings against them. Synthetic values only.
const available = {
  state: 'available', timezone: 'Asia/Kolkata', from: '2026-03-01', to: '2026-03-20',
  days: [
    { day: '2026-03-19', recovery: { score: 61, zone: 'mixed' }, form: { reason: 'stale_inputs' }, load: { score: 40, zone: 'moderate' }, backfilled: true },
    { day: '2026-03-20', recovery: { score: 72, zone: 'solid' }, parts: [
      { pillar: 'recovery', key: 'sleep', score: 83, direction: null, need_minutes: 480 },
      { pillar: 'recovery', key: 'hrv', score: 38, direction: 'below' },
      { pillar: 'form', key: 'movement', score: 60, direction: 'within', steps: true },
      { pillar: 'load', key: 'calendar', unavailable: 'no_reading' },
    ] },
  ],
  usual: [{ signal: 'overnight_hrv', words: 'overnight heart rate variability', unit: 'milliseconds', span: 'night', state: 'personal', low: 50, centre: 60, high: 70, own_days: 24 }],
  today: [{ signal: 'overnight_hrv', unit: 'milliseconds', value: 41.5, direction: 'below', far: false }],
};

describe('get_crs', () => {
  it('keeps its arguments: one to ninety days, one by default', () => {
    expect(getCrsArgsSchema.parse({})).toEqual({ range_days: 1 });
    expect(getCrsArgsSchema.safeParse({ range_days: 90 }).success).toBe(true);
    expect(getCrsArgsSchema.safeParse({ range_days: 91 }).success).toBe(false);
  });
  it('admits days, parts, bands and today\'s readings, and an unavailable answer with its reason', () => {
    expect(getCrsResultSchema.safeParse(available).success).toBe(true);
    expect(getCrsResultSchema.safeParse({ ...available, days: [] }).success).toBe(true);
    expect(getCrsResultSchema.safeParse({ state: 'unavailable', reason: 'consent_withdrawn', next: 'The owner turned health sharing off.' }).success).toBe(true);
  });
  it.each([
    ['a zone outside the pillar\'s words', { ...available, days: [{ day: '2026-03-20', recovery: { score: 72, zone: 'good' } }] }],
    ['a score above a hundred', { ...available, days: [{ day: '2026-03-20', load: { score: 140, zone: 'heavy' } }] }],
    ['a reason outside the engine\'s words', { ...available, days: [{ day: '2026-03-20', form: { reason: 'tired' } }] }],
    ['a part key the engine has not', { ...available, days: [{ day: '2026-03-20', parts: [{ pillar: 'form', key: 'mood', score: 50, direction: 'within' }] }] }],
    ['a part direction outside the words', { ...available, days: [{ day: '2026-03-20', parts: [{ pillar: 'recovery', key: 'hrv', score: 38, direction: 'low' }] }] }],
    ['a band with no span', { ...available, usual: [{ ...available.usual[0], span: undefined }] }],
    ['a reading of a kind with no band', { ...available, today: [{ signal: 'body_mass', unit: 'count', value: 70, direction: 'above', far: false }] }],
    ['a raw sample beside the reading', { ...available, today: [{ ...available.today[0], samples: [40, 43] }] }],
    ['a reason outside the read\'s', { state: 'unavailable', reason: 'busy' }],
  ])('refuses %s', (_label, candidate) => {
    expect(getCrsResultSchema.safeParse(candidate).success).toBe(false);
  });
});
