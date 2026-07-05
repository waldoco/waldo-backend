import { describe, expect, it } from 'vitest';
import {
  publicEngagementEventRequestSchema,
  publicEngagementEventResponseSchema,
  publicErrorSchema,
} from './dto';

describe('public DTOs', () => {
  it('accepts app engagement requests without client-supplied identity', () => {
    expect(
      publicEngagementEventRequestSchema.safeParse({
        push_class: 'fetch_alert',
        channel: 'telegram',
        kind: 'callback_tap',
        occurred_at: '2026-07-05T10:00:00.000Z',
        run_id: 'run-1',
      }).success,
    ).toBe(true);
  });

  it('rejects internal identity, content, and health fields', () => {
    for (const extra of [{ user_id: 'user-1' }, { body: 'raw text' }, { hrv_ms: 42 }]) {
      expect(
        publicEngagementEventRequestSchema.safeParse({
          push_class: 'fetch_alert',
          channel: 'apns',
          kind: 'opened',
          occurred_at: '2026-07-05T10:00:00.000Z',
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it('keeps response and error envelopes minimal', () => {
    expect(publicEngagementEventResponseSchema.safeParse({ accepted: true }).success).toBe(true);
    expect(publicEngagementEventResponseSchema.safeParse({ accepted: false }).success).toBe(false);
    expect(publicErrorSchema.safeParse({ error: { code: 'bad_request', message: 'Invalid payload' } }).success).toBe(
      true,
    );
  });
});
