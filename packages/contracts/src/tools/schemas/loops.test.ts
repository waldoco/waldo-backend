import { describe, expect, it } from 'vitest';
import { HEALTH_PROPOSAL_MODES, SCHEDULE_KINDS, setSchedulePreferenceArgsSchema } from './loops';

describe('set_schedule_preference arguments', () => {
  it('turns health proposals off and on like every other scheduled behavior', () => {
    for (const action of ['off', 'on'] as const) expect(setSchedulePreferenceArgsSchema.parse({ action, kind: 'health_proposals' })).toEqual({ action, kind: 'health_proposals' });
    expect(SCHEDULE_KINDS).toContain('health_proposals');
  });

  it('refuses a behavior it does not know and any extra field', () => {
    expect(setSchedulePreferenceArgsSchema.safeParse({ action: 'off', kind: 'health_alerts' }).success).toBe(false);
    expect(setSchedulePreferenceArgsSchema.safeParse({ action: 'off', kind: 'health_proposals', until: 'tomorrow' }).success).toBe(false);
  });
});

describe('set_schedule_preference health mode', () => {
  it('takes a mode only for health_proposals turned on', () => {
    for (const mode of HEALTH_PROPOSAL_MODES) expect(setSchedulePreferenceArgsSchema.parse({ action: 'on', kind: 'health_proposals', mode })).toEqual({ action: 'on', kind: 'health_proposals', mode });
  });

  it('refuses a mode with any other kind or action, and a mode it does not know', () => {
    for (const input of [{ action: 'off', kind: 'health_proposals', mode: 'live' }, { action: 'on', kind: 'nightly', mode: 'live' }, { action: 'reset', mode: 'auto' }, { action: 'on', mode: 'live' }, { action: 'on', kind: 'health_proposals', mode: 'loud' }])
      expect(setSchedulePreferenceArgsSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });
});
