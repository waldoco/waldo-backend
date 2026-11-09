import { healthReadSignalSchema, type HealthReadSignal } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { numericHealthIn, redactNumericHealth } from '../src/scribe/sanitiser';

// The one floor that keeps measurements from outside content out of memory, and out of stored summaries. A match drops the
// write, so precision wins over recall: it must not fire on ordinary life that puts a number near a word a metric also
// uses. Synthetic values only.
describe('the numeric health floor', () => {
  // A reply's label shapes: a day word with a colon, or a macro's own label, frames a reading as the owner's.
  it.each([
    'Yesterday: 1,022 kcal, 61 g protein',
    'Yesterday: 61 g protein, 140 g carbs',
    'Protein: 61 g',
    'Carbs: 140 g, fat: 52 g',
    'Yesterday: 72 kg',
    'Mon: 72.4 kg',
    'Today: 58 bpm resting',
    'Last night: 42 ms',
    'This morning: 97% SpO2',
    'Yesterday: 7.5 hours asleep',
    'Yesterday: 72 kg\nNice work this week',
    'Protein: 61 g\nAnything else?',
    '- Mon: 72.4 kg\n- Tue: 3 calls',
    'Yesterday: 72 kg!',
  ])('holds a reading framed by a label: %s', (text) => {
    expect(numericHealthIn(text)).toBe(true);
    expect(redactNumericHealth(text, '[H]')).not.toBe(text);
  });
  it.each([
    'Protein: 25 g per serving',
    'Protein: 25 g per 100 g',
    'Serving: 30 g',
    'Fat: 9 g / 100 g',
    'Today: 3 hours of meetings',
    'Yesterday: 20 kg of rice delivered',
    'Today: 15 kg bag to the airport',
    'Mon: 3 calls, Tue: 2 calls',
    'Yesterday: 2 hours on the train',
    'Today: 500 ms latency',
    'Sat: 60 ms ping',
    'Mon: 10 kg flour order',
    'Today: 5 kg laundry',
    'Sun: 100 kcal per bar',
    'Fat: 10 g butter',
    'Carbs: 30 g sugar',
  ])('lets a label that is not the owner\'s reading through: %s', (text) => {
    expect(numericHealthIn(text)).toBe(false);
  });

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
    'The movement meets in 30 minutes',
    'Daylight saving ends in 2 weeks',
    'Booked a 45-minute workout with the trainer at 6',
    'Booked a 45 minute workout for Friday',
    'Midpoint review at 3:30',
    'rem 5 min',
    'rem: 5 min left on the parking meter',
    'Listen to REM for 30 minutes',
    'Blocks 2h 30m of deep work before lunch',
    'Be mindful 10 min before the call',
    'Mindful 5 minutes before speaking',
    'Time awake 30 min before standup',
    'Fuel efficiency 91% on the highway',
    '600 kcal burned off by the run plan',
    '200 calories of active energy drink',
    'I am 50% awake',
    'Only 80% awake today',
    'Deep: 2h 30m focus block',
    'core 2h 30m session with the platform team',
    'Core 1h 30m, legs 45m at the gym',
    'Cellular respiration 101',
    'respiration 12 slides to review',
    'ETA 20 min rem',
    '10 min mindfulness break at 3pm',
    'A 15 min mindfulness session on Mondays',
    'Send HR to 45 Main St',
    '**Meeting with HR** — 10:30',
    '| Step | Owner |\n| 3 | Priya |',
    'Q3 — 45 deals closed',
    'Cardio fitness class 45 min on Tuesdays',
    'Cardio fitness 45 min on Tuesdays',
    '| HR | 12 |',
    'HR | 25 hires',
    'HR jumped to 30 candidates',
    'HR — 45 Main St',
    'Pulse — 15 min standup',
    'Steps — 1500 words',
    'Recovery — 80% of the budget',
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

  // Every signal get_health returns, in the units it returns it in, as Waldo relays it or the owner repeats it.
  const GET_HEALTH_READINGS: Record<HealthReadSignal, readonly string[]> = {
    sleep: ['time asleep 412 min', '412 minutes asleep', 'sleep duration 412 minutes', 'slept 6.9 hours'],
    sleep_midpoint: ['sleep midpoint 03:12', 'sleep midpoint was 192'],
    hrv: ['HRV 48ms', 'HRV was 48ms', 'HRV (rmssd) 48 ms', 'HRV sdnn 52', 'rmssd 48'],
    resting_hr: ['resting heart rate 58 bpm', 'resting HR 58'],
    heart_rate: ['mean heart rate 72.4 bpm', 'average heart rate 72'],
    movement: ['movement 45 minutes', '45 minutes of movement', '45 movement minutes'],
    daylight: ['daylight 30 min', '30 minutes of daylight', '30 daylight minutes'],
    workouts: ['45 workout minutes', 'workouts: 45 min', '45 minutes of workouts'],
    sleep_light: ['light sleep 210 min', '210 minutes of light sleep', 'Slept 7h 10m: core 3h 40m', 'light sleep 52%'],
    sleep_deep: ['deep sleep 85 min', '85 minutes of deep sleep', 'deep 1h 10m of sleep', 'Deep 1h 10m, REM 1h 35m'],
    sleep_rem: ['REM sleep 95 min', '95 minutes of REM sleep', 'REM 95 min', 'REM: 95 min', 'REM was 95 min', 'REM was 1h 35m', '1h 35m REM', '95 min REM', 'Got 1h 35m of REM', 'REM 22%'],
    sleep_awake: ['awake 25 min overnight', '25 minutes awake overnight', 'time awake 25 min', 'awake time 25 min', 'awake for 25 min during the night', 'slept with 12% awake time', 'was awake 25 minutes last night'],
    sleep_efficiency: ['sleep efficiency 0.91', 'sleep efficiency 91%', '91% sleep efficiency', 'sleep efficiency of 91 percent', 'slept at 91% efficiency', 'sleep efficiency 91'],
    respiratory_rate: ['respiratory rate 14.2 breaths per minute', '14 breaths per minute', 'breathing rate 15', '14 breaths/min', 'respiration 14/min', 'respiration rate 14', 'resp rate 14', 'breathing 14 per minute'],
    spo2: ['SpO2 97%', 'blood oxygen 96 percent', 'oxygen saturation 95%'],
    wrist_temperature: ['wrist temperature 36.4 °C', 'wrist temperature +0.3 °C from baseline', 'wrist temp 0.3 degrees above baseline', 'wrist temp up 0.4°', 'wrist temp rose 0.4°C', 'wrist temp was up 0.4 degrees', '+0.4°C wrist temperature'],
    walking_hr: ['walking heart rate 98 bpm', 'walking HR 98'],
    hr_recovery: ['heart rate recovery 24 bpm', 'HR recovery 24', 'heart rate recovery was 24', 'HRR 24', 'heart-rate recovery 24', 'HR recovery 9'],
    vo2_max: ['VO2 max 42', 'VO2 max 42.5 ml/kg/min'],
    steps: ['8,500 steps', 'steps 8500', '8.5k steps'],
    active_energy: ['active energy 540 kcal', '540 kcal of active energy', 'active energy 540', 'burned 540 active kcal', '540 active kcal', 'active calories 540', 'active kcal 540', '540 kcal active', 'Move 540 kcal'],
    mindful: ['mindful minutes 15', '15 minutes of mindfulness', '15 mindful minutes', '15 min mindfulness', 'mindfulness 15 min'],
    body_mass: ['body mass 72.4 kg', 'weighed 72.4 kg', 'weight: 72.4', 'body mass 72.4'],
    body_fat: ['body fat 14.2%', 'body fat percentage 14.2', '14% body fat', 'body fat was 14.2 percent'],
    lean_body_mass: ['lean body mass 61.9 kg', 'lean mass 61.9 kg', 'lean mass was 62'],
    stand_hours: ['stand hours 9', '9 stand hours', 'stood in 9 of 12 hours'],
    food_energy: ['food energy 2,100 kcal', 'you ate 2100 kcal', '2100 calories eaten', 'calorie intake 2100', 'intake was 2100 kcal', '2,100 kcal of food',
      'You logged 1,202 kcal yesterday', 'your lunch was 612 kcal', 'food_energy 1202 kcal', 'your food app had 1,202 kcal', "I've had 1800 calories", '1202 kcal logged'],
    protein: ['protein intake 120 g', 'you had 120 g of protein', 'your protein was 61 g', '61 g protein yesterday', 'protein 120 g today', 'I logged 120g protein'],
    carbs: ['carb intake 250 g', '250 g of carbs today', 'your carbs were 250g', 'you had 250 grams of carbohydrate'],
    fat: ['fat intake was 70 g', '70 g fat yesterday', 'your fat was 70 grams', 'you logged 70g fat'],
  };
  // A label, a recipe or someone else's meal is not the owner's reading: a false match would drop a whole task result.
  it.each(['the recipe needs 120 g of flour', 'carbs are fine before a run', 'fat chance by 3pm', 'protein bar at 4', 'ate at 8 with the team', 'ate 3 apples', 'intake form 2', 'body fat jokes', '500 calories of work emails',
    'Each serving: 25 g protein', 'the recipe calls for 70 g of fat', 'this bar has 20g protein', 'nutrition label: carbs 45 g', 'Sale: protein 500 g tub', 'the dog ate 200 calories of kibble', 'Team ate 3,000 calories of pizza'])('leaves an ordinary food sentence alone: %s', (text) => {
    expect(numericHealthIn(text)).toBe(false);
  });
  // A workout session as get_health lists it, relayed: its heart rate and its minutes in each zone.
  it.each(['average heart rate 152 bpm on the run', 'avg HR 152', 'max HR 181', 'peak heart rate 181', '25 minutes in zone 3', 'zone 2: 15 min', '15 min in heart rate zone 2'])('holds a workout session reading: %s', (text) => {
    expect(numericHealthIn(text)).toBe(true);
  });
  it.each(['stood in line for 2 hours', 'stand-up at 9', 'zone 3 meeting room at 10', 'the max HR headcount is 12', 'lean startup chapter 3', 'body fat jokes'])('leaves an ordinary sentence alone: %s', (text) => {
    expect(numericHealthIn(text)).toBe(false);
  });
  // Lab results as a report or a clinic mail sets them out: a value with its unit, a reference range, a high or low flag.
  const LAB_READINGS: Record<string, readonly string[]> = {
    tsh: ['TSH 4.8 mIU/L', 'TSH: 6.2 (0.4-4.0) H', 'Thyroid stimulating hormone (TSH) 3.1 uIU/mL', 'Your TSH result was 5.9', '| TSH | 4.8 | mIU/L | 0.4 - 4.0 |', 'TSH (ultrasensitive) 4.8', 'TSH 6', 'TSH 5\nT3 1.2'],
    vitamin_d: ['Vitamin D 18 ng/mL', '25-OH Vitamin D: 42 nmol/L (75-200) L', 'Vitamin D (25-OH) 18', 'Vit D3 31 ng/ml', 'Vitamin D 18 (30-100)', 'Vitamin D: 12 (<20)'],
    haemoglobin: ['Haemoglobin 11.2 g/dL', 'Hemoglobin: 135 g/L', 'Hb 10.9 g/dL L', 'Hgb 14.1', 'haemoglobin of 9.8', 'Hb 10.9 → 11.4 g/dL', 'Hb 9.8 L'],
    egfr: ['eGFR 58 mL/min/1.73m2', 'eGFR: >90', 'eGFR 45 (>60) L', 'eGFR was 72'],
    creatinine: ['Creatinine 1.3 mg/dL', 'Serum creatinine 112 umol/L (H)', 'creatinine was 0.9', 'Creatinine: 88 µmol/L', 'Creatinine, serum 1.3'],
    psa: ['PSA 4.5 ng/mL', 'PSA: 6.1 (0-4.0) H', 'Total PSA 2.1 ng/mL', 'PSA level 3.2', 'PSA 5 (H)'],
    ferritin: ['Ferritin 12 ng/mL', 'Ferritin: 8 µg/L L', 'ferritin is 15', 'Ferritin 210 (30-400)'],
  };
  it.each(Object.entries(LAB_READINGS).flatMap(([analyte, texts]) => texts.map((text) => [analyte, text])))('holds a %s lab reading: %s', (_analyte, text) => {
    expect(numericHealthIn(text)).toBe(true);
  });
  it.each([
    'PSA: 3 things to know before the offsite',
    'PSA 2 pm meeting moved to Friday',
    'Office PSA went out on 12/10',
    'Hb pencils, 2 packs',
    'Vitamin D3 1000 IU, one capsule daily.',
    'Vitamin D 60000 IU once a week for 8 weeks',
    'Book the TSH test for 12/10 at 8:30',
    'Ferritin test booked for 9am on 14 Nov',
    'The creatinine panel costs 450 rupees',
    'eGFR explained in 5 minutes',
    'Order #4821 for vitamin D gummies, $12.99',
    'Haemoglobin talk at 10:30 in room 204',
    // A dose, a date, a year or a count after the name, and a flag word that starts a compound.
    'Vitamin D3 60k sachet weekly',
    'vitamin D 60K once a week',
    'Take Vitamin D3 60K',
    'Vitamin D 400 daily',
    'Vitamin D 2 drops daily',
    'Vitamin D: 2 sachets a month',
    'TSH 14 Nov',
    'TSH 2024 report attached',
    'eGFR 2021 equation',
    'Hb 2 L of water',
    'PSA 2 h left',
    'Hgb 3 slides in the deck',
    'PSA: 3 high-priority items',
    'PSA 2 low-hanging fruits',
    'Set the pump at 200 ml/min',
    // A dose or a shopping list ends a sentence with a whole number the way a result ends a line.
    'Take Vitamin D 3.',
    'Remind me to buy Vitamin D 3',
    'Pick up Vitamin D 2!',
    'Vitamin D 3, zinc and magnesium',
    'Vitamin D3 5000',
    'Vitamin D 1000',
    'vitamin D 600.',
    'Hgb 3.',
    'ferritin 2.',
    'TSH 3)',
    // Plain vitamin D with a dose, a count, a price or a brand name in brackets.
    'Vitamin D 1000 (2 caps daily)',
    'Buy Vitamin D 1000 high strength',
    '| Vitamin D3 | 2 | ₹499 |',
    'Take Vitamin D: 1 cap',
    'Vitamin D is 1 of 3 supplements',
    'Vitamin D3 (60K) 4',
    'Vitamin D (cholecalciferol) 1000',
  ])('leaves a lab-adjacent ordinary sentence alone: %s', (text) => {
    expect(numericHealthIn(text)).toBe(false);
  });
  it.each([
    ['Ferritin 12\nTSH 6', ['12', '6']],
    ['Hb 10.9 → 11.4 g/dL', ['10.9', '11.4']],
  ])('redacts every lab value in %s', (text, values) => {
    const redacted = redactNumericHealth(text, '[H]');
    for (const value of values) expect(redacted).not.toContain(value);
  });
  it('covers every signal get_health returns', () => {
    expect(Object.keys(GET_HEALTH_READINGS).sort()).toEqual([...healthReadSignalSchema.options].sort());
  });
  it.each(Object.entries(GET_HEALTH_READINGS).flatMap(([signal, texts]) => texts.map((text) => [signal, text])))('holds a %s reading: %s', (_signal, text) => {
    expect(numericHealthIn(text)).toBe(true);
  });
  // The shapes a relay takes in a reply or a summary: markdown labels, table rows, dashes, a trend, Apple's own names.
  it.each([
    '**HRV:** 42 ms',
    '**HRV**: 42 ms',
    '**Sleep:** 6h 40m',
    '**SpO2:** 96%',
    '- **Deep sleep:** 1h 10m',
    '*REM:* 1h 35m',
    '| HRV | 42 ms |',
    '| Resting HR | 58 |',
    'HRV — 42 ms',
    'HRV – 42',
    'Resting HR — 58',
    'SpO2 — 96%',
    'Respiratory rate — 14.5',
    'HRV dropped to 35 ms',
    'HRV fell from 48 to 35',
    'your HRV rose to 51',
    'Resting heart rate climbed to 61',
    'heart rate recovery dropped to 18',
    'Weight went down to 72 kg',
    'Cardio fitness 41.2',
    'Cardio Fitness (VO2 max) 40.5 ml/kg/min',
    'VO₂ max 42',
    'HRV - 42 ms',
    '_HRV_: 42 ms',
    '`HRV`: 42 ms',
    '| HRV | 42 | 45 |',
    '| HRV | today | 42 ms |',
    '| Resting HR | Mon | 58 bpm |',
    'SpO₂ 96%',
    '**Steps:** 8,432',
    'HRV declined to 35 ms',
    'HRV went from 48 to 35',
  ])('holds a relayed reading: %s', (text) => {
    expect(numericHealthIn(text)).toBe(true);
  });
  it('holds a VO2 max reading', () => {
    expect(numericHealthIn('VO2 max 45')).toBe(true);
  });

  // A serialized field (a quoted key, an `=`, or a glued snake or camel key) carrying a number is a payload's shape; a
  // colon after an ordinary word in prose is not.
  it.each(['{"hrv_ms": 48}', '"steps": 8432', 'heartRate=88', 'restingHeartRate: 52', 'weight_kg: 82'])('holds a serialized health field: %s', (text) => {
    expect(numericHealthIn(text)).toBe(true);
  });
});

// Shapes a relay or a summary gives a reading that the gate on the floor found still passing. Synthetic values.
describe('readings tied by an arrow, a trend word, or a number before the label', () => {
  it.each([
    'HRV → 42 ms', 'HRV ↓ 35', 'HRV ↑ 52 ms', 'HRV slipped to 35', 'HRV now 35', '42 ms HRV', 'resting HR now 61',
    // A night's sleep said as one, whatever follows it: "until" or "before" makes a plan only after bare wording.
    'sleep was 6 hours until the alarm', 'Sleep averaged 6 hours before the trip', 'Your sleep: 7 hours until 6:10',
    'sleep was 5.5 h before the race', 'Sleep: 6 h till the alarm',
    // A habit said in the present tense is a reading too, and so is a plan's duration: both redact as beta-mvp does.
    'I usually sleep 5 hours before work', 'I sleep 5 hours before night shifts', 'sleeps 7 hours before work',
    'He sleeps 4 hours before every exam', 'sleeping 5 hours before shifts all week', "I've been sleeping 4 hours before every deadline",
    'Sleep — 8 hours before the flight', 'sleep for 8 hours before the flight',
  ])('holds %s', (text) => {
    expect(numericHealthIn(text)).toBe(true);
  });
  it.each([
    'Weight — 20 kg suitcase', 'Now 35 people are coming',
    'Moved 42 ms of latency off the hot path', 'HR → 30 candidates', 'HR ↑ 12 roles', '42 ms HRV-style jitter',
  ])('leaves %s alone', (text) => {
    expect(numericHealthIn(text)).toBe(false);
  });
});

describe('trace redaction takes every value a reading carries', () => {
  it.each([
    ['| HRV | 42 | 45 | 48 |', ['42', '45', '48']],
    ['HRV 42 → 38 → 35', ['42', '38', '35']],
    ['HRV was 48, now 35', ['48', '35']],
    ['HRV → 42 ms', ['42']],
    ['42 ms HRV', ['42']],
    ['HRV 42 ms → 38 ms → 35 ms', ['42', '38', '35']],
    ['HRV 42, 45, 48', ['42', '45', '48']],
    ['HRV went from 48 down to 35', ['48', '35']],
    ['HRV 48 ⬇ 35', ['48', '35']],
    ['HRV 48 ↘ 35', ['48', '35']],
    ['HRV 48 => 35', ['48', '35']],
  ])('%s', (text, values) => {
    const redacted = redactNumericHealth(text, '[W]');
    expect(redacted).toContain('[W]');
    for (const value of values) expect(redacted).not.toContain(value);
  });

  it.each([
    ['Owner slept 7h, 3 meetings today and a run at 6.', '3 meetings'],
    ['Your resting HR was 61, 2 meetings moved to Friday.', '2 meetings'],
    ['HRV 42 ms, 1 meeting moved.', '1 meeting'],
  ])('stops at a count after a comma: %s', (text, kept) => {
    const redacted = redactNumericHealth(text, '[W]');
    expect(redacted).toContain('[W]');
    expect(redacted).toContain(kept);
  });

  it('stops at a clock time in the next cell', () => {
    const redacted = redactNumericHealth('Resting HR 61 | 10:30 check-in', '[W]');
    expect(redacted).not.toContain('61');
    expect(redacted).toContain('10:30');
  });
});
