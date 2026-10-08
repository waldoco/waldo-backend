import { describe, expect, it } from 'vitest';
import { standingGrantSchema } from './standing-grant';

export const grant = {
  id: 'reminders-sam', owner_ref: 'owner', area: 'mail', action: 'send_email',
  constraints: { recipients: ['sam@example.com'], accounts: ['personal'], content_kinds: ['reminder'] },
  mode: 'auto', created_from: { surface: 'telegram', message_ref: 'message-1' }, revision: 1,
};

describe('standing grant contract', () => {
  it('records the exact permission and owner instruction', () => {
    expect(standingGrantSchema.parse(grant)).toEqual(grant);
  });
  it.each([
    { owner_ref: '' }, { area: 'anything' }, { action: '' }, { mode: 'sometimes' },
    { revision: 0 }, { created_from: { surface: 'telegram', message_ref: '' } },
    { constraints: { max_per_day: -1 } }, { constraints: { max_per_day: 1.5 } },
    { constraints: { recipients: [] } }, { constraints: { recipients: [''] } },
    { constraints: { content_kinds: ['promotional'] } },
    { constraints: { amount_max: { currency: '', value: 10 } } },
    { constraints: { amount_max: { currency: 'USD', value: -1 } } },
    { expires_at: '2026-11-01T01:30:00' }, { revoked_at: 'yesterday' }, { invented: true },
  ])('rejects malformed permission %j', (change) => {
    expect(standingGrantSchema.safeParse({ ...grant, ...change }).success).toBe(false);
  });
  it('keeps expiry timezone offsets through a repeated DST hour', () => {
    expect(standingGrantSchema.parse({ ...grant, expires_at: '2026-11-01T01:30:00-04:00' }).expires_at)
      .toBe('2026-11-01T01:30:00-04:00');
  });
});
