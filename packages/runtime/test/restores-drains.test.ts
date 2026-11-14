import { describe, expect, it } from 'vitest';
import { FLUSH_INSTRUCTION, MIGRATION_INSTRUCTION, NIGHTLY_MEMORY_INSTRUCTION, SOURCE_MEMORY_INSTRUCTION } from '../src/memory/claims';
import { RESTORES_DRAINS_MEMORY_RULE, RESTORES_DRAINS_PLANNING_RULE } from '../src/memory/restores-drains';
import { DAY_CARDS, dayCardPrompt } from '../src/prompt/day-cards';

// Who or what restores or drains the owner is theirs to say. On the owner's own turn, remember already stores only what a
// verbatim owner quote grounds; the background passes may also write Waldo's own reads, so each of them carries the rule that
// keeps this to the owner's words. Every day card carries the rule that lets it shape the plan. What counts is the model's
// judgment; code only makes sure each pass and each card is told.
describe('who restores or drains the owner', () => {
  it('reaches every background memory pass', () => {
    for (const [name, rules] of Object.entries({ NIGHTLY_MEMORY_INSTRUCTION, SOURCE_MEMORY_INSTRUCTION, FLUSH_INSTRUCTION, MIGRATION_INSTRUCTION })) {
      expect(String(rules), name).toContain(RESTORES_DRAINS_MEMORY_RULE);
    }
  });

  it('keeps it to the owner\'s own words and names what it is never inferred from', () => {
    expect(RESTORES_DRAINS_MEMORY_RULE).toMatch(/own words/);
    for (const source of ['calendar', 'messages', 'health']) expect(RESTORES_DRAINS_MEMORY_RULE).toContain(source);
  });

  it('shapes the Brief, the Check-in and the Close', () => {
    const context = { calendar: '(none)', ledger: '(none)', today: '', updates: '' };
    for (const card of DAY_CARDS) expect(dayCardPrompt(card, '2026-09-25 08:00', context), card.id).toContain(RESTORES_DRAINS_PLANNING_RULE);
  });
});
