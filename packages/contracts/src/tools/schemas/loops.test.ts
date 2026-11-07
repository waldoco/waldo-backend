import { describe, expect, it } from 'vitest';
import { HEALTH_PROPOSAL_MODES, openLoopArgsSchema, SCHEDULE_KINDS, setSchedulePreferenceArgsSchema } from './loops';

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

describe('set_schedule_preference time', () => {
  it('sets the time the Brief or the Close comes every day, as a 24-hour local time', () => {
    for (const [card, time] of [['brief', '07:10'], ['close', '21:30'], ['brief', '00:00'], ['close', '23:59']] as const)
      expect(setSchedulePreferenceArgsSchema.parse({ action: 'time', card, time })).toEqual({ action: 'time', card, time });
  });

  it('refuses a time without its card, a card without its time, a malformed time, another card, and either beside on, off or reset', () => {
    for (const input of [{ action: 'time', card: 'brief' }, { action: 'time', time: '07:10' }, { action: 'time', card: 'brief', time: '7:10' }, { action: 'time', card: 'brief', time: '24:00' },
      { action: 'time', card: 'brief', time: '7:10am' }, { action: 'time', card: 'midday', time: '14:00' }, { action: 'time', card: 'brief', time: '07:10', kind: 'daily_brief' },
      { action: 'on', kind: 'daily_brief', time: '07:10' }, { action: 'off', kind: 'daily_brief', card: 'brief' }, { action: 'reset', card: 'close', time: '21:30' }])
      expect(setSchedulePreferenceArgsSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });
});

describe('open_loop source_ref', () => {
  // A loop bound to a mail source skips the owner's card (the taint gate's one exception), so the model must read it as a
  // guess at follow-up, not as something the owner agreed to.
  it('tells the model a source-bound loop is a follow-up of unknown completion, never the owner\'s commitment or permission', () => {
    expect(openLoopArgsSchema.shape.source_ref.description).toMatch(/unknown completion/);
    expect(openLoopArgsSchema.shape.source_ref.description).toMatch(/never an owner commitment or permission/);
  });
});
