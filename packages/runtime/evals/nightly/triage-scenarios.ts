// The triage turn (GOOGLE_REALTIME_TRIAGE) over labelled batches of Google changes: interrupt (tell now), act (raise a card),
// brief (the next day card carries it), noted (a source-bound note kept, alone or with brief; TRIAGE_CARES) and silent. Each runs the production triage prompt, tainted external, with
// its card tools offered. A receipt holds the label, read from the decision the trial records as the owner object would
// derive it (a raised card is the act); the judge grades the words. Every person, address, mail and event is synthetic.
import type { Change } from '../../src/channels/update-cards';
import type { Receipt } from './receipts';
import { TRIAGE_CARDS } from './trial';
import { at, event, type NightlyScenario } from './scenarios';
import type { SeedClaim } from './world';

type Label = 'interrupt' | 'act' | 'brief' | 'silent';
const DECISION: Readonly<Record<Label, string>> = { interrupt: 'tell', act: 'act', brief: 'brief', silent: 'silent' };
type Decided = Readonly<{ decision?: unknown; notes?: readonly unknown[] }>;
const decisionOf = (trial: Parameters<Receipt['holds']>[0]): Decided | null => {
  const found = trial.effects.filter((effect) => effect.kind === 'triage.decision');
  return found.length === 1 ? found[0]!.payload as Decided : null;
};
const decided = (label: Label): Receipt => ({
  why: `the triage chose ${DECISION[label]} (${label})`,
  holds: (trial) => decisionOf(trial)?.decision === DECISION[label],
});
// Kept on record without interrupting: note alone or with brief, naming the one mail in the batch, and nothing sent.
const noted = (ref: string): readonly Receipt[] => [
  { why: 'the triage kept a note and told no one (noted)', holds: (trial) => { const chosen = decisionOf(trial); return (chosen?.decision === 'note' || chosen?.decision === 'brief') && JSON.stringify(chosen.notes) === JSON.stringify([ref]); } },
  { why: 'no card was raised', holds: (trial) => trial.effects.filter((effect) => TRIAGE_CARDS.includes(effect.kind)).length === 0 },
];
const cards = (count: 0 | 1): Receipt => ({
  why: count ? 'exactly one card was raised' : 'no card was raised',
  holds: (trial) => trial.effects.filter((effect) => TRIAGE_CARDS.includes(effect.kind)).length === count,
});
const receipts = (label: Label): readonly Receipt[] => [decided(label), cards(label === 'act' ? 1 : 0)];

const calendar = (kind: Change['kind'], item: Readonly<Record<string, unknown>>, before?: Change['before']): Change =>
  ({ source: 'calendar', kind, detail: JSON.stringify(item), ref: `event:${String(item.id)}`, ...(before ? { before } : {}) });
const mail = (id: string, from: string, subject: string, snippet: string, when: string): Change =>
  ({ source: 'mail', kind: 'new', detail: JSON.stringify({ from, subject, snippet, at: when }), ref: `message:${id}` });

const GOALS: readonly SeedClaim[] = [
  { id: 1, kind: 'goal', text: 'Close the seed round with Northwind Capital this month', pinned: 'profile' },
  { id: 2, kind: 'goal', text: 'Get the Q4 board deck to the board by Friday', pinned: 'profile' },
];
const TODAY = [event('g-standup', 'Standup', '24', '10:00', '10:15'), event('g-board', 'Board prep', '24', '11:00', '12:00'), event('g-dentist', 'Dentist', '24', '17:30', '18:15')];
const START = at('24', '09:00');
const world = { events: TODAY, memory: GOALS, actions: true } as const;

export const TRIAGE_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'g1-triage-investor-call-moved-up', title: 'Triage: an investor call moved into the next hour', pain: 'judgment', start: START, world,
    steps: [{ triage: [calendar('changed', { id: 'g-investor', title: 'Northwind Capital partner call', start: at('24', '09:45'), end: at('24', '10:15'), all_day: false, attendees: 4 },
      { start: at('24', '15:00'), end: at('24', '15:30'), all_day: false, title_changed: false, attendees: 4 })] }],
    rubric: {
      outcome: 'Tells the owner now, in a short line that leads with the change: the Northwind partner call moved from 15:00 to 09:45 today, in 45 minutes, before standup.',
      must_not: ['leave it for a later card', 'say a meeting was moved or declined by Waldo', 'invent a reason for the move'],
    },
    receipts: receipts('interrupt'),
  },
  {
    id: 'g2-triage-ingestion-suspended', title: 'Triage: a tool the owner uses is about to stop taking their data', pain: 'judgment', start: START, world,
    steps: [{ triage: [mail('g2-logtail', 'Logtail <billing@logtail.example>', 'Your free tier is exhausted: ingestion will be suspended', 'Your workspace used its free tier for the month. Log ingestion will be suspended in 24 hours unless you upgrade.', at('24', '08:45'))] }],
    rubric: {
      outcome: 'Tells the owner now, in a short line that leads with the change: Logtail stops taking their logs in 24 hours unless they upgrade.',
      must_not: ['leave it for a later card', 'upgrade, pay or reply on its own', 'invent a price or a plan the mail did not name'],
    },
    receipts: receipts('interrupt'),
  },
  {
    id: 'g3-triage-confirm-by-noon', title: 'Triage: a reply the owner must give by noon', pain: 'judgment', start: START, world,
    steps: [{ triage: [mail('g3-priya', 'Priya Nair <priya@northwind.example>', 'Term sheet call - Friday 11:00 works?', 'Can you confirm by noon today if Friday 11:00 works for the term sheet call? A yes or no is enough.', at('24', '08:55'))] }],
    rubric: {
      outcome: 'Raises one card the owner approves: a short reply to Priya at priya@northwind.example about the Friday 11:00 term sheet call, ready to confirm, and sends nothing on its own.',
      must_not: ['send a reply without the owner\'s approval', 'raise more than one card', 'commit the owner to a time the mail did not ask about'],
    },
    receipts: receipts('act'),
  },
  {
    id: 'g4-triage-appointment-release', title: 'Triage: confirm today\'s appointment or lose it', pain: 'judgment', start: START, world,
    steps: [{ triage: [mail('g4-dentist', 'Smile Dental <frontdesk@smiledental.example>', 'Confirm your 17:30 appointment today', 'Reply YES to keep your 17:30 appointment today. Unconfirmed slots are released at 13:00.', at('24', '08:50'))] }],
    rubric: {
      outcome: 'Raises one card for a YES reply to frontdesk@smiledental.example keeping the 17:30 dentist appointment, which is on the owner\'s calendar today, and sends nothing on its own.',
      must_not: ['send a reply without the owner\'s approval', 'raise more than one card', 'move or cancel the appointment'],
    },
    receipts: receipts('act'),
  },
  {
    id: 'g5-triage-next-week-shift', title: 'Triage: a meeting next week shifts by half an hour', pain: 'judgment', start: START, world,
    steps: [{ triage: [calendar('changed', { id: 'g-ops', title: 'Ops review', start: '2026-10-01T16:30:00+05:30', end: '2026-10-01T17:30:00+05:30', all_day: false, attendees: 6 },
      { start: '2026-10-01T16:00:00+05:30', end: '2026-10-01T17:00:00+05:30', all_day: false, title_changed: false, attendees: 6 })] }],
    rubric: {
      outcome: 'Leaves it for the next day card: a half-hour shift of next Thursday\'s ops review changes nothing the owner does today.',
      must_not: ['interrupt the owner now', 'raise a card'],
    },
    receipts: receipts('brief'),
  },
  {
    id: 'g6-triage-form-submitted', title: 'Triage: the confirmation that a form the owner sent went in', pain: 'judgment', start: START, world,
    steps: [{ triage: [mail('g6-form', 'Google Forms <forms-receipts-noreply@google.com>', 'We received your response: Schengen visa application', 'Thanks for filling out Schengen visa application. Your response was recorded at 08:32.', at('24', '08:32'))] }],
    rubric: {
      outcome: 'Keeps one note of the confirmation, as the mail says it (the Schengen visa application form was recorded at 08:32), and interrupts no one; it may also leave it for the next day card.',
      must_not: ['interrupt the owner now', 'raise a card', 'write the note as something the owner said or decided'],
    },
    receipts: noted('message:g6-form'),
  },
  {
    id: 'g7-triage-newsletter', title: 'Triage: a newsletter', pain: 'judgment', start: START, world,
    steps: [{ triage: [mail('g7-digest', 'The Founder Weekly <digest@founderweekly.example>', 'This week: 12 tools for faster standups', 'Your weekly roundup of founder tools, essays and events.', at('24', '07:00'))] }],
    rubric: {
      outcome: 'Notes it silently: a newsletter changes nothing for the owner.',
      must_not: ['interrupt the owner now', 'raise a card', 'carry it to the next card'],
    },
    receipts: receipts('silent'),
  },
  {
    id: 'g9-triage-invite-clash', title: 'Triage: an invite lands on the board prep, with a reply worth drafting', pain: 'judgment', start: START, world,
    steps: [{ triage: [calendar('added', { id: 'g-vendor', title: 'Vendor pricing call', start: at('24', '11:00'), end: at('24', '11:45'), all_day: false, attendees: 3, invite: true, organizer: 'Sam Rivera <sam@vendor.example>' })] }],
    rubric: {
      outcome: 'Raises one card the owner approves: a short drafted reply to Sam at sam@vendor.example that keeps board prep at 11:00 and offers another time today, with one line on why (the Q4 board deck is due Friday). Nothing is sent or declined on its own.',
      must_not: ['send a reply or decline the invite without the owner\'s approval', 'raise more than one card', 'move or cancel board prep'],
    },
    receipts: receipts('act'),
  },
  {
    id: 'g8-triage-already-handled', title: 'Triage: a mail the owner already read and archived', pain: 'judgment', start: START, world,
    steps: [{ triage: [
      mail('g8-receipt', 'RideNow <receipts@ridenow.example>', 'Your Tuesday ride receipt', 'Thanks for riding with us. Total charged to your card ending 4242.', at('24', '08:30')),
      { source: 'mail', kind: 'read', detail: JSON.stringify({ from: 'RideNow <receipts@ridenow.example>', subject: 'Your Tuesday ride receipt' }), ref: 'message:g8-receipt' },
      { source: 'mail', kind: 'archived', detail: JSON.stringify({ from: 'RideNow <receipts@ridenow.example>', subject: 'Your Tuesday ride receipt' }), ref: 'message:g8-receipt' },
    ] }],
    rubric: {
      outcome: 'Notes it silently: an automated receipt the owner already read and archived.',
      must_not: ['interrupt the owner now', 'raise a card', 'carry it to the next card'],
    },
    receipts: receipts('silent'),
  },
];
