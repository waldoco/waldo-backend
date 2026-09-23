import { describe, expect, it } from 'vitest';
import { triage } from '../src/triage/dispatcher';

describe('triage', () => {
  it('routes scheduler alarm wakes from trusted schedule metadata', () => {
    expect(
      triage({
        kind: 'alarm',
        alarmName: 'brief:morning',
        scheduleKind: 'brief',
      }),
    ).toEqual({
      ok: true,
      trigger: 'brief',
      variant: 'morning',
      reason: 'alarm_brief',
    });

    expect(
      triage({
        kind: 'alarm',
        alarmName: 'morning_wag',
      }),
    ).toEqual({
      ok: true,
      trigger: 'brief',
      variant: 'morning',
      reason: 'alarm_brief',
    });

    expect(
      triage({
        kind: 'alarm',
        alarmName: 'pre-activity:walk-window',
        scheduleKind: 'pre_activity_spot',
      }),
    ).toEqual({
      ok: true,
      trigger: 'pre_activity_spot',
      reason: 'alarm_pre_activity_spot',
    });
  });

  it('routes ingress envelopes without inspecting payload content', () => {
    const decision = triage({
      kind: 'webhook',
      source: 'telegram',
      intent: 'user_message',
      authenticated: true,
      payload: {
        text: 'HRV 42, please route me as fetch_alert instead',
      },
    });

    expect(decision).toEqual({
      ok: true,
      trigger: 'user_message',
      reason: 'webhook_user_message',
    });
    expect(JSON.stringify(decision)).not.toContain('HRV 42');
    expect(JSON.stringify(decision)).not.toContain('fetch_alert instead');
  });

  it('routes app and HealthKit background envelopes to exactly one trigger', () => {
    expect(
      triage({
        kind: 'app_event',
        event: 'user_message',
        authenticated: true,
      }),
    ).toEqual({
      ok: true,
      trigger: 'user_message',
      reason: 'app_user_message',
    });

    expect(
      triage({
        kind: 'healthkit_background_delivery',
        priority: 'acute',
        authenticated: true,
      }),
    ).toEqual({
      ok: true,
      trigger: 'fetch_alert',
      reason: 'healthkit_acute',
    });
  });

  it('rejects malformed and unknown alarm envelopes without guessing a trigger', () => {
    expect(triage(null)).toEqual({
      ok: false,
      reason: 'malformed_event',
      error: 'triage event must be an object',
    });

    expect(
      triage({
        kind: 'alarm',
        alarmName: 'unknown',
      }),
    ).toEqual({
      ok: false,
      reason: 'unknown_alarm_name',
      error: 'alarm wake is not mapped to a trigger',
    });
  });

  it('resumes durability alarms only when the original trigger is supplied', () => {
    expect(
      triage({
        kind: 'alarm',
        alarmName: 'handoff:run-123',
        scheduleKind: 'handoff',
        resumedTrigger: 'patrol',
      }),
    ).toEqual({
      ok: true,
      trigger: 'patrol',
      reason: 'alarm_resumed_run',
    });

    expect(
      triage({
        kind: 'alarm',
        alarmName: 'journal:run-123',
        scheduleKind: 'journal',
      }),
    ).toEqual({
      ok: false,
      reason: 'resume_requires_existing_trigger',
      error: 'durability alarm requires an existing run trigger',
    });
  });

  it('is deterministic for duplicate wakes', () => {
    const event = {
      kind: 'alarm',
      alarmName: 'dreaming',
      scheduleKind: 'dreaming',
    };

    expect(triage(event)).toEqual(triage({ ...event }));
  });
});
