import type { FormZone, LoadZone, RecoveryZone } from './crs';

// The stored read model (public.health_context_daily) keeps one zone vocabulary for every pillar.
// The writer maps the backend's meaning-bearing words into it and the reader maps them back, so the
// two share one table. Direction is by meaning: the better the recovery or form, the higher the
// stored word; the heavier the day's demand, the higher the stored word.
export const HEALTH_ROW_ZONES = ['low', 'moderate', 'good', 'high', 'unknown'] as const;
export type HealthRowZone = (typeof HEALTH_ROW_ZONES)[number];

type Pillar = 'recovery' | 'form' | 'weight';
type ZoneOf = { recovery: RecoveryZone; form: FormZone; weight: LoadZone };

const TO_ROW: { [P in Pillar]: Readonly<Record<ZoneOf[P], Exclude<HealthRowZone, 'unknown'>>> } = {
  recovery: { excellent: 'high', solid: 'good', mixed: 'moderate', compromised: 'low' },
  form: { energized: 'high', steady: 'good', flagging: 'moderate', depleted: 'low' },
  weight: { light: 'low', moderate: 'moderate', heavy: 'good', peak: 'high' },
};

export const toRowZone = <P extends Pillar>(pillar: P, zone: ZoneOf[P]): Exclude<HealthRowZone, 'unknown'> => TO_ROW[pillar][zone];

// An unknown or foreign stored word is absence, never a guess.
export const fromRowZone = <P extends Pillar>(pillar: P, word: unknown): ZoneOf[P] | null => {
  const table: Readonly<Record<string, string>> = TO_ROW[pillar];
  const zone = Object.keys(table).find(candidate => table[candidate] === word);
  return (zone as ZoneOf[P] | undefined) ?? null;
};
