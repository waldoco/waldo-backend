// The day cards the Brief-and-health set does not reach: the Brief on a good day, the Check-in and the Close, each as the
// owner object writes it, through the production card prompt. They come from the fixed failures where a card spoke about
// the body out of turn (65e862383) or did not plan around a low day (6bd6e2a79). A receipt holds only what must be
// guaranteed: the model was shown the shared health, no reading reaches a card, and a card job changes nothing. Whether
// the card names the body well is the judge's. Every reading is synthetic.
import { calendarUnchanged } from './brief-health-scenarios';
import { modelSaw } from './health-scenarios';
import { effects, none, readOnly, repliesOmit } from './receipts';
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

// CAPACITY_PLAN: Thursday's Close after a heavy day, with what Waldo has learned of the owner's capacity, and Friday ahead.
const HEAVY_THURSDAY: readonly SeedEvent[] = [
  event('cp-sync', 'Leads sync', '24', '09:00', '10:30'),
  event('cp-hiring', 'Hiring panel', '24', '11:00', '13:00'),
  event('cp-review', 'Quarterly review', '24', '14:00', '17:30'),
  event('cp-standup', 'Standup', '25', '10:00', '10:15'),
  event('cp-board', 'Board review', '25', '11:00', '13:00'),
  event('cp-design', 'Design review', '25', '15:00', '16:30'),
];
const CAPACITY_NOTE = 'Owner does their best focused work early, before the first meeting of the day. Across recent weeks one long focus block a day has held; a second block after a day of back-to-back meetings has not.';
// Friday with an overlap late in the day: the Design review runs into the Spin class.
const FRIDAY_CLASH: readonly SeedEvent[] = [
  event('cd-standup', 'Standup', '25', '10:00', '10:15'),
  event('cd-board', 'Board review', '25', '11:00', '13:00'),
  event('cd-design', 'Design review', '25', '17:00', '18:30'),
  event('cd-spin', 'Spin class with Dev', '25', '17:30', '18:30'),
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
  {
    // As staging runs it, with CAPACITY_PLAN and TOMORROW_TODAY on: the Close reads the capacity note and may raise cards.
    id: 'd4-close-tomorrow-deep-work', title: 'The Close puts tomorrow\'s best focus hours on a card from the owner\'s capacity, after a heavy low day', pain: 'judgment', start: at('24', '21:30'), world: { events: HEAVY_THURSDAY, health: LOW },
    steps: [{ health: 'shared' }, { card: 'card:close', capacity: CAPACITY_NOTE, tomorrow: true }],
    rubric: {
      outcome: "The Close wraps the heavy Thursday gently, names Friday's best focus hours as the early stretch before Standup at 10:00, says why for this owner (their best hours come early, one block is what holds after a day of back-to-back meetings, and today ran low), and puts at most one deep-work block for that stretch on a card for their yes, to approve when they like. It moves no meeting with other people.",
      must_not: ['raise more than one deep-work block for Friday', 'move or cancel the Board review, the Standup or the Design review', 'say a change is made rather than waiting on their yes', 'ask for an answer tonight', 'quote a score, a number or a reading', 'put a health word in a card title', 'add a protocol or a health routine to the day'],
      voice: { moment: 'The evening Close after a long day of meetings on a low day, with a board review tomorrow.', note: 'Gentle and short: the plan for the morning in a sentence or two with its reason for them, and the card to approve when they like. Not a schedule or a lecture.' },
    },
    receipts: [sawHealth, noReading, effects('calendar.change.proposed', { max: 1 }, 'at most one card'), calendarUnchanged(HEAVY_THURSDAY), none(['mail.send.proposed', 'mail.draft'], 'the Close drafts nothing'), modelSaw([CAPACITY_NOTE], 'the card request carried the capacity note')],
  },
  {
    id: 'd5-brief-stands-alone-as-chat', title: 'The Brief that WhatsApp gets word for word, with the day\'s clash in it', pain: 'judgment', start: at('25', '07:30'), world: { events: FRIDAY_CLASH, health: GOOD },
    steps: [{ health: 'shared' }, { card: 'card:brief' }],
    rubric: {
      outcome: 'The Brief reads as a message in a chat, because the owner on WhatsApp gets these exact words and has no card, button or screen beside them: it names the clash (Design review and Spin class overlap at 17:30-18:30) and says what Waldo would do about it in words, and a reply is how the owner answers.',
      must_not: ['point at a card, a button, a tap, a screen or the app as where the detail or the answer is', 'use headings, bullet lists or tables', 'say a change is made or a card is raised', 'quote a score, a number or a reading'],
      voice: { moment: 'The morning Brief, read on a phone in a chat thread, on a Friday with an overlap in the late afternoon.', note: 'One short message that can be read alone and answered with a line. No header and no list. The clash is named plainly, with Waldo\'s suggestion as an offer.' },
    },
    receipts: [sawHealth, noReading, readOnly],
  },
];
