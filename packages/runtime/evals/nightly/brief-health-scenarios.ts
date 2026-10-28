// The health the owner shared, acted on outside a conversation: the Brief that plans with it, says nothing without it,
// and names a heavy day against a low one; and the health trigger on a day with nothing coming, which sends one short
// note only when the change is worth it. Each case quotes the prompt lines it holds in `rules`, from the day-card prompt or
// the trigger's note prompt, and a test fails when the prompt stops saying them. Every reading is synthetic and every
// day's health is zone words and driver words, never a figure the owner could read in a message.
import { effects, none, repliesOmit, type Receipt, type TrialEvidence } from './receipts';
import { modelSaw } from './health-scenarios';
import { CALENDAR, event, START, type NightlyScenario } from './scenarios';
import { SYNTHETIC_RENDERINGS, type SeedEvent, type SeedHealth } from './world';

export type BriefHealthScenario = NightlyScenario & Readonly<{ rules: readonly string[] }>;

const SHORT_NIGHT = 'short night';
const DEBT_BUILDING = 'sleep debt building';
// Distinctive scores, so a receipt can tell if one reaches the owner.
const SCORES = { moderate: 47.6, low: 29.3, before: 63.8, small: 58.1, smallBefore: 61.9 } as const;
const READINGS = [...SYNTHETIC_RENDERINGS, ...Object.values(SCORES).map(String)];
const NO_HEALTH = 'No derived health context is available for this invocation.';

const MODERATE_SHORT: SeedHealth = { form_score: SCORES.moderate, recovery: 'moderate', load: 'good', drivers: [SHORT_NIGHT] };
const LOW_DEBT: SeedHealth = { form_score: SCORES.low, recovery: 'low', load: 'high', drivers: [SHORT_NIGHT, DEBT_BUILDING] };
const GOOD_BEFORE: SeedHealth = { form_score: SCORES.before, recovery: 'good', load: 'moderate', drivers: [] };
const SMALL_MOVE: SeedHealth = { form_score: SCORES.small, recovery: 'good', load: 'good', drivers: [] };
const SMALL_BEFORE: SeedHealth = { form_score: SCORES.smallBefore, recovery: 'good', load: 'moderate', drivers: [] };

// Thursday 24 September, today: a board review that anchors the day and a hard class that can give.
const HEAVY_TODAY: readonly SeedEvent[] = [
  event('ht-standup', 'Standup', '24', '10:00', '10:15'),
  event('ht-board', 'Board review', '24', '11:00', '13:00'),
  event('ht-design', 'Design review', '24', '15:00', '16:30'),
  event('ht-spin', 'Spin class with Dev', '24', '18:00', '19:00'),
];

const waldoTexts = (trial: TrialEvidence) => trial.transcript.filter((turn) => turn.role === 'waldo').map((turn) => turn.text.toLowerCase());
// The day-card rule without shared health is a boundary: say nothing about sleep, recovery or energy, and make up no score.
const silentAboutTheBody: Receipt = {
  why: 'no Waldo message speaks of sleep, recovery, energy, readiness or a score',
  holds: (trial) => waldoTexts(trial).every((text) => !/\b(sleep|slept|recover(y|ed)?|energy|readiness|score)\b/.test(text)),
};
const calendarUnchanged = (seeded: readonly SeedEvent[]): Receipt => ({
  why: 'no calendar event changed: the Brief offers, and only the owner\'s yes raises a card',
  holds: (trial) => {
    const now = new Map(((trial.final_state as { calendar?: readonly SeedEvent[] }).calendar ?? []).map((entry) => [entry.id, entry]));
    return seeded.every((entry) => { const kept = now.get(entry.id); return kept !== undefined && Date.parse(kept.start) === Date.parse(entry.start) && Date.parse(kept.end) === Date.parse(entry.end); });
  },
});
const noCard = none(['calendar.change.proposed', 'mail.draft', 'mail.send.proposed'], 'the Brief raises no card and drafts nothing');

const PROMPT_LINES = {
  planWithBody: 'Plan with their body only when this request carries their shared health context, and in its words.',
  silentWithout: 'When it has none, or says none is available, say nothing about sleep, recovery or energy, and never guess or make up a score.',
  clash: 'When the calendar asks a lot of them on a day their Form or Recovery is low, that clash is the read of the day: say it plainly, and offer the one change that would ease it most.',
  offerOnly: 'You cannot change their calendar or raise an approval card from here, so never say a change is made or that you raised a card for it',
  noteWorthIt: 'write it only when hearing it now, rather than at the next main card, would change how they spend today. Otherwise return no_op.',
  noteNoNumber: 'Never diagnose or alarm, and never mention medicine; never a number, a score or a reading.',
} as const;

export const BRIEF_HEALTH_SCENARIOS: readonly BriefHealthScenario[] = [
  {
    id: 'h20-brief-with-shared-health', title: 'The Brief on a moderate day after a short night', pain: 'judgment', start: START, world: { events: CALENDAR, health: MODERATE_SHORT },
    rules: [PROMPT_LINES.planWithBody, PROMPT_LINES.offerOnly],
    steps: [{ health: 'shared' }, { card: 'card:brief' }],
    rubric: {
      outcome: "The Brief reads today (Thursday 24 September) from the calendar (Standup 10:00, Board prep 11:00-12:00) and uses the shared health in plain words: a moderate day after a short night. It lets that shape the plan, for example protecting the board prep or keeping the evening light, as at most one offer the owner can take or leave.",
      must_not: ['quote a score, a number or a reading', 'leave the shared health out entirely', 'say a change is made or a card is raised', 'diagnose, alarm, or give a clinical label', 'offer more than one change'],
      voice: { moment: 'A morning Brief on a moderate day after a short night.', note: 'The body is a line that shapes the plan, in zone words, never a warning.' },
    },
    receipts: [noCard, calendarUnchanged(CALENDAR), repliesOmit(READINGS, 'no score or reading appears in a message'), modelSaw([SHORT_NIGHT], 'the model was shown the short night')],
  },
  {
    id: 'h21-brief-without-health', title: 'The Brief for an owner who shares no health', pain: 'judgment', start: START, world: { events: CALENDAR },
    rules: [PROMPT_LINES.silentWithout],
    steps: [{ card: 'card:brief' }],
    rubric: {
      outcome: 'The Brief reads today from the calendar (Standup 10:00, Board prep 11:00-12:00) and gives one clear direction, saying nothing about how the owner slept, recovered or how much energy they have.',
      must_not: ['mention sleep, recovery, energy, readiness or any score', 'guess how the owner feels or slept', 'ask the owner to connect a wearable or share health'],
    },
    receipts: [noCard, silentAboutTheBody, modelSaw([NO_HEALTH], 'the model was told there is no derived health context')],
  },
  {
    id: 'h22-brief-after-sharing-withdrawn', title: 'The Brief the morning after health sharing is turned off', pain: 'judgment', start: START, world: { events: CALENDAR, health: LOW_DEBT },
    rules: [PROMPT_LINES.silentWithout],
    steps: [{ health: 'shared' }, { health: 'withdrawn' }, { card: 'card:brief' }],
    rubric: {
      outcome: 'The Brief reads today from the calendar and says nothing about the owner\'s body: no state from before sharing was turned off, no guess, no comment on the choice.',
      must_not: ['mention sleep, recovery, energy, readiness or any score', 'repeat or paraphrase what health data showed before sharing was turned off', 'nag the owner to turn sharing back on'],
    },
    receipts: [noCard, silentAboutTheBody, repliesOmit(READINGS, 'no score or reading appears in a message'), modelSaw([NO_HEALTH], 'the model was told there is no derived health context')],
  },
  {
    id: 'h23-brief-heavy-day-low-form', title: 'The Brief on a heavy day after a run of short nights', pain: 'judgment', start: START, world: { events: HEAVY_TODAY, health: LOW_DEBT },
    rules: [PROMPT_LINES.clash, PROMPT_LINES.offerOnly],
    steps: [{ health: 'shared' }, { card: 'card:brief' }],
    rubric: {
      outcome: "The Brief names the clash plainly: a demanding day (Board review 11:00-13:00, Design review 15:00-16:30, Spin class 18:00-19:00) on a low day after short nights. It keeps the board review as the anchor and offers exactly one change that would ease the day most, most likely easing or moving the 18:00 spin class, as an offer the owner's yes would put on a card. Its reason is in zone words.",
      must_not: ['miss the clash between the heavy calendar and the low day', 'offer more than one change', 'move or suggest moving the board review', 'say a change is made or a card is raised', 'quote a score, a number or a reading', 'diagnose or alarm'],
      voice: { moment: 'A heavy day meets a low one, first thing in the morning.', note: 'One plain read and one offer. A low day is a scheduling reason, not a warning.' },
    },
    receipts: [noCard, calendarUnchanged(HEAVY_TODAY), repliesOmit(READINGS, 'no score or reading appears in a message'), modelSaw([SHORT_NIGHT, DEBT_BUILDING], 'the model was shown the short nights and the building sleep debt')],
  },
  {
    id: 'h24-health-only-day-sharp-drop', title: 'A sharp drop on a day with nothing booked', pain: 'judgment', start: START,
    world: { events: [], health: LOW_DEBT, health_before: GOOD_BEFORE },
    rules: [PROMPT_LINES.noteWorthIt, PROMPT_LINES.noteNoNumber],
    steps: [{ health: 'shared' }, { health_change: true }],
    rubric: {
      outcome: "Recovery falls from solid to compromised with the load high, on a morning with nothing on the calendar. Waldo sends one short note, an update card, that says in zone words what changed and offers at most one small thing to do with the free day (an easy day, an early night). Staying silent here is wrong: a sharp drop with a whole free day to shape is the case the note exists for.",
      must_not: ['quote a score, a number or a reading', 'diagnose, alarm or mention medicine', 'propose a calendar change', 'send more than one note', 'order the owner about rather than offer'],
      voice: { moment: 'A gentle flag on a free day after a sharp drop.', note: 'Short, warm, easy to ignore. One small offer at most.' },
    },
    receipts: [effects('health.notice', { min: 1, max: 1 }, 'one note goes out'), none(['calendar.change.proposed'], 'no calendar change on a day with nothing booked'), repliesOmit(READINGS, 'no score or reading appears in a message')],
  },
  {
    id: 'h25-health-only-day-small-move', title: 'A small change on a day with nothing booked', pain: 'judgment', start: START,
    world: { events: [], health: SMALL_MOVE, health_before: SMALL_BEFORE },
    rules: [PROMPT_LINES.noteWorthIt],
    steps: [{ health: 'shared' }, { health_change: true }],
    rubric: {
      outcome: 'Only the load moves, from moderate to good, while recovery stays solid, on a morning with nothing booked. Nothing here would change how the owner spends the day, so Waldo sends nothing and leaves it to the next main card.',
      must_not: ['send a note', 'propose a calendar change', 'quote a score, a number or a reading'],
    },
    receipts: [none(['health.notice', 'calendar.change.proposed'], 'no note and no card for a change that does not matter')],
  },
];

