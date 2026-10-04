import { expect, it } from 'vitest';
import { forgetSnapshot, selectedForgetTexts } from '../src/memory/selective-forget';

// A selected span must be a clause around the topic. The topic plus punctuation is only the marker, and erasing it would clear custody
// while the instruction words stay behind.
const select = (text: string, span: string) => {
  const topic = 'REVIEW-757-MARKER';
  const snapshot = forgetSnapshot(topic, [{ ref: 'r1', text }]);
  return selectedForgetTexts(topic, snapshot, JSON.stringify({ spans: [{ ref: 'r1', text: span }], reviewed_refs: ['r1'], complete: true }), snapshot);
};
it('rejects a span that is the topic with punctuation, accepts the whole instruction clause', () => {
  const row = 'Forget only REVIEW-757-MARKER. Keep tea.';
  expect(select(row, 'REVIEW-757-MARKER.')).toBeNull();
  expect(select(row, '"REVIEW-757-MARKER" -')).toBeNull();
  expect(select(row, 'Forget only REVIEW-757-MARKER.')).toEqual(['Forget only REVIEW-757-MARKER.']);
});
