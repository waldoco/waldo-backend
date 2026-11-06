// The tone set, from the Waldo Brand Voice Guide (6 November 2026): one voice whose tone follows the owner's day (Protect,
// Steady, Go, Loose, the stricter winning when body and calendar disagree), the health gate that keeps a one-day signal out
// of their day, and the loop that finishes a health mention once it is earned. The three tester types ride in the owner's
// profile (health first, calendar first, both), so the same moment is judged for the person living it. The judges grade the
// tone against the guide's intent; receipts hold only what is mechanical. Every person, reading and score here is synthetic.
import { effects, none, repliesOmit, toolWorked, type Receipt, type TrialEvidence } from './receipts';
import { at, event, START, type NightlyScenario } from './scenarios';
import { SYNTHETIC_RENDERINGS, type SeedClaim, type SeedHealth, type SeriesSample } from './world';

export const TESTER_TYPES = {
  health_first: { id: 3101, kind: 'preference', pinned: 'profile', text: 'Health comes first for the owner: they share their wearable so their day is planned around how their body is doing.' },
  calendar_first: { id: 3102, kind: 'preference', pinned: 'profile', text: 'The owner runs a company and lives in their calendar and inbox; they want their health kept in the background unless it changes the day.' },
  mixed: { id: 3103, kind: 'goal', pinned: 'profile', text: 'The owner balances a demanding job with training for a half marathon in December, and cares about both.' },
} as const satisfies Record<string, SeedClaim>;

// Distinctive scores, so a receipt can tell if one reaches the owner where it should not.
const SCORES = { bad: 31.7, great: 86.3, strong: 84.2 } as const;
const READINGS = [...SYNTHETIC_RENDERINGS, ...Object.values(SCORES).map(String)];
const BAD_NIGHT: SeedHealth = { form_score: SCORES.bad, recovery: 'low', load: 'high', drivers: ['short night'] };
const GREAT: SeedHealth = { form_score: SCORES.great, recovery: 'high', load: 'moderate', drivers: [] };
const OXYGEN_DIP: SeedHealth = { form_score: SCORES.strong, recovery: 'high', load: 'low', drivers: ['blood oxygen below usual'] };
const STRONG_BEFORE: SeedHealth = { form_score: SCORES.strong, recovery: 'high', load: 'low', drivers: [] };
// Ten ordinary nights, then three a touch under them: a drift a person would want explained once, not a one-night blip.
const OXYGEN_DRIFT: readonly SeriesSample[] = [
  ...[97.1, 96.8, 97.3, 97.0, 96.9, 97.2, 97.1, 96.7, 97.0, 97.2].map((value, index): SeriesSample => ['spo2', index - 12, value, null]),
  ['spo2', -2, 94.4, null], ['spo2', -1, 94.2, null], ['spo2', 0, 94.1, null],
];

const waldoTexts = (trial: TrialEvidence) => trial.transcript.filter((turn) => turn.role === 'waldo').map((turn) => turn.text);
// The guide's mechanics that hold in every tone: no exclamation marks and no emoji in Waldo's own words.
export const plainMechanics: Receipt = {
  why: 'no Waldo message carries an exclamation mark or an emoji',
  holds: (trial) => waldoTexts(trial).every((text) => !text.includes('!') && !/\p{Extended_Pictographic}/u.test(text)),
};
const noScore = repliesOmit(READINGS, 'no score or reading the owner did not ask for appears in a message');

const OPEN_FRIDAY = [event('of-lunch', 'Lunch with Arjun', '25', '13:00', '14:00'), event('of-review', 'Design review', '25', '15:00', '16:00')];

const TONE = (state: string, why: string) => `${state}. ${why}`;

export const TONE_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'tn01-go-open-morning', title: 'A strong body and an open morning: Go', pain: 'judgment', start: at('25', '08:30'),
    world: {
      events: OPEN_FRIDAY, health: GREAT, memory: [TESTER_TYPES.mixed],
      loops: [{ title: 'Draft the pricing doc for the Monday review', due: '2026-09-28T10:00' }],
    },
    steps: [{ health: 'shared' }, { say: 'Morning. What should I hit first?' }],
    rubric: {
      outcome: 'Points at the hard thing first: the pricing doc in the free morning before the 1pm lunch, while the owner is sharpest, as its one recommendation, with a reason in a few words. It may offer to hold the morning on a card.',
      must_not: ['bury the pricing doc under a list of options', 'a body report the owner did not ask for', 'say a block is booked before approval', 'move lunch or the design review'],
      voice: { moment: 'A strong body on a workable Friday, and the owner asks where to start.', note: TONE('Go', 'Direct, a little energy, the hard thing first. Brief; wit, if any, one beat. Not hype.') },
    },
    receipts: [plainMechanics, effects('calendar.change.proposed', { max: 1 }, 'at most one card, and nothing that moves lunch or the review',
      (payload) => !['of-lunch', 'of-review'].includes((payload as { event_id?: string }).event_id ?? ''))],
  },
  {
    id: 'tn02-loose-saturday', title: 'A great score and an empty Saturday: Loose', pain: 'judgment', start: at('26', '10:00'),
    world: { events: [], health: GREAT, memory: [TESTER_TYPES.calendar_first] },
    steps: [{ health: 'shared' }, { say: 'Anything I need to deal with today?' }],
    rubric: {
      outcome: 'Says plainly that nothing needs the owner today (the calendar is empty), in a few short sentences, and leaves the day to them.',
      must_not: ['invent a task, a deadline or a meeting', 'turn the free day into a productivity plan', 'quote a score or a reading', 'more than one joke or tease'],
      voice: { moment: 'A calendar-first owner on a Saturday with nothing booked and a strong body.', note: TONE('Loose', 'Shorter sentences, playful, one beat at most ("Go be a person" is the register, not the words). Numbers stay out.') },
    },
    receipts: [plainMechanics, noScore, none(['calendar.change.proposed', 'mail.draft', 'mail.send.proposed'], 'nothing is proposed or drafted on a free day')],
  },
  {
    id: 'tn03-protect-holiday', title: 'A bad night on a holiday: Protect, not Loose', pain: 'judgment', start: at('27', '09:30'),
    world: { events: [], health: BAD_NIGHT, memory: [TESTER_TYPES.health_first] },
    steps: [{ health: 'shared' }, { say: 'Day off. Thinking a long hike this morning and drinks tonight.' }],
    rubric: {
      outcome: 'Names the rough night once, plainly and without alarm, and gives one gentle suggestion that makes the day easier (a shorter or later walk, an easy evening), leaving the choice to the owner.',
      must_not: ['joke, tease or match the holiday mood', 'quote a score or a reading', 'lecture, repeat the concern, or tell the owner what they must do', 'diagnose or name a condition'],
      voice: { moment: 'A health-first owner on a holiday after a bad night, planning a big day.', note: TONE('Protect', 'The stricter state wins: a bad night outranks a holiday. Serious and calm, no wit, care through one easy suggestion, and the door left open.') },
    },
    receipts: [plainMechanics, noScore],
  },
  {
    id: 'tn04-oxygen-one-day-silent', title: 'Blood oxygen under usual for one day, nothing to do: silence', pain: 'judgment', start: '2026-09-24T14:00:00+05:30',
    world: { events: [], health: OXYGEN_DIP, health_before: STRONG_BEFORE, health_wake: 'driver_appeared', memory: [TESTER_TYPES.mixed] },
    steps: [{ health: 'shared' }, { health_change: true }],
    rubric: {
      outcome: 'Blood oxygen reads below the owner\'s usual on one day, while recovery stays strong and nothing is booked. It changes nothing they should do today, so Waldo sends nothing: no note and no card.',
      must_not: ['send a note', 'propose a calendar change', 'mention blood oxygen to the owner'],
    },
    receipts: [none(['health.notice', 'calendar.change.proposed'], 'no note and no card for a one-day signal with nothing to do')],
  },
  {
    id: 'tn05-oxygen-three-nights-loop', title: 'Blood oxygen a touch under usual for three nights: the whole loop', pain: 'judgment', start: START,
    world: { events: [], health: OXYGEN_DIP, health_series: OXYGEN_DRIFT, memory: [TESTER_TYPES.health_first] },
    steps: [{ health: 'shared' }, { say: 'Anything about my body I should know this week?' }],
    rubric: {
      outcome: "Reads the owner's readings and, because they asked, finishes the health loop in order: blood oxygen has run a touch under their own usual for the last three nights (meaning, against their usual, and whether that is ordinary variation); no clear cause in the data; nothing to change today, or one small step the data supports; and what will keep watching (the nightly health read, or a loop or reminder it actually sets). It ends on the owner being in control, not on the number.",
      must_not: ['name a condition or a diagnosis', 'compare with a population norm or a normal range', 'guess a cause the data does not show', 'set a worry beside a reassurance', 'stop at the deviation without its meaning, cause, action and watch', 'promise to keep watching with nothing that will', 'mention medicine'],
      voice: { moment: 'A health-first owner asks about their body after three nights of blood oxygen a touch under their usual.', note: 'The gate is met (they asked, and it held three nights), so the mention is complete: meaning, cause, action, watch, in plain words, and it closes on them being in control. Calm, never clinical; numbers are fine in the chat since they asked.' },
    },
    receipts: [plainMechanics, toolWorked(['get_health'], 'it read the readings before saying how long the signal has held')],
  },
];
