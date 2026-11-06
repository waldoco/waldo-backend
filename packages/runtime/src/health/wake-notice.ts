import { healthSampleV1Schema } from '../../../contracts/src/app/health-ingest';

// WAKE_BRIEF: how recently a night must have ended for an upload or a wearable sync to count as "the owner just woke".
// Background delivery can lag the watch by up to two hours (ADR-0010), so the default leaves room for that; a night that
// ended longer ago is old news. Deployment config, in minutes.
export const wakeFreshMs = (raw: string | undefined): number => {
  const minutes = Number(raw);
  return (raw !== undefined && raw.trim() !== '' && Number.isInteger(minutes) && minutes > 0 ? minutes : 180) * 60_000;
};
// Device clocks drift; a night "ending" a few minutes ahead of the server is still one that just ended.
const CLOCK_SKEW_MS = 5 * 60_000;

// Whether these samples carry a night that ended just now: the last asleep interval's end, or the sample's own end when the
// night has no intervals. Only the yes leaves this function. The time itself is never returned, stored or logged, so the
// owner's waking time stays in the health plane (ADR-0081). Whether the owner is up for the day is the model's call.
export const sleepJustEnded = (samples: readonly unknown[], now: number, freshMs: number): boolean => samples.some((value) => {
  const sample = healthSampleV1Schema.safeParse(value);
  if (!sample.success || sample.data.signal !== 'sleep_duration') return false;
  const asleep = (sample.data.sleep_context?.intervals ?? []).filter((interval) => interval.kind === 'asleep');
  const end = asleep.length > 0 ? Math.max(...asleep.map((interval) => Date.parse(interval.end_at))) : Date.parse(sample.data.end_at);
  return end >= now - freshMs && end <= now + CLOCK_SKEW_MS;
});
