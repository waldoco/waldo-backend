// The welcome build's judgment over a calendar that holds Waldo's own housekeeping beside the owner's life, from the 2 Nov
// constellation that showed "onboarding smoke test scheduling" and "Supabase Auth docs page" as things Waldo noticed. The
// stage runs as the owner object asks it, through the production instruction and schema. A receipt holds only that the
// model was shown both kinds of item and that those two items are not written back; whether a node is about the owner,
// and how it is worded to them, is the judge's. Every event is synthetic.
import { modelSaw } from './health-scenarios';
import { repliesOmit } from './receipts';
import { at, type NightlyScenario } from './scenarios';

// The calendar stage's lines, as calendarStage writes them: id, title, start, and whether it repeats.
const line = (id: string, title: string, day: string, time: string, repeats = false) => `[${id}] ${title} · ${at(day, time)}${repeats ? ' · repeats' : ''}`;
const CALENDAR = [
  line('w-plan', 'Plan the week', '21', '08:30', true),
  line('w-priya', '1:1 with Priya', '22', '11:00', true),
  line('w-gym', 'Gym', '22', '18:30', true),
  line('w-mira', 'Dinner with Mira', '23', '20:00'),
  line('w-smoke', 'Waldo onboarding smoke test', '23', '10:00'),
  line('w-access', 'Check Waldo calendar access and connection status', '23', '10:30'),
  line('w-docs', 'Read Supabase Auth docs page for the Waldo login', '23', '11:00'),
].join('\n');

export const WELCOME_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'w1-welcome-leaves-out-housekeeping', live_subset: true, title: 'The welcome build writes the owner\'s life, not Waldo\'s own setup', pain: 'judgment', start: at('24', '09:00'), world: {},
    steps: [{ welcome: { stage: 'calendar', sources: ['calendar'], text: CALENDAR } }],
    rubric: {
      outcome: 'Each node is a pattern in the owner\'s own life or work the calendar shows (a weekly planning block, a recurring 1:1, the gym), and each summary speaks to the owner as "you".',
      must_not: ['write a node about setting Waldo up, testing it, its access or connections, or docs read to get it working', 'refer to the owner as "the owner" in a summary', 'name a number, a count or a time'],
    },
    receipts: [
      modelSaw(['Waldo onboarding smoke test', 'Plan the week'], 'the stage was shown the housekeeping items beside the owner\'s own'),
      repliesOmit(['smoke test', 'Supabase'], 'no node is written from the smoke test or the docs page'),
    ],
  },
];
