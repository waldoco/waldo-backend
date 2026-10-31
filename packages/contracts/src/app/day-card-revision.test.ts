import { describe, expect, it } from 'vitest';
import { pushNotificationSchema } from '../ui/notification';
import { APP_CONTROLS_DAY_CARD_REVISION, appControlProjectionV1Schema } from './controls';
import fixture from './fixtures/day-card-revision.v1.json';

const [card] = fixture.day.data.cards;
const day = (fields: Record<string, unknown>) => appControlProjectionV1Schema.safeParse({ ...fixture.day, data: { ...fixture.day.data, cards: [{ ...card, ...fields }] } }).success;

describe('controls revision 9: a delivered day card Waldo revised', () => {
  it('is revision 9', () => expect(APP_CONTROLS_DAY_CARD_REVISION).toBe(9));

  it('reads the fixture and its push, and a card never revised', () => {
    expect(appControlProjectionV1Schema.safeParse(fixture.day).success).toBe(true);
    expect(pushNotificationSchema.safeParse(fixture.push).success).toBe(true);
    const { revision: _revision, revised_at: _at, ...original } = card!;
    expect(appControlProjectionV1Schema.safeParse({ ...fixture.day, data: { ...fixture.day.data, cards: [original] } }).success).toBe(true);
  });

  it('carries revision and revised_at together or not at all', () => {
    expect(day({ revision: undefined })).toBe(false);
    expect(day({ revised_at: undefined })).toBe(false);
  });

  it('refuses a zero, fractional or textual count, and a time that is not epoch ms', () => {
    for (const revision of [0, -1, 1.5, '1', null]) expect(day({ revision })).toBe(false);
    for (const revised_at of [0, -5, 1.5, '2026-10-31T09:00:00Z', null]) expect(day({ revised_at })).toBe(false);
  });
});
