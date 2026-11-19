import { describe, expect, it } from 'vitest';
import { WEATHER_ATTRIBUTION_V1, weatherV1Schema } from './weather';

// Synthetic values.
const available = {
  state: 'available', now: { temperature_c: 27.4, condition: 'PartlyCloudy' }, today: { high_c: 31, low_c: 22.5 },
  as_of: '2026-11-19T08:29:00Z', attribution: WEATHER_ATTRIBUTION_V1,
};

describe('weatherV1Schema', () => {
  it('takes each state in the shape the app pinned', () => {
    expect(weatherV1Schema.safeParse(available).success).toBe(true);
    for (const reason of ['consent_required', 'consent_withdrawn']) expect(weatherV1Schema.safeParse({ state: 'consent', reason }).success).toBe(true);
    for (const reason of ['no_place', 'not_linked', 'provider_unavailable']) expect(weatherV1Schema.safeParse({ state: 'unavailable', reason }).success).toBe(true);
  });

  it('refuses a place, a stray field, a number on a refusal, another provider name and an impossible temperature', () => {
    const refused = [
      { ...available, place: { locality: 'Testville' } },
      { ...available, now: { ...available.now, cell: 'tdr1v' } },
      { state: 'unavailable', reason: 'provider_unavailable', now: available.now },
      { state: 'consent', reason: 'no_place' },
      { ...available, attribution: { ...WEATHER_ATTRIBUTION_V1, name: 'Weather Co' } },
      { ...available, attribution: { ...WEATHER_ATTRIBUTION_V1, legal_url: 'not a url' } },
      { ...available, now: { ...available.now, temperature_c: 61 } },
      { ...available, today: { ...available.today, low_c: -91 } },
      { ...available, now: { ...available.now, condition: '' } },
      { ...available, as_of: '19 Nov 2026' },
      { state: 'available' },
    ];
    for (const body of refused) expect(weatherV1Schema.safeParse(body).success).toBe(false);
  });
});
