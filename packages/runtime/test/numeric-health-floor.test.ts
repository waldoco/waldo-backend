import { describe, expect, it } from 'vitest';
import { numericHealthIn } from '../src/scribe/sanitiser';

// The one floor that keeps measurements from outside content out of memory, and out of stored summaries. A match drops the
// write, so precision wins over recall: it must not fire on ordinary life that puts a number near a word a metric also
// uses. Synthetic values only.
describe('the numeric health floor', () => {
  it.each([
    'Needs to file Form 16 by July',
    'Form 16',
    'Visa form due 20 Oct',
    'Next steps for the 3 projects',
    'Pulse check meeting at 7',
    'Prefers a pulse check at 7 on Mondays',
    'Laundry load at 6',
    'load 3',
    'Recovery week 2 of marathon plan',
    'Kids go to sleep after 30 minutes of reading',
    'Bedtime is 10:30 on school nights',
    'Takes 3 steps back before deciding',
    'HR team of 12 starts on Monday',
    'Carries a 20 kg bag to the gym',
    'The heat hit 38C in Delhi',
    'Runs the 5k on Sundays',
    'The owner has been sleeping badly this week and wants quieter mornings.',
    'Claims Section 80C before March',
    'Flight 6E 204 leaves at 06:40',
    'Room 52 at the Taj',
    'Wants the 16 GB plan',
    'Takes the 38 bus to work',
    'Invoice #94 is still unpaid',
    'Q3 2026 targets are due',
    'Level 5 meeting room is booked',
    'Dentist on 12/10 at 3:30',
    'Rent is $1,850 on the 1st',
    'Lunch at 12:30, budget 540 rupees',
    'Call +91 98765 43210 after 6',
    'Meeting with HR at 10:30',
    'Meeting with HR at 10',
    'HR: 555 0100',
    'Has a meeting in 1 hr 30',
    'Checks resting heart rate at 7am',
    'Blood pressure check at 9am',
    'Baggage weight is 23 kg',
    'The suitcase weighs 23 kg',
    'The laptop weighs 1.4 kg',
    'Do steps 3 and 4 of the visa form',
    'Motion 2 passed at the board meeting',
    'Next steps: 1. Book the flights',
    'BP station is open 24/7',
    'Oven temp 180 degrees for the cake',
    'Goa is 32 degrees, temperature 32C at noon',
    'The cabin sleeps 6',
  ])('lets an ordinary fact through: %s', (text) => {
    expect(numericHealthIn(text)).toBe(false);
  });

  it.each([
    'HRV 38 ms',
    'resting heart rate 52',
    'slept 5h 20m',
    'SpO2 94%',
    'BP 130/85',
    'weight 72 kg',
    'HR was 52 bpm this morning',
    'resting HR 52',
    'My resting heart rate was 52 this morning',
    'heart rate 52',
    'HRV 48 ms',
    'hrv: 48',
    'pulse: 72',
    'HR 64',
    'SpO2 96%',
    'BP 120 over 80',
    'blood pressure 120/80',
    'BP was 135/85 mmHg',
    'systolic 138',
    'I weigh 80 kg',
    'Weighs 72 kg',
    'weighs 176 lbs',
    'weight: 82',
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

  // A serialized field (a quoted key, an `=`, or a glued snake or camel key) carrying a number is a payload's shape; a
  // colon after an ordinary word in prose is not.
  it.each(['{"hrv_ms": 48}', '"steps": 8432', 'heartRate=88', 'restingHeartRate: 52', 'weight_kg: 82'])('holds a serialized health field: %s', (text) => {
    expect(numericHealthIn(text)).toBe(true);
  });
});
