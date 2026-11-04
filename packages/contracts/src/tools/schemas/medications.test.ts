import { describe, expect, it } from 'vitest';
import { listMedicationsArgsSchema, logMedicationArgsSchema, stopMedicationArgsSchema, trackMedicationArgsSchema } from './medications';

const id = '6e900000-0000-4000-8000-000000000001';

describe('track_medication', () => {
  it.each([
    ['one daily time', { name: 'Metformin', times: ['08:00'] }],
    ["the owner's label with its amount, kept as said", { name: 'Metformin 500 mg', times: ['08:00'] }],
    ['two times, a supply and a reorder point', { name: 'Metformin', times: ['08:00', '20:00'], supply: 60, refill_at: 10 }],
    ['none left', { name: 'Metformin', times: ['08:00'], supply: 0 }],
    ['a change to one already tracked', { medication_id: id, name: 'Metformin', times: ['09:00'] }],
  ])('accepts %s', (_name, args) => {
    expect(trackMedicationArgsSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    ['no times', { name: 'Metformin', times: [] }],
    ['a time that repeats', { name: 'Metformin', times: ['08:00', '08:00'] }],
    ['a time past midnight', { name: 'Metformin', times: ['24:00'] }],
    ['a time without minutes', { name: 'Metformin', times: ['8'] }],
    ['seven times', { name: 'Metformin', times: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00'] }],
    ['a dose field', { name: 'Metformin', times: ['08:00'], dose: '500 mg' }],
    ['an amount field', { name: 'Metformin', times: ['08:00'], amount: 2 }],
    ['an instruction field', { name: 'Metformin', times: ['08:00'], instructions: 'with food' }],
    ['an empty name', { name: '', times: ['08:00'] }],
    ['a blank name', { name: '   ', times: ['08:00'] }],
    ['a name on two lines', { name: 'Metformin\nTake two', times: ['08:00'] }],
    ['a name over 80 characters', { name: 'x'.repeat(81), times: ['08:00'] }],
    ['a negative supply', { name: 'Metformin', times: ['08:00'], supply: -1 }],
    ['a reorder point of none', { name: 'Metformin', times: ['08:00'], refill_at: 0 }],
    ['an id that is not one of ours', { medication_id: 'm1', name: 'Metformin', times: ['08:00'] }],
  ])('refuses %s', (_name, args) => {
    expect(trackMedicationArgsSchema.safeParse(args).success).toBe(false);
  });
});

describe('log_medication, list_medications and stop_medication', () => {
  it('accepts a dose taken now, a dose skipped at a time, an empty list and a stop', () => {
    expect(logMedicationArgsSchema.safeParse({ medication_id: id, status: 'taken' }).success).toBe(true);
    expect(logMedicationArgsSchema.safeParse({ medication_id: id, status: 'skipped', at: '2026-11-02T08:00' }).success).toBe(true);
    expect(listMedicationsArgsSchema.safeParse({}).success).toBe(true);
    expect(stopMedicationArgsSchema.safeParse({ medication_id: id }).success).toBe(true);
  });

  it.each([
    ['a status it does not know', { medication_id: id, status: 'doubled' }],
    ['missed, which is never said', { medication_id: id, status: 'missed' }],
    ['no medication', { status: 'taken' }],
    ['a time with seconds', { medication_id: id, status: 'taken', at: '2026-11-02T08:00:00' }],
    ['an amount', { medication_id: id, status: 'taken', amount: 2 }],
  ])('refuses %s', (_name, args) => {
    expect(logMedicationArgsSchema.safeParse(args).success).toBe(false);
  });

  it('refuses arguments on a list and a stop without a medication', () => {
    expect(listMedicationsArgsSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(stopMedicationArgsSchema.safeParse({}).success).toBe(false);
  });
});
