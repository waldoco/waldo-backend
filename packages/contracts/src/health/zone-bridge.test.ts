import { describe, expect, it } from 'vitest';
import { formZoneSchema, loadZoneSchema, recoveryZoneSchema } from './crs';
import { fromRowZone, HEALTH_ROW_ZONES, toRowZone } from './zone-bridge';

describe('health row zone bridge', () => {
  it('pins the stored zone vocabulary', () => {
    expect([...HEALTH_ROW_ZONES]).toEqual(['low', 'moderate', 'good', 'high', 'unknown']);
  });
  it('round-trips every zone of every pillar', () => {
    for (const zone of recoveryZoneSchema.options) expect(fromRowZone('recovery', toRowZone('recovery', zone))).toBe(zone);
    for (const zone of formZoneSchema.options) expect(fromRowZone('form', toRowZone('form', zone))).toBe(zone);
    for (const zone of loadZoneSchema.options) expect(fromRowZone('weight', toRowZone('weight', zone))).toBe(zone);
  });
  it('writes distinct stored words for the four zones of a pillar', () => {
    for (const [pillar, zones] of [['recovery', recoveryZoneSchema.options], ['form', formZoneSchema.options], ['weight', loadZoneSchema.options]] as const) {
      expect(new Set((zones as readonly string[]).map(zone => toRowZone(pillar, zone as never))).size).toBe(4);
    }
  });
  it('keeps direction by meaning: the better the recovery, the higher the stored word', () => {
    expect(toRowZone('recovery', 'excellent')).toBe('high');
    expect(toRowZone('recovery', 'compromised')).toBe('low');
    expect(toRowZone('form', 'energized')).toBe('high');
    expect(toRowZone('form', 'depleted')).toBe('low');
  });
  it('keeps direction by meaning for demand: the heavier the day, the higher the stored word', () => {
    expect(toRowZone('weight', 'light')).toBe('low');
    expect(toRowZone('weight', 'moderate')).toBe('moderate');
    expect(toRowZone('weight', 'heavy')).toBe('good');
    expect(toRowZone('weight', 'peak')).toBe('high');
  });
  it('reads an unknown or foreign word as absence, never a guess', () => {
    expect(fromRowZone('recovery', 'unknown')).toBeNull();
    expect(fromRowZone('weight', 'peak')).toBeNull();
    expect(fromRowZone('form', 'excellent')).toBeNull();
    expect(fromRowZone('recovery', 7)).toBeNull();
    expect(fromRowZone('recovery', undefined)).toBeNull();
  });
});
