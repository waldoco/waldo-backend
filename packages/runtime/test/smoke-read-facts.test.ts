import { describe, expect, it } from 'vitest';
import { matchesSmokeMailFacts } from '../scenarios/smoke-read-facts';
const source = { subject: 'Fixture status', from: 'fictional-sender@example.invalid', snippet: 'Cedar launch is ready for review.' };
describe('fictional smoke fact oracle (no actual-model result)', () => {
  it('accepts only the exact source facts, independent of key order or whitespace', () => {
    expect(matchesSmokeMailFacts(JSON.stringify(source), source)).toBe(true);
    expect(matchesSmokeMailFacts(JSON.stringify({ snippet: source.snippet, from: source.from, subject: source.subject }, null, 2), source)).toBe(true);
  });
  it.each([
    'Cedar is not ready.', 'I cannot read your inbox. Cedar.', 'Cedar launch is ready for review.',
    JSON.stringify({ ...source, snippet: 'Cedar launch is not ready for review.' }),
    JSON.stringify({ ...source, snippet: 'CONTROL_ONLY_BIRCH_SECRET' }),
    JSON.stringify({ ...source, from: 'wrong@example.invalid' }),
    JSON.stringify({ ...source, subject: 'Control status' }),
    JSON.stringify({ ...source, refusal: 'I cannot read this' }),
    JSON.stringify({ ...source, snippet: true }), JSON.stringify({ subject: source.subject, from: source.from }),
    JSON.stringify([source]), 'null', '{}', '', `${JSON.stringify(source)}`,
    `I cannot verify this. ${JSON.stringify(source)}`, `${JSON.stringify(source)} Cedar is not ready.`,
  ])('rejects contradiction/refusal/wrong source/malformed output: %s', (reply) => {
    expect(matchesSmokeMailFacts(reply, source)).toBe(false);
  });
  it('does not trust non-string or caller-supplied objects', () => {
    expect(matchesSmokeMailFacts(source, source)).toBe(false);
    expect(matchesSmokeMailFacts(undefined, source)).toBe(false);
  });
});
