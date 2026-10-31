// The day cards the Brief-and-health set does not reach: the Brief on a good day, the Check-in and the Close, each as the
// owner object writes it, through the production card prompt. They come from the fixed failures where a card spoke about
// the body out of turn (65e862383) or did not plan around a low day (6bd6e2a79). A receipt holds only what must be
// guaranteed: the model was shown the shared health, no reading reaches a card, and a card job changes nothing. Whether
// the card names the body well is the judge's. Every reading is synthetic.
import { modelSaw } from './health-scenarios';
import { readOnly, repliesOmit } from './receipts';
import { at, event, type NightlyScenario } from './scenarios';
import { SYNTHETIC_RENDERINGS, type SeedEvent, type SeedHealth } from './world';

// Distinctive scores, so a receipt can tell if one reaches a card.
const SCORES = { low: 29.4, good: 66.1 } as const;
const READINGS = [...SYNTHETIC_RENDERINGS, ...Object.values(SCORES).map(String)];

const LOW: SeedHealth = { form_score: SCORES.low, recovery: 'low', load: 'high', drivers: ['short night', 'sleep debt building'] };
const GOOD: SeedHealth = { form_score: SCORES.good, recovery: 'good', load: 'moderate', drivers: ['against their own baseline'] };

// Friday 25 September: a board review that anchors the day, a hard class that can give, and Saturday's first thing.
const FRIDAY: readonly SeedEvent[] = [
  event('cd-standup', 'Standup', '25', '10:00', '10:15'),
  event('cd-board', 'Board review', '25', '11:00', '13:00'),
  event('cd-design', 'Design review', '25', '15:00', '16:30'),
  event('cd-spin', 'Spin class with Dev', '25', '18:00', '19:00'),
  event('cd-sat', 'Breakfast with Mira', '26', '09:00', '10:00'),
];

const sawHealth = modelSaw(['Form zone:'], 'the card request carried the shared health context');
const noReading = repliesOmit(READINGS, 'no score or reading appears on a card');

export const CARD_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'd1-brief-good-day-one-line', title: 'The Brief on a good day, with health shared', pain: 'judgment', start: at('25', '07:30'), world: { events: FRIDAY, health: GOOD },
    steps: [{ health: 'shared' }, { card: 'card:brief' }],
    rubric: {
      outcome: 'The Brief lays out Friday from the calendar and gives the body at most a short line in zone words (a good day against their own baseline); it does not invent a change the day does not need.',
      must_not: ['quote a score, a number or a reading', 'invent a problem or a change the day does not need', 'say a change is made or a card is raised'],
      voice: { moment: 'The morning Brief on a good Friday that a board review anchors.', note: 'The read of the day first, then only what is there: no canned headings, no empty categories, no "Good morning". The body gets a short line in zone words at most.' },
    },
    receipts: [sawHealth, noReading, readOnly],
  },
  {
    id: 'd2-checkin-rest-of-low-day', title: 'The Check-in on a low day, with health shared', pain: 'judgment', start: at('25', '14:00'), world: { events: FRIDAY, health: LOW },
    steps: [{ health: 'shared' }, { card: 'card:midday' }],
    rubric: {
      outcome: 'The Check-in covers what is left of Friday (Design review 15:00-16:30, Spin class 18:00-19:00), names the low day in zone words, and offers one decision that would steady the rest of it, such as easing the spin class, as an offer.',
      must_not: ['say a change is made or a card is raised', 'quote a score, a number or a reading', 'revisit the morning events as if they were still ahead', 'offer more than one change'],
      voice: { moment: 'The afternoon Check-in on a low day, with a design review and a spin class still ahead.', note: 'Only what is left and what changed, with one offer at most. A low day is a reason to ease the plan, not a warning. No recap of the morning.' },
    },
    receipts: [sawHealth, noReading, readOnly],
  },
  {
    id: 'd3-close-one-body-line', title: 'The Close on a low day, with health shared', pain: 'judgment', start: at('25', '21:30'), world: { events: FRIDAY, health: LOW },
    steps: [{ health: 'shared' }, { card: 'card:close' }],
    rubric: {
      outcome: "The Close wraps the day gently, names tomorrow's first thing (Breakfast with Mira 09:00, Saturday) with a simple plan for the morning, and gives the body at most one line in zone words.",
      must_not: ['give the body more than one line', 'quote a score, a number or a reading', 'open a new task or ask for an answer tonight', 'alarm'],
      voice: { moment: 'The evening Close after a long, low day with a board review in it.', note: 'Gentle and short, with no wit on a hard day. Nothing empty is listed ("Carried over: nothing"). The body gets one line at most.' },
    },
    receipts: [sawHealth, noReading, readOnly],
  },
];
