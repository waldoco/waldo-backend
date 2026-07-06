import { describe, expect, it } from 'vitest';
import {
  engagementChannelSchema,
  engagementEventSchema,
  engagementKindSchema,
  isEngagementOpen,
  launchEngagementMetricSchema,
  lowCardinalityMetricLabelSchema,
} from './engagement';

const baseEvent = {
  user_id: 'user-1',
  push_class: 'fetch_alert',
  channel: 'apns',
  kind: 'delivered',
  occurred_at: '2026-07-05T10:00:00.000Z',
};

describe('engagement telemetry', () => {
  it('pins the ADR-0070 launch channels and event kinds', () => {
    expect(engagementChannelSchema.options).toEqual(['apns', 'telegram', 'in_app']);
    expect(engagementKindSchema.options).toEqual([
      'delivered',
      'opened',
      'reply',
      'callback_tap',
      'thumbs_up',
      'thumbs_down',
      'mute',
      'disable',
    ]);
  });

  it('accepts redacted engagement events and rejects content fields', () => {
    expect(engagementEventSchema.safeParse({ ...baseEvent, run_id: 'run-1' }).success).toBe(true);
    expect(
      engagementEventSchema.safeParse({
        ...baseEvent,
        body: 'raw push content',
      }).success,
    ).toBe(false);
    expect(
      engagementEventSchema.safeParse({
        ...baseEvent,
        hrv_ms: 42,
      }).success,
    ).toBe(false);
  });

  it('models Telegram opens as reply or callback tap only', () => {
    expect(isEngagementOpen({ channel: 'telegram', kind: 'reply' })).toBe(true);
    expect(isEngagementOpen({ channel: 'telegram', kind: 'callback_tap' })).toBe(true);
    expect(isEngagementOpen({ channel: 'telegram', kind: 'opened' })).toBe(false);
    expect(isEngagementOpen({ channel: 'apns', kind: 'opened' })).toBe(true);
    expect(isEngagementOpen({ channel: 'in_app', kind: 'opened' })).toBe(true);
  });

  it('pins the four launch metric families', () => {
    expect(launchEngagementMetricSchema.options).toEqual([
      'engagement_open_by_channel',
      'thumbs_ratio',
      'retention_d7_d30',
      'mute_disable_rate',
    ]);
  });

  it('keeps metric labels low-cardinality and redacted', () => {
    expect(lowCardinalityMetricLabelSchema.safeParse({ channel: 'apns', push_class: 'fetch_alert' }).success).toBe(
      true,
    );
    expect(lowCardinalityMetricLabelSchema.safeParse({ user_id: 'user-1' }).success).toBe(false);
    expect(lowCardinalityMetricLabelSchema.safeParse({ run_id: 'run-1' }).success).toBe(false);
    expect(lowCardinalityMetricLabelSchema.safeParse({ raw_health: 'hrv' }).success).toBe(false);
    expect(lowCardinalityMetricLabelSchema.safeParse({ request_id: 'req-1' }).success).toBe(false);
    expect(lowCardinalityMetricLabelSchema.safeParse({ table_name: 'engagement_events' }).success).toBe(false);
    expect(lowCardinalityMetricLabelSchema.safeParse({ sql_query: 'select 1' }).success).toBe(false);
    expect(lowCardinalityMetricLabelSchema.safeParse({ ip: '127.0.0.1' }).success).toBe(false);
    expect(lowCardinalityMetricLabelSchema.safeParse({ hostname: 'worker-1' }).success).toBe(false);
  });
});
