import { describe, expect, it } from 'vitest';
import { evaluateMedicalClaim } from '../src/scribe/medical-gate';

describe('medical claim gate', () => {
  it.each([
    'Based on your data, you are at risk for heart disease.',
    'You have anxiety.',
    'These readings show depression.',
    'Your pulse indicates AFib.',
    'Your sleep data means you have sleep apnea.',
    'This blood pressure proves hypertension.',
    'Your glucose reading shows diabetes.',
    'You are stressed.',
    'You should take aspirin.',
    'Start taking magnesium supplements.',
    'Take 5 mg of melatonin tonight.',
    'Stop your prescribed medication.',
    'Your symptoms indicate a medical condition.',
    'You may have a respiratory disorder.',
    'Start taking ibuprofen today.',
    'Take vitamin D for this pattern.',
  ])('denies immutable medical claims and direct treatment instructions: %s', (text) => {
    expect(evaluateMedicalClaim(text)).toEqual({ ok: false, reason: 'medical_claim' });
  });

  it.each([
    'Your recovery pattern suggests taking it easy today.',
    'Your body is showing stress signals.',
    'A short walk and an earlier bedtime may support recovery.',
    'Consider discussing persistent concerns with a qualified clinician.',
  ])('allows bounded wellness language: %s', (text) => {
    expect(evaluateMedicalClaim(text)).toEqual({ ok: true });
  });
});
