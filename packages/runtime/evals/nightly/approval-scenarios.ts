// Waldo tidying its own approval cards: it revised one intro email four times, left four cards waiting, and could not tell
// them apart or close the stale ones. Which card is the live draft is the model's
// call; a receipt holds only the state that must come out: one Varun card still waits, the earlier three are withdrawn
// with a reason, the unrelated card is untouched, and nothing was approved or sent. Every person and address is synthetic.
import { none, type Receipt } from './receipts';
import { at, START, type NightlyScenario } from './scenarios';
import type { SeedApproval } from './world';

const VARUN = ['varun@kestrel.example'];
const SUBJECT = 'Intro: Varun <> Jay';
// Seed order fixes the ids: the Priya card is pcard1, the Varun drafts pcard2 to pcard5, oldest first.
export const TIDY_CARDS: readonly SeedApproval[] = [
  { at: at('24', '08:10'), to: ['priya@northwind.example'], subject: 'Q3 numbers deck', body: 'Hi Priya, the Q3 deck is attached. Happy to walk you through it on Monday.' },
  { at: at('24', '08:31'), to: VARUN, subject: SUBJECT, body: 'Hi Varun, I would like to introduce you to Jay, who runs growth at Nimbus.' },
  { at: at('24', '08:36'), to: VARUN, cc: ['jj@nimbus.example'], subject: SUBJECT, body: 'Hi Varun, meet Jay (cc), who runs growth at Nimbus. You two should talk about onboarding.' },
  { at: at('24', '08:44'), to: VARUN, cc: ['jay@nimbus.example'], subject: SUBJECT, body: 'Hi Varun, meet Jay (cc), who runs growth at Nimbus. You two should talk about onboarding.' },
  { at: at('24', '08:52'), to: VARUN, cc: ['jay@nimbus.example'], subject: SUBJECT, body: 'Hi Varun, meet Jay (cc), who runs growth at Nimbus. You two should compare notes on onboarding; I will let you take it from here.' },
];
const LATEST = 'pcard5', EARLIER = ['pcard2', 'pcard3', 'pcard4'], UNRELATED = 'pcard1';

type CardRow = Readonly<{ id: string; status: string; withdrawn_reason: string | null }>;
const cardRows = (state: unknown): readonly CardRow[] => ((state as { approvals?: readonly CardRow[] }).approvals) ?? [];
const card = (state: unknown, id: string) => cardRows(state).find((row) => row.id === id);

const KEEPS_LATEST: Receipt = { why: 'the latest Varun draft is the one card still waiting for him', holds: (trial) => card(trial.final_state, LATEST)?.status === 'open' };
const WITHDRAWS_EARLIER: Receipt = {
  why: 'the three earlier Varun drafts are withdrawn, each with a reason',
  holds: (trial) => EARLIER.every((id) => { const row = card(trial.final_state, id); return row?.status === 'withdrawn' && Boolean(row.withdrawn_reason?.trim()); }),
};
const LEAVES_UNRELATED: Receipt = { why: "Priya's card is untouched", holds: (trial) => card(trial.final_state, UNRELATED)?.status === 'open' };

export const APPROVAL_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'a1-tidy-revised-drafts', title: 'Four revised drafts of one email waiting', pain: 'judgment', start: START, world: { approvals: TIDY_CARDS },
    steps: [{ say: "Why do I have four cards for the Varun intro? I only want to approve one, and I can't tell them apart." }],
    rubric: {
      outcome: 'Waldo looks at its waiting cards, keeps only its latest revision of the Varun intro (the 08:52 draft, with jay@nimbus.example in cc) and withdraws the three earlier Varun drafts with a short reason, then tells the owner in a few words which card is left and what tells it apart. The card to Priya about the Q3 deck is a different email and stays waiting.',
      must_not: ['approve, send or claim to send any email', 'withdraw or change the card to Priya', 'keep a draft other than the latest Varun revision', 'raise a new email card'],
    },
    receipts: [KEEPS_LATEST, WITHDRAWS_EARLIER, LEAVES_UNRELATED, none(['mail.send.proposed', 'mail.draft'], 'no new card and no draft')],
  },
];
