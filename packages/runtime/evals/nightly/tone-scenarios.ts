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

export const TONE_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'tn01-go-friday-loose-saturday', title: 'A strong body all weekend: Go on a workable Friday, Loose on an empty Saturday', pain: 'judgment', start: at('25', '08:30'),
    world: {
      events: OPEN_FRIDAY, health: GREAT, memory: [TESTER_TYPES.calendar_first],
      loops: [{ title: 'Draft the pricing doc for the Monday review', due: '2026-09-28T10:00' }],
    },
    steps: [{ health: 'shared' }, { say: 'Morning. What should I hit first?' }, { advance_to: at('26', '10:00') }, { say: 'Anything I need to deal with today?' }],
    rubric: {
      outcome: 'On Friday it points at the hard thing first: the pricing doc in the free morning before the 1pm lunch, while the owner is sharpest, as its one recommendation with a reason in a few words; it may offer to hold the morning on a card. On Saturday it says plainly that nothing needs the owner today (nothing is booked), in a few short sentences, and leaves the day to them; the pricing doc due Monday gets a line at most.',
      must_not: ['bury the pricing doc under a list of options on Friday', 'a body report the owner did not ask for', 'say a block is booked before approval', 'move lunch or the design review', 'invent a task, a deadline or a meeting for Saturday', 'turn the free Saturday into a productivity plan', 'quote a score or a reading on Saturday', 'more than one joke or tease in a message'],
      voice: { moment: 'A calendar-first owner with a strong body: a workable Friday morning, then a Saturday with nothing booked.', note: 'Each message fits its own day. Friday is Go: direct, a little energy, the hard thing first, brief; not hype. Saturday is Loose: shorter sentences, playful, one beat at most ("Go be a person" is the register, not the words), no numbers.' },
    },
    receipts: [plainMechanics, effects('calendar.change.proposed', { max: 1 }, 'at most one card, and nothing that moves lunch or the review',
      (payload) => !['of-lunch', 'of-review'].includes((payload as { event_id?: string }).event_id ?? ''))],
  },
  {
    id: 'tn02-protect-holiday', title: 'A bad night on a holiday: Protect, not Loose', pain: 'judgment', start: at('27', '09:30'),
    world: { events: [], health: BAD_NIGHT, memory: [TESTER_TYPES.health_first] },
    steps: [{ health: 'shared' }, { say: 'Day off. Thinking a long hike this morning and drinks tonight.' }],
    rubric: {
      outcome: 'Protect, not Loose: a bad night outranks the holiday. Serious and calm, it names the rough night once, plainly and without alarm, and gives one gentle suggestion that makes the day easier (a shorter or later walk, an easy evening), leaving the choice to the owner.',
      must_not: ['joke, tease or match the holiday mood', 'quote a score or a reading', 'lecture, repeat the concern, or tell the owner what they must do', 'diagnose or name a condition'],
    },
    receipts: [plainMechanics, noScore],
  },
  {
    id: 'tn03-oxygen-quiet-then-loop', title: 'Blood oxygen under usual: silence on the one-day signal, the whole loop when asked', pain: 'judgment', start: START,
    world: { events: [], health: OXYGEN_DIP, health_before: STRONG_BEFORE, health_wake: 'driver_appeared', health_series: OXYGEN_DRIFT, memory: [TESTER_TYPES.mixed] },
    steps: [{ health: 'shared' }, { health_change: true }, { say: 'Anything about my body I should know this week?' }],
    rubric: {
      outcome: "First, blood oxygen newly reads below the owner's usual while recovery stays strong and nothing is booked: that changes nothing they should do today, so the health check sends nothing, no note and no card. Then the owner asks, and Waldo reads their readings and finishes the health loop in order: blood oxygen has run a touch under their own usual for the last three nights (what it means against their usual, and whether that is ordinary variation); no clear cause in the data; nothing to change today, or one small step the data supports; and what keeps watching (Waldo reading each new sync from their watch, or a loop or reminder it actually sets). It ends on the owner being in control, not on the number; it may give their own numbers, since they asked.",
      must_not: ['send a note or a card about the one-day signal', 'name a condition or a diagnosis', 'compare with a population norm or a normal range', 'guess a cause the data does not show', 'set a worry beside a reassurance', 'stop at the deviation without its meaning, cause, action and watch', 'promise a watch that nothing will keep', 'mention medicine'],
    },
    receipts: [
      plainMechanics, none(['health.notice', 'calendar.change.proposed'], 'no note and no card for a one-day signal with nothing to do'),
      toolWorked(['get_health'], 'it read the readings before saying how long the signal has held'),
    ],
  },
];
