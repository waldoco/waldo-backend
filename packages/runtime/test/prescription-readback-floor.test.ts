import { describe, expect, it } from 'vitest';
import { replyGate } from '../src/conversation/reply-gate';
import { HEALTH_SPAN_MARKER, numericHealthIn, redactNumericHealth, sanitise } from '../src/scribe/sanitiser';

// Reading a prescription or medicine label back to the owner is ruled in (the voice rule and an eval govern it, with no
// runtime refusal). These cases record where the numeric health floor stands against label text, so a label read-back is
// never silently held. Drug names and strengths are synthetic.
const PLAIN_LABELS = [
  'The label says 500 mg twice daily.',
  'Norvelta 25 mg, one tablet at night after food, for 14 days.',
  'It says take 1 tablet every 8 hours with water.',
  'Label: 5 ml of the syrup three times a day.',
  'The strip says 0.5 mg/ml, shake well before use.',
  'Atorvastatin 10 mg for cholesterol, one at night.',
  'Take 2 tablets for fever, 650 mg each.',
];

// A condition word directly before a strength reads as a measurement ("blood pressure 50 mg"), and a glucose unit is one.
const CONDITION_LABELS = [
  'Blood pressure: 50 mg once daily.',
  'Glucose 500 mg with meals.',
  'Metformin 500 mg, check blood glucose 100 mg/dL before the evening dose.',
];

const canaries = ['1111111111111111', '2222222222222222', '3333333333333333'];
const gate = replyGate({ sanitise, canaries, topics: [] });

describe('the numeric health floor against a prescription label read back', () => {
  it.each(PLAIN_LABELS)('does not hold %s', (label) => {
    expect(numericHealthIn(label)).toBe(false);
    expect(redactNumericHealth(label, HEALTH_SPAN_MARKER)).toBe(label);
  });

  it.each(PLAIN_LABELS)('lets the owner-reply gate through %s', async (label) => {
    await expect(gate(label)).resolves.toMatchObject({ ok: true });
  });

  it('lets the owner-reply gate through a label that names a condition, because owner-channel replies are not scanned for readings', async () => {
    for (const label of CONDITION_LABELS) await expect(gate(label)).resolves.toMatchObject({ ok: true });
  });

  // The floor does act on text quoted back to a model (iMessage reply and tapback quotes) and on memory, task and trace
  // writes, so a label with a measurement unit is withheld there.
  it.each(CONDITION_LABELS)('withholds a measurement in %s where the floor applies', (label) => {
    expect(numericHealthIn(label)).toBe(true);
    expect(redactNumericHealth(label, HEALTH_SPAN_MARKER)).toContain(HEALTH_SPAN_MARKER);
  });
});
