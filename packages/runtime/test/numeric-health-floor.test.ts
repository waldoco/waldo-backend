import { describe, expect, it } from 'vitest';
import { numericHealthIn } from '../src/scribe/sanitiser';

// The floor that keeps measurements out of long-term memory and stored summaries. It refuses a write outright, so it must
// not fire on ordinary life that happens to put a number near a word a metric also uses. Synthetic values only.
describe('the numeric health floor', () => {
  it.each([
    'Needs to file Form 16 by July',
    'Visa form due 20 Oct',
    'Next steps for the 3 projects',
    'Pulse check meeting at 7',
    'Prefers a pulse check at 7 on Mondays',
    'Laundry load at 6',
    'Recovery week 2 of marathon plan',
    'Kids go to sleep after 30 minutes of reading',
    'Bedtime is 10:30 on school nights',
    'Takes 3 steps back before deciding',
    'HR team of 12 starts on Monday',
    'Carries a 20 kg bag to the gym',
    'The heat hit 38C in Delhi',
    'Runs the 5k on Sundays',
    'The owner has been sleeping badly this week and wants quieter mornings.',
  ])('lets an ordinary fact through: %s', (text) => {
    expect(numericHealthIn(text)).toBe(false);
  });

  // A metric written as a key with a colon is the structured shape a payload uses, so it holds even where the key is an
  // ordinary word; the compaction instruction asks for plain bullets for that reason.
  it('holds a key-and-number shape, as a payload writes it', () => {
    expect(numericHealthIn('Next steps: 1. Book the flights')).toBe(true);
    expect(numericHealthIn('{"hrv_ms": 48}')).toBe(true);
  });

  it.each([
    'HR was 52 bpm this morning',
    'resting HR 52',
    'My resting heart rate was 52 this morning',
    'heart rate 52',
    'HRV 48 ms',
    'hrv: 48',
    'SpO2 96%',
    'BP 120 over 80',
    'blood pressure 120/80',
    'BP was 135/85 mmHg',
    'I weigh 80 kg',
    'Weighs 72 kg',
    'weighs 176 lbs',
    'slept 6h',
    'Sleeps about 6h on work nights',
    'The owner said they slept 5 hours and felt rough.',
    'got 7 hours of sleep',
    'Ran a fever of 38.5C',
    '38.5C last night',
    '10,000 steps today',
    'Walked 8k steps',
    'A1c 6.1',
    'cholesterol 190',
    'glucose was 5.4 mmol/L',
    'fasting sugar 98 mg/dL',
    'recovery score 71',
    'recovery at 67%',
    'CRS 64',
    'respiratory rate 14',
    'calories burned 540',
  ])('holds a reading: %s', (text) => {
    expect(numericHealthIn(text)).toBe(true);
  });
});
