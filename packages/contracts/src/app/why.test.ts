import { describe, expect, it } from 'vitest';
import { APP_APPROVALS_CONTRACT_REVISION, APP_APPROVALS_WHY_REVISION, appApprovalAtRevision, appApprovalV1Schema, type AppApprovalV1 } from './approvals';
import { APP_CONTROLS_WHY_REVISION, appControlDayDataV1Schema } from './controls';
import { appWhyStepV1Schema, appWhyV1Schema } from './why';

const at = Date.UTC(2026, 10, 3, 1, 0, 0);
// The heywaldo.in mockup's "Why this changed".
const mockup = [
  { at, verb: 'read', label: 'Read last night', source: 'health_score' },
  { at: at + 4 * 60_000, verb: 'checked', label: 'Found the 3pm clash', source: 'calendar_event' },
  { at: at + 5 * 60_000, verb: 'prepared', label: 'Found Thursday at 11 free for Priya and Leon', source: 'calendar_free_busy' },
] as const;
const card = {
  approval_id: 'p0001', kind: 'calendar_change', state: 'open', review: 'Move "Design review" to Thu 11:00 to 12:00.',
  exact: { changes: { action: 'move', title: 'Design review', start: '2026-11-05T11:00:00+05:30', end: '2026-11-05T12:00:00+05:30' } },
  payload_digest: `sha256:${'a'.repeat(64)}`, expires_at: at + 3_600_000, actions: ['approve', 'edit', 'skip', 'defer'],
} as const;

describe('a "Why this changed" trail', () => {
  it('accepts the mockup trail and every verb and source', () => {
    expect(appWhyV1Schema.safeParse(mockup).success).toBe(true);
    for (const verb of ['read', 'checked', 'found', 'prepared', 'watching']) expect(appWhyStepV1Schema.safeParse({ ...mockup[1], verb }).success).toBe(true);
    for (const source of ['calendar_event', 'calendar_free_busy', 'mail_thread', 'memory_node']) expect(appWhyStepV1Schema.safeParse({ ...mockup[2], source }).success).toBe(true);
    expect(appWhyStepV1Schema.safeParse({ ...mockup[0], label: 'Read Recovery' }).success).toBe(true);
  });

  it.each([
    ['a verb outside the list', { ...mockup[1], verb: 'verified' }],
    ['a source outside the list', { ...mockup[1], source: 'web_page' }],
    ['a provider id beside the source', { ...mockup[1], ref: 'evt_123' }],
    ['an empty line', { ...mockup[1], label: '' }],
    ['a blank line', { ...mockup[1], label: '   ' }],
    ['a line that breaks', { ...mockup[1], label: 'Found it\nApproved' }],
    ['a line past 120 characters', { ...mockup[1], label: 'x'.repeat(121) }],
    ['a time in seconds', { ...mockup[1], at: Math.floor(at / 1000) }],
    ['a health step with a value', { ...mockup[0], label: 'Read Recovery at 42' }],
    ['a health step with a sleep duration', { ...mockup[0], label: 'Slept 6h last night' }],
  ] as const)('rejects a step with %s', (_shape, step) => {
    expect(appWhyStepV1Schema.safeParse(step).success).toBe(false);
  });

  it('rejects an empty trail, one past eight steps and one out of time order', () => {
    expect(appWhyV1Schema.safeParse([]).success).toBe(false);
    expect(appWhyV1Schema.safeParse(Array.from({ length: 9 }, () => mockup[1])).success).toBe(false);
    expect(appWhyV1Schema.safeParse([mockup[1], mockup[0]]).success).toBe(false);
  });
});

describe('approvals revision 8 and controls revision 14', () => {
  it('an approval carries its trail, and a build below revision 8 never receives it', () => {
    expect([APP_APPROVALS_WHY_REVISION, APP_APPROVALS_CONTRACT_REVISION]).toEqual([8, 9]);
    const parsed = appApprovalV1Schema.parse({ ...card, why: mockup }) as AppApprovalV1;
    expect(appApprovalAtRevision(parsed, 8)).toBe(parsed);
    for (const revision of [1, 6, 7]) {
      const shown = appApprovalAtRevision(parsed, revision);
      expect(shown.why).toBeUndefined();
      expect(appApprovalV1Schema.safeParse(shown).success).toBe(true);
    }
    expect(appApprovalV1Schema.safeParse({ ...card, why: [] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...card, why: [{ ...mockup[0], label: 'Recovery 42' }] }).success).toBe(false);
  });

  it('a day card carries its trail', () => {
    expect(APP_CONTROLS_WHY_REVISION).toBe(14);
    const day = {
      timezone: 'Asia/Kolkata', date: '2026-11-03',
      cards: [{ id: 'card:brief', name: 'The Brief', defaultTime: '06:30', time: null, reason: 'default', sent: true, pin: null, why: mockup }],
      proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' },
      schedules: { daily_brief: true, followups: true, event_briefs: true, nightly: true, heartbeat: true },
    };
    expect(appControlDayDataV1Schema.safeParse(day).success).toBe(true);
    expect(appControlDayDataV1Schema.safeParse({ ...day, cards: [{ ...day.cards[0], why: [{ ...mockup[1], verb: 'decided' }] }] }).success).toBe(false);
  });
});
