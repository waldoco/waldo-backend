import type { LLMRequest } from '@waldo/contracts';

// Web search is located by the owner's own time zone. Beta owners are in India, so a zone left unset keeps India.
const INDIA_ZONES = new Set(['Asia/Kolkata', 'Asia/Calcutta']);
export const searchLocation = (timezone: string): NonNullable<LLMRequest['web_search']> =>
  timezone === 'UTC' ? { country: 'IN' } : INDIA_ZONES.has(timezone) ? { country: 'IN', timezone } : { timezone };
