import { describe, expect, it } from 'vitest';
import { SCHEDULE_KINDS, setSchedulePreferenceArgsSchema } from './loops';

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
