import { describe, expect, it } from 'vitest';
import { APP_CONTROLS_MEMORY_SIGNAL_REVISION, appControlProjectionV1Schema } from './controls';
import fixture from './fixtures/day-memory-revision.v1.json';

const day = (memory_revision: unknown) => appControlProjectionV1Schema.safeParse({ ...fixture.day, data: { ...fixture.day.data, memory_revision } }).success;

describe('controls revision 8: the memory-change signal on the day view', () => {
  it('is revision 8', () => expect(APP_CONTROLS_MEMORY_SIGNAL_REVISION).toBe(8));

  it('reads the fixture, a fresh owner\'s zero, and a day without the field', () => {
    expect(appControlProjectionV1Schema.safeParse(fixture.day).success).toBe(true);
    expect(day(0)).toBe(true);
    const { memory_revision: _gone, ...older } = fixture.day.data;
    expect(appControlProjectionV1Schema.safeParse({ ...fixture.day, data: older }).success).toBe(true);
  });

  it('refuses a negative, fractional, textual or unbounded count', () => {
    for (const value of [-1, 1.5, '42', null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) expect(day(value)).toBe(false);
  });
});
