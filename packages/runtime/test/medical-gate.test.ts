import { describe, expect, it } from 'vitest';
import { evaluateMedicalClaim } from '../src/scribe/medical-gate';

describe('medical claim gate', () => {
  it.each([
    'You should take aspirin.',
    'Start taking magnesium supplements.',
    'Take 5 mg of melatonin tonight.',
    'Stop your prescribed medication.',
    'Start taking ibuprofen today.',
    'Take vitamin D for this pattern.',
    'Take metformin now.',
    'Take Tylenol tonight.',
    'Begin taking a prescription drug.',
    'Take sertraline now.',
    'Start insulin today.',
    'Stop warfarin immediately.',
    'Take 20 milligrams of melatonin tonight.',
    'Double your insulin tonight.',
    'Take 20 units of insulin.',
    'Inject 12 IU of insulin tonight.',
    'Take a 20-unit dose of insulin.',
    'Administer twenty units of insulin.',
    'Inject 20 U of insulin.',
    'Take 5mg melatonin tonight.',
    'Use 2ml insulin.',
    'Take half a tablet of melatonin today.',
    'Take half of a tablet of melatonin today.',
    'Take one-half tablet of melatonin today.',
    'Take 1/2 tablet of melatonin today.',
    'Take ½ tablet of melatonin today.',
    'Use a quarter dose of insulin.',
    'Take .5 tablet of melatonin today.',
    'Take 0.5 tablet of melatonin today.',
    'Stop taking your metformin.',
    'Take 400 mg of magnesium tonight.',
  ])('denies medication, supplement and dose instructions: %s', (text) => {
    expect(evaluateMedicalClaim(text)).toEqual({ ok: false, reason: 'medical_claim' });
  });

  it.each([
    'Your recovery pattern suggests taking it easy today.',
    'Your body is showing stress signals.',
    'A short walk and an earlier bedtime may support recovery.',
    'Consider discussing persistent concerns with a qualified clinician.',
    'Take a short walk today.',
    'Take half a day to review the document.',
    'The recipe says take half a cup.',
    'Use half the tablet width in the layout.',
    'Take .5 day to review the document.',
    'Got it. Your gym is usually around 11 am, with evenings around 7:30-8 pm on days that do not fit.',
    'Want me to remind you to start your workout today at 11?',
    'Start stretching daily - even 5 minutes helps.',
    'You have gym at 11 and a call at 3.',
    'Try 3 sets of 12 squats and increase the weight next week.',
    'You slept 6h 10m last night, about 40 minutes less than your weekly average.',
    'Logged: oats, banana and two eggs for breakfast, about 450 kcal.',
    'Your resting heart rate data shows you have been recovering well this week.',
    'Sounds like work has been stressful. If anxiety keeps creeping in at night, a short wind-down routine might help.',
    'You mentioned your anxiety has been better since you started journaling.',
    'Depression is worth talking to a professional about if the low mood lasts.',
  ])('allows bounded wellness language: %s', (text) => {
    expect(evaluateMedicalClaim(text)).toEqual({ ok: true });
  });

  it.each([
    'Based on your data, you are at risk for heart disease.',
    'You have anxiety.',
    'These readings show depression.',
    'Your pulse indicates AFib.',
    'Your sleep data means you have sleep apnea.',
    'This blood pressure proves hypertension.',
    'Your glucose reading shows diabetes.',
    'You are stressed.',
    'Your symptoms indicate a medical condition.',
    'You may have a respiratory disorder.',
    'This is a symptom of pneumonia.',
    'Your HRV indicates cardiovascular disease.',
    'You should see a cardiologist because your recovery looks unusual.',
    'Based on your data, you could be at risk for stroke.',
    'This might be a symptom of pneumonia.',
    'This appears to be a symptom of pneumonia.',
    'You may have sleep apnea based on these readings.',
    'Sounds like you have anxiety.',
    'Your data suggests you might have insomnia.',
  ])('leaves diagnosis and risk judgment to the model: %s', (text) => {
    expect(evaluateMedicalClaim(text)).toEqual({ ok: true });
  });
});
