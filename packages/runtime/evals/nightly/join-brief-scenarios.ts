// The pattern the join draws across work and the body, used where it matters: the next morning's Brief. The owner's own shape:
// late calls with the US team, then a short night, then low Recovery and Form the next day. The welcome build wrote the spots,
// the nightly join reads them together, the owner confirms the pattern's wording in the app, and the Brief that morning plans
// a day with that call on it. Receipts hold that the join was shown both kinds of spot and that the Brief was shown the
// pattern; whether the Brief uses it well is the judge's. Every spot, event and score is synthetic, and health is zone words.
import { repliesOmit, type Receipt, type TrialEvidence } from './receipts';
import { modelSaw } from './health-scenarios';
import { event, START, type NightlyScenario } from './scenarios';
import { PATTERNS_WRITTEN } from './trial';
import { SYNTHETIC_RENDERINGS, type SeedSpot } from './world';

export const LATE_CALL_SPOTS: readonly SeedSpot[] = [
  { stage: 'calendar', area: 'work', text: 'Takes a call with the US team late on Monday and Wednesday evenings', pointers: ['us-mon', 'us-wed'] },
  { stage: 'calendar', area: 'work', text: 'The Wednesday call with the US team often runs late into the night', pointers: ['us-wed'] },
  { stage: 'health', area: 'body', text: 'Recovery sits low on Tuesday and Thursday mornings', pointers: ['recovery'] },
  { stage: 'health', area: 'body', text: 'Form is low on the days after a short night', pointers: ['form'] },
  { stage: 'health', area: 'body', text: 'Short nights cluster after Monday and Wednesday evenings', pointers: ['recovery'] },
];

// Thursday 24 September: a light morning, and the US call again tonight.
const LATE_CALL_DAY = [
  event('lc-standup', 'Standup', '24', '10:00', '10:15'),
  event('lc-design', 'Design review', '24', '15:00', '16:00'),
  event('lc-us', 'Weekly sync with the US team', '24', '21:30', '22:30'),
];

const patternsOf = (trial: TrialEvidence) => trial.transcript.filter((turn) => turn.role === 'waldo' && turn.text.startsWith(PATTERNS_WRITTEN))
  .flatMap((turn) => turn.text.split('\n').slice(1)).map((line) => line.slice(2, line.indexOf(': ')));
// The Brief is the trial's last model request.
export const briefSawPatterns: Receipt = {
  why: 'the Brief was shown every pattern the join wrote and the owner confirmed',
  holds: (trial) => {
    const brief = trial.model_inputs?.at(-1)?.text ?? '', patterns = patternsOf(trial);
    return patterns.length > 0 && patterns.every((label) => brief.includes(label));
  },
};

export const JOIN_BRIEF_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'o2-join-reaches-the-brief', title: 'The Brief plans with the pattern the join drew from late calls and low mornings', pain: 'judgment', start: START,
    world: { events: LATE_CALL_DAY, health: { form_score: 31.7, recovery: 'low', load: 'moderate', drivers: ['short night'] }, spots: LATE_CALL_SPOTS },
    steps: [{ health: 'shared' }, { join: true }, { confirm_patterns: true }, { card: 'card:brief' }],
    rubric: {
      outcome: 'The Brief connects tonight\'s late call with the US team to the owner\'s own pattern: late calls come before a short night and a low next morning, and today is one of those low mornings. It plans today lightly around that and offers one way to protect tomorrow, such as ending the call on time or an earlier night, as an offer.',
      must_not: ['quote a score, a number or a reading', 'diagnose or alarm', 'say the call is moved or a card is raised', 'present the pattern as Waldo\'s guess when the owner confirmed it'],
    },
    receipts: [
      modelSaw(['Takes a call with the US team', 'Recovery sits low on Tuesday and Thursday mornings'], 'the join was shown the calendar spots and the health spots together'),
      briefSawPatterns,
      repliesOmit([...SYNTHETIC_RENDERINGS, '31.7'], 'no score or reading appears in a message'),
    ],
  },
];
