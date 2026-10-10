import { describe, expect, it } from 'vitest';
import { loadZoneSchema, recoveryZoneSchema, toRowZone } from '@waldo/contracts';
import { toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';

const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-28T10:00:00Z') };
const row = (recovery: string, weight: string): HealthContextRow => ({
  context: {
    id: 'ctx-1', day: '2026-09-28', form: { score: 72 }, recovery: { score: 70, zone: recovery }, weight: { score: 45, zone: weight },
    drivers: [], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: '2026-09-28T04:30:00.000Z',
  },
  previous: null,
});

describe('the writer bridge and the reader agree', () => {
  it('reads back, for every zone, the meaning the writer started with', () => {
    for (const recovery of recoveryZoneSchema.options) {
      for (const weight of loadZoneSchema.options) {
        const material = toContextHealthMaterial(row(toRowZone('recovery', recovery), toRowZone('weight', weight)), clock);
        expect(material?.narrative).toMatchObject({ recovery_descriptor: recovery, load_descriptor: weight });
      }
    }
  });
  it('reads a heavy day as heavy and a light day as light, not the reverse', () => {
    expect(toContextHealthMaterial(row('good', toRowZone('weight', 'heavy')), clock)?.narrative.load_descriptor).toBe('heavy');
    expect(toContextHealthMaterial(row('good', toRowZone('weight', 'light')), clock)?.narrative.load_descriptor).toBe('light');
  });
});
