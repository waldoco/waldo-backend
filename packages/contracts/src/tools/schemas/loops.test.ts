import { describe, expect, it } from 'vitest';
import { setTimezoneArgsSchema } from './loops';

describe('setTimezoneArgsSchema', () => {
  it.each(['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Asia/Calcutta', 'America/Argentina/Buenos_Aires'])('accepts the IANA zone %s', (timezone) => {
    expect(setTimezoneArgsSchema.parse({ timezone })).toEqual({ timezone });
  });

  it.each(['', 'IST', '+05:30', 'GMT+5:30', 'asia/kolkata', 'Mars/Olympus_Mons', 'Europe/London; drop', 'x'.repeat(65)])('rejects %j', (timezone) => {
    expect(setTimezoneArgsSchema.safeParse({ timezone }).success).toBe(false);
  });

  it('rejects a missing zone and any extra field', () => {
    expect(setTimezoneArgsSchema.safeParse({}).success).toBe(false);
    expect(setTimezoneArgsSchema.safeParse({ timezone: 'UTC', confirmed: true }).success).toBe(false);
  });
});
