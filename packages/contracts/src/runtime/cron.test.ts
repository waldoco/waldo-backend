import { describe, expect, it } from 'vitest';
import { nextCronOccurrence, parseCronExpression } from './cron';

const parse = (expression: string) => {
  const schedule = parseCronExpression(expression);
  if (schedule === null) throw new Error(`test expression must parse: ${expression}`);
  return schedule;
};

describe('parseCronExpression', () => {
  it('parses wildcards, lists, ranges and steps', () => {
    const dailyNine = parse('0 9 * * *');
    expect(dailyNine.minutes).toEqual([0]);
    expect(dailyNine.hours).toEqual([9]);
    expect(dailyNine.daysOfMonth).toBeNull();
    expect(dailyNine.months).toHaveLength(12);
    expect(dailyNine.daysOfWeek).toBeNull();

    const quarterHour = parse('*/15 * * * *');
    expect(quarterHour.minutes).toEqual([0, 15, 30, 45]);

    const mixed = parse('5,20-25 9-17/2 1,15 1-6 1-5');
    expect(mixed.minutes).toEqual([5, 20, 21, 22, 23, 24, 25]);
    expect(mixed.hours).toEqual([9, 11, 13, 15, 17]);
    expect(mixed.daysOfMonth).toEqual([1, 15]);
    expect(mixed.months).toEqual([1, 2, 3, 4, 5, 6]);
    expect(mixed.daysOfWeek).toEqual([1, 2, 3, 4, 5]);

    // 0 and 7 both mean Sunday.
    expect(parse('0 0 * * 0').daysOfWeek).toEqual([0]);
    expect(parse('0 0 * * 7').daysOfWeek).toEqual([0]);
  });

  it('rejects invalid expressions', () => {
    expect(parseCronExpression('0 9 * *')).toBeNull(); // too few fields
    expect(parseCronExpression('0 9 * * * *')).toBeNull(); // too many
    expect(parseCronExpression('')).toBeNull();
    expect(parseCronExpression('61 9 * * *')).toBeNull(); // minute out of range
    expect(parseCronExpression('0 25 * * *')).toBeNull(); // hour out of range
    expect(parseCronExpression('0 9 0 * *')).toBeNull(); // day-of-month 0
    expect(parseCronExpression('0 9 * 13 *')).toBeNull(); // month out of range
    expect(parseCronExpression('0 9 * * 8')).toBeNull(); // day-of-week out of range
    expect(parseCronExpression('a b c d e')).toBeNull(); // names unsupported in v1
    expect(parseCronExpression('*/0 9 * * *')).toBeNull(); // zero step
    expect(parseCronExpression('5-1 9 * * *')).toBeNull(); // reversed range
    expect(parseCronExpression('0 9 * * *; rm -rf')).toBeNull(); // injection charset
  });
});

describe('nextCronOccurrence', () => {
  // 2026-09-26 12:00:00 UTC = 17:30 IST (Saturday).
  const nowUtc = Date.parse('2026-09-26T12:00:00Z');

  it('computes a daily time in the owner timezone', () => {
    const at = nextCronOccurrence(parse('0 9 * * *'), 'Asia/Kolkata', nowUtc);
    // Next 09:00 IST after 17:30 IST is the following day: 2026-09-27T03:30:00Z.
    expect(at).toBe(Date.parse('2026-09-27T03:30:00Z'));
  });

  it('fires today when the time is still ahead locally', () => {
    const at = nextCronOccurrence(parse('0 18 * * *'), 'Asia/Kolkata', nowUtc);
    expect(at).toBe(Date.parse('2026-09-26T12:30:00Z')); // 18:00 IST same day
  });

  it('steps minutes within the hour', () => {
    // 17:30 IST Saturday; */20 lands 17:40 IST.
    const at = nextCronOccurrence(parse('*/20 * * * *'), 'Asia/Kolkata', nowUtc);
    expect(at).toBe(Date.parse('2026-09-26T12:10:00Z'));
  });

  it('is strictly after now', () => {
    const onTheMinute = Date.parse('2026-09-26T03:30:00Z'); // exactly 09:00 IST
    const at = nextCronOccurrence(parse('0 9 * * *'), 'Asia/Kolkata', onTheMinute);
    expect(at).toBe(Date.parse('2026-09-27T03:30:00Z')); // next day, never the same instant
    // A later time the same day still fires today.
    expect(nextCronOccurrence(parse('30 9 * * *'), 'Asia/Kolkata', onTheMinute)).toBe(
      Date.parse('2026-09-26T04:00:00Z'),
    );
  });

  it('matches day-of-week in the owner timezone', () => {
    // Monday 09:00 IST from Saturday 17:30 IST -> 2026-09-28T03:30:00Z.
    const at = nextCronOccurrence(parse('0 9 * * 1'), 'Asia/Kolkata', nowUtc);
    expect(at).toBe(Date.parse('2026-09-28T03:30:00Z'));
  });

  it('applies standard cron OR semantics when day-of-month and day-of-week are both restricted', () => {
    // From 2026-09-26: the 13th is 2026-10-13; the next Friday is 2026-10-02. Either matches.
    const at = nextCronOccurrence(parse('0 9 13 * 5'), 'Asia/Kolkata', nowUtc);
    expect(at).toBe(Date.parse('2026-10-02T03:30:00Z'));
  });

  it('handles month edges and leap years', () => {
    // 1st of month 09:00 IST from 2026-09-26 -> 2026-10-01T03:30:00Z.
    expect(nextCronOccurrence(parse('0 9 1 * *'), 'Asia/Kolkata', nowUtc)).toBe(
      Date.parse('2026-10-01T03:30:00Z'),
    );
    // Feb 29 from a non-leap date: next is 2028-02-29 (2027 is not a leap year).
    const leap = nextCronOccurrence(parse('0 9 29 2 *'), 'Asia/Kolkata', Date.parse('2026-03-01T00:00:00Z'));
    expect(leap).toBe(Date.parse('2028-02-29T03:30:00Z'));
  });

  it('skips day-of-month values that a short month never reaches', () => {
    // 31st from 2026-04-05: April has 30 days; next is 2026-05-31.
    const at = nextCronOccurrence(parse('0 9 31 * *'), 'Asia/Kolkata', Date.parse('2026-04-05T00:00:00Z'));
    expect(at).toBe(Date.parse('2026-05-31T03:30:00Z'));
  });

  it('survives the spring-forward DST gap (America/New_York)', () => {
    // 2026-03-08: 02:30 does not exist in New York (clocks jump 02:00 -> 03:00).
    // Policy: advance to the next valid local minute of that day (03:00).
    const at = nextCronOccurrence(parse('30 2 * * *'), 'America/New_York', Date.parse('2026-03-07T12:00:00Z'));
    expect(at).toBe(Date.parse('2026-03-08T07:00:00Z')); // 03:00 EDT
  });

  it('fires at the first of two repeated local times (fall-back, America/New_York)', () => {
    // 2026-11-01: 01:30 happens twice (EDT then EST); the schedule fires at the first (EDT).
    const at = nextCronOccurrence(parse('30 1 * * *'), 'America/New_York', Date.parse('2026-10-31T12:00:00Z'));
    expect(at).toBe(Date.parse('2026-11-01T05:30:00Z')); // 01:30 EDT
  });

  it('returns null for an expression with no occurrence inside the scan bound', () => {
    // Feb 31 never exists.
    expect(nextCronOccurrence(parse('0 9 31 2 *'), 'Asia/Kolkata', nowUtc)).toBeNull();
  });
});
