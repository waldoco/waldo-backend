import { describe, expect, it } from 'vitest';
import { healthNoticePrompt, healthTriggerPrompt, healthTriggerView } from '../src/health/trigger';
import { NIGHTLY_MEMORY_INSTRUCTION } from '../src/memory/claims';
import { DAY_CARDS, dayCardPrompt } from '../src/prompt/day-cards';

// The owner's stated goals reach every run through the pinned profile block. These pin that the curator keeps them there and
// that the day's cards and the health trigger are asked to weigh them, while the judgment of what serves a goal stays the
// model's. Every value here is synthetic.
const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-21T03:30:00Z');
const ROW = {
  context: { day: '2026-10-21', recovery: { zone: 'low' }, form: { zone: 'moderate' }, weight: { zone: 'high' }, freshness: 'fresh', compiled_at: '2026-10-21T02:00:00Z', drivers: [] },
  previous: { day: '2026-10-20', recovery_zone: 'good', form_score: 70, weight_zone: 'moderate' },
};

describe('stated goals in the day\'s runs', () => {
  it('the nightly curator keeps stated goals, health and training goals included, in the owner profile block', () => {
    expect(NIGHTLY_MEMORY_INSTRUCTION).toContain('the goals they have stated and still hold (health and training goals included');
  });

  it('The Brief, the Check-in and The Close each weigh the day against the owner\'s goals, and never invent one', () => {
    for (const card of DAY_CARDS) {
      const prompt = dayCardPrompt(card, '2026-10-21T09:00', { calendar: '[]', ledger: '', today: '', updates: '' });
      expect(prompt, card.id).toContain("The owner's own goals are in their profile in memory");
      expect(prompt, card.id).toContain('Never invent a goal they have not stated.');
    }
  });

  it('without shared health, a card names a health goal as not readable today rather than staying silent or guessing', () => {
    for (const card of DAY_CARDS) {
      const prompt = dayCardPrompt(card, '2026-10-21T09:00', { calendar: '[]', ledger: '', today: '', updates: '' });
      expect(prompt, card.id).toContain('When it has none, or says none is available, say nothing about sleep, recovery or energy, and never guess or make up a score; when they stated a health goal, say in one plain clause that today cannot be read against it.');
    }
  });

  it('the health trigger and the health note weigh a change against the owner\'s goals, and never invent one', () => {
    const view = healthTriggerView(ROW as never, NOW, TZ);
    expect(view).not.toBeNull();
    for (const prompt of [healthTriggerPrompt({ view: view!, items: [], now: NOW, timezone: TZ, feedback: {} }), healthNoticePrompt({ view: view!, now: NOW, timezone: TZ })]) {
      expect(prompt).toContain("The owner's own goals are in their profile in memory");
      expect(prompt).toContain('Never invent a goal they have not stated.');
    }
  });
});
