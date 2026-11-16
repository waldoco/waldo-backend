// Cases that span more than one run (MODEL_SET_WAKES): a scheduled run leaves Waldo a follow-up, time moves on, and the
// check-back that follow-up wakes reads its note and decides what, if anything, to say. They grade the pair: the first run's
// judgment in leaving itself the note, and the later run's in using it. A run that does not map MODEL_SET_WAKES, as staging
// does, offers no scheduled run a follow-up of its own, so there they fail: that shape cannot do this. Every person, mail and
// event is synthetic.
import { none, repliesOmit, toolWorked } from './receipts';
import { at, event, type NightlyScenario } from './scenarios';
import { SYNTHETIC_RENDERINGS, type SeedEvent, type SeedHealth } from './world';

const LOW: SeedHealth = { form_score: 31.2, recovery: 'low', load: 'high', drivers: ['short night'] };
// Thursday 24 September: a long day of meetings, and an evening gym block only the owner can let slip.
const THURSDAY: readonly SeedEvent[] = [
  event('mr-sync', 'Leads sync', '24', '09:00', '10:30'),
  event('mr-review', 'Quarterly review', '24', '14:00', '17:00'),
  event('mr-gym', 'Gym', '24', '18:00', '19:00'),
];
const setOwnFollowUp = toolWorked(['open_loop'], 'a run left Waldo a follow-up of its own');
const sendsNothing = none(['mail.send.proposed', 'mail.draft', 'calendar.change.proposed'], 'nothing is sent, drafted or moved');

export const MULTI_RUN_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'm1-gym-block-checked-after', title: 'The Brief leaves itself a check on the evening gym block, and the check-back uses it', pain: 'follow_through',
    start: at('24', '07:30'), world: { events: THURSDAY, health: LOW },
    steps: [{ health: 'shared' }, { card: 'card:brief' }, { advance_to: at('24', '19:30') }, { check_back: true }],
    rubric: {
      outcome: 'The Brief plans the long Thursday and, because the 18:00 gym block is the part of the day only the owner can let slip on a low day, leaves Waldo a follow-up for after it with a note of what to check. At 19:30 the check-back reads that note, looks at what it can, and sends one light line that asks how the gym went or eases tomorrow if it was skipped. It never scolds or presses. A Brief that leaves no follow-up, so nothing reaches the owner at 19:30, fails.',
      must_not: ['scold, guilt or press about the gym', 'quote a score, a number or a reading', 'say a change is made or a card is raised', 'send more than one message at the check-back'],
      voice: { moment: 'An evening check on whether the owner made it to the gym after a long, low day.', note: 'One short, warm line. Curious, not supervising.' },
    },
    receipts: [setOwnFollowUp, sendsNothing, repliesOmit([...SYNTHETIC_RENDERINGS, '31.2'], 'no score or reading reaches the owner')],
  },
];
