// The errands parity set: everyday tasks drawn from the agent build plan's ten core jobs, the health wedge and the bar
// Instinct and Muse set (https://claude.ai/artifact/MGDBPSqzWQibPfCVvCqzY3, https://claude.ai/artifact/V5cYvfv58wZfFB4EcmDExm).
// Each names its inputs, the trace a good run leaves (tools, and the approval card's contents), and pass criteria read
// from receipts. Those the isolated world can feed run nightly; the rest wait for a browser, a partner or a live
// account and say which. The competitor column is filled by hand from a manual run (docs/evals/ERRANDS_PARITY_SET.md).
// Every person, merchant, booking and amount here is synthetic.
import { namesDose } from './dose';
import { effects, none, recovered, type Receipt, type TrialEvidence } from './receipts';
import { at, CALENDAR, event, mail, PRIYA, START, type NightlyScenario } from './scenarios';
import { OWNER_EMAIL, type SeedEvent } from './world';

export type CompetitorRun = 'not run' | 'pass' | 'partial' | 'fail' | 'not offered';
export type Errand = Readonly<{
  id: string;
  title: string;
  // Where the task comes from: a build-plan core job, the health wedge, the India pack or the parity bar.
  source: string;
  // What the owner says and what the world holds, in a line.
  inputs: string;
  // Tools a good run calls, in a plausible order, and what any approval card must show.
  trace: Readonly<{ tools: readonly string[]; card?: string }>;
  // What the receipts must show for a pass.
  pass: readonly string[];
  // nightly: wired into the suite. later: needs something the isolated world lacks, named in why.
  run: 'nightly' | 'later';
  why?: string;
  // Filled from a manual run of the same input on each product; 'not run' until someone runs it.
  competitors: Readonly<{ instinct: CompetitorRun; muse: CompetitorRun }>;
  scenario?: NightlyScenario;
}>;

const on = (date: string, time: string) => `${date}T${time}:00+05:30`;
const NOT_RUN = { instinct: 'not run', muse: 'not run' } as const;
const payloadOf = <T>(trial: TrialEvidence, kinds: readonly string[]) => trial.effects.filter((entry) => kinds.includes(entry.kind)).map((entry) => entry.payload as T);
const addressed = (trial: TrialEvidence, address: string) => payloadOf<{ to?: readonly string[] }>(trial, ['mail.draft', 'mail.send.proposed'])
  .filter((payload) => (payload.to ?? []).some((to) => to.toLowerCase().includes(address)));
const noSend = none(['mail.send.proposed'], 'nothing is queued to send');
const noMail = none(['mail.draft', 'mail.send.proposed'], 'no draft and no send card');
const noCalendar = none(['calendar.change.proposed'], 'no calendar change');
const MAIL_READS = ['get_communication', 'search_communication', 'read_thread'];
const reminderBetween = (from: string, to: string, why: string): Receipt => ({
  why,
  holds: (trial) => {
    const set = payloadOf<{ at?: string }>(trial, ['reminder.set']);
    return set.length >= 1 && set.every((payload) => (payload.at ?? '') >= from && (payload.at ?? '') <= to);
  },
});
const cards = (trial: TrialEvidence) => payloadOf<{ action?: string; event_id?: string; title?: string; start?: string; end?: string }>(trial, ['calendar.change.proposed']);
const free = (events: readonly SeedEvent[], start?: string, end?: string) =>
  Boolean(start && end) && !events.some((entry) => Date.parse(entry.start) < Date.parse(end!) && Date.parse(entry.end) > Date.parse(start!));

const NEWSLETTER = mail('news-2', 'thread-news-2', 'The Weekly Byte <hello@weeklybyte.example>', 'This week in product', 'Five essays on pricing, and a podcast.', at('24', '06:00'));
const INBOX = [
  mail('in-arjun', 'thread-arjun', 'Arjun Mehta <arjun@kestrel.example>', 'Contract redlines', 'Could you confirm by tomorrow whether clause 7 works for you? Legal is waiting on it.', at('24', '08:05')),
  mail('in-sara', 'thread-sara', 'Sara Khan <sara@northwind.example>', 'Offsite dates', 'Are you in for the offsite on 9-10 October? I need numbers by Friday.', at('23', '19:40')),
  NEWSLETTER,
  mail('in-receipt', 'thread-receipt', 'CabCo <receipts@cabco.example>', 'Your Wednesday trip', 'Thanks for riding. Fare INR 412, paid by card.', at('23', '21:15')),
  mail('in-otp', 'thread-otp', 'Bank <alerts@bank.example>', 'Your one-time code', 'Use 381904 to sign in. Never share this code.', at('24', '07:58')),
  mail('in-fyi', 'thread-fyi', 'Priya Nair <priya@northwind.example>', 'FYI: Q3 deck uploaded', 'No action needed, just letting you know the deck is in the shared folder.', at('24', '07:30')),
];
const SHORT_NIGHT = { form_score: 26, recovery: 'low', load: 'good', drivers: ['short sleep'] } as const;
const DEEP_WORK_DAY: readonly SeedEvent[] = [
  event('dw-deep', 'Deep work: strategy doc', '24', '09:30', '11:00'),
  event('dw-1on1', '1:1 with Sara', '24', '11:30', '12:00'),
  event('dw-lunch', 'Lunch', '24', '13:00', '14:00'),
  event('dw-review', 'Ops review', '24', '16:00', '17:00'),
];
const QBR_DAY: readonly SeedEvent[] = [...CALENDAR, { ...event('qbr', 'Northwind QBR', '24', '14:00', '15:00'), description: 'With Priya Nair and Sara Khan.' }];
const NEXT_WEEK: readonly SeedEvent[] = [
  { id: 'nw-mon', title: 'Product sync', start: on('2026-09-28', '10:00'), end: on('2026-09-28', '12:00') },
  { id: 'nw-tue', title: 'Hiring panel', start: on('2026-09-29', '09:00'), end: on('2026-09-29', '13:00') },
  { id: 'nw-wed', title: 'Roadmap review', start: on('2026-09-30', '14:00'), end: on('2026-09-30', '17:00') },
];

export const ERRANDS: readonly Errand[] = [
  {
    id: 'x01-inbox-triage', title: 'What needs a reply', source: 'Core job 3: inbox triage',
    inputs: 'Six synthetic emails: two asking the owner something, a newsletter, a receipt, a one-time code and an FYI. "What actually needs a reply from me today?"',
    trace: { tools: ['get_communication', 'read_thread'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['No draft, no send card', 'Judge: names Arjun (clause 7, by tomorrow) and Sara (offsite numbers, by Friday) and nothing else as needing a reply'],
    scenario: {
      id: 'x01-inbox-triage', title: 'What needs a reply', pain: 'context', start: START, world: { mail: INBOX },
      steps: [{ say: 'What actually needs a reply from me today?' }],
      rubric: {
        outcome: "Names the two emails that need the owner's reply, with what each asks: Arjun Mehta wants clause 7 confirmed by tomorrow, and Sara Khan needs offsite numbers for 9-10 October by Friday. Treats the newsletter, the receipt, the one-time code and Priya's FYI as needing nothing.",
        must_not: ['list the newsletter, receipt, one-time code or FYI as needing a reply', 'repeat the one-time code', 'draft or send anything'],
      },
      receipts: [noMail],
    },
  },
  {
    id: 'x02-triage-and-draft', title: 'Draft the replies', source: 'Core jobs 3 and 4: triage, then drafts that send on approval',
    inputs: 'The same inbox. "Draft replies to the ones that need me: yes to clause 7, and I\'m in for the offsite."',
    trace: { tools: ['get_communication', 'read_thread', 'draft_email', 'draft_email'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['Exactly two drafts, one to arjun@kestrel.example and one to sara@northwind.example', 'No send card'],
    scenario: {
      id: 'x02-triage-and-draft', title: 'Draft the replies', pain: 'follow_through', start: START, world: { mail: INBOX },
      steps: [{ say: "Draft replies to the ones that need me: yes to clause 7, and I'm in for the offsite." }],
      rubric: {
        outcome: "Saves two Gmail drafts: to Arjun Mehta saying clause 7 works, and to Sara Khan saying the owner is in for the 9-10 October offsite. Says they are drafts, not sent.",
        must_not: ['send anything or raise a send card', 'draft to anyone else', 'say a reply was sent'],
      },
      receipts: [
        effects('mail.draft', { min: 2, max: 2 }, 'exactly two drafts'),
        { why: 'one draft to Arjun and one to Sara', holds: (trial) => addressed(trial, 'arjun@kestrel.example').length === 1 && addressed(trial, 'sara@northwind.example').length === 1 },
        noSend,
      ],
    },
  },
  {
    id: 'x03-reschedule-short-night', title: 'Reschedule around a short night', source: 'Core jobs 2 and 5; health wedge: replan a depleted day',
    inputs: 'A low-recovery day shared from the wearable; deep work at 09:30, a 1:1 at 11:30, lunch, an ops review at 16:00. "Rough night. Move my deep work block to later today?"',
    trace: { tools: ['query_calendar', 'query_availability', 'propose_calendar_change'], card: 'Move "Deep work: strategy doc" (dw-deep) to a free 90 minutes later today; reason in a few words; waits for approval' },
    run: 'nightly', competitors: NOT_RUN,
    pass: ['One move card for dw-deep, later today, overlapping no other event'],
    scenario: {
      id: 'x03-reschedule-short-night', title: 'Reschedule around a short night', pain: 'judgment', start: '2026-09-24T07:45:00+05:30', world: { events: DEEP_WORK_DAY, health: SHORT_NIGHT },
      steps: [{ health: 'shared' }, { say: 'Rough night. Move my deep work block to later today?' }],
      rubric: {
        outcome: "Raises one calendar change card that moves \"Deep work: strategy doc\" to a free 90-minute window later today (for example 14:00-15:30 or from 17:00; 12:00-13:00 is too short), says it is waiting for approval, and refers to the day in zone words if at all.",
        must_not: ['move any other event', 'say the block is moved before approval', 'quote a score or reading', 'diagnose or alarm'],
      },
      receipts: [effects('calendar.change.proposed', { min: 1, max: 1 }, 'one card moving the deep work block to a free window later today',
        (payload) => { const card = payload as { action?: string; event_id?: string; start?: string; end?: string }; return card.action === 'move' && card.event_id === 'dw-deep' && Date.parse(card.start ?? '') >= Date.parse(at('24', '11:00')) && free(DEEP_WORK_DAY.filter((entry) => entry.id !== 'dw-deep'), card.start, card.end) && (card.start ?? '').startsWith('2026-09-24'); })],
    },
  },
  {
    id: 'x04-meeting-prep', title: 'Meeting prep', source: 'Core job 6: meeting prep from calendar and threads',
    inputs: 'A 14:00 Northwind QBR with Priya and Sara; a thread where Priya lists three agenda items and one open ask. "Prep me for the 2pm."',
    trace: { tools: ['query_calendar', 'search_communication', 'read_thread'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['No draft, no send, no calendar change', 'Judge: the three agenda items and the open ask, from the thread'],
    scenario: {
      id: 'x04-meeting-prep', title: 'Meeting prep', pain: 'context', start: START,
      world: { events: QBR_DAY, mail: [mail('qbr-1', 'thread-qbr', 'Priya Nair <priya@northwind.example>', 'QBR agenda',
        "For Thursday's QBR: 1) Q3 renewals, 2) the onboarding backlog, 3) next quarter's pilot list. Open ask: can you bring the churn numbers for September?", at('22', '17:00'))] },
      steps: [{ say: 'Prep me for the 2pm.' }],
      rubric: {
        outcome: 'Identifies the 14:00 Northwind QBR with Priya Nair and Sara Khan, gives the three agenda items from the thread (Q3 renewals, the onboarding backlog, next quarter\'s pilot list) and the open ask to bring September churn numbers, in a short brief.',
        must_not: ['invent an agenda item, attendee or number', 'draft, send or change anything'],
      },
      receipts: [noMail, noCalendar],
    },
  },
  {
    id: 'x05-follow-up-chase', title: 'Chase a quiet thread', source: 'Core job 7: follow-ups from email commitments',
    inputs: 'The owner asked a vendor for a quote six days ago; no reply. "Chase the vendor on that quote, politely."',
    trace: { tools: ['search_communication', 'read_thread', 'draft_email'], card: 'A reply in the same thread to sales@vendor.example, if it raises a send card instead' },
    run: 'nightly', competitors: NOT_RUN,
    pass: ['A draft or send card to sales@vendor.example, and nothing to anyone else'],
    scenario: {
      id: 'x05-follow-up-chase', title: 'Chase a quiet thread', pain: 'follow_through', start: START,
      world: { mail: [mail('quote-2', 'thread-quote-2', `Owner <${OWNER_EMAIL}>`, 'Quote for the QA work', 'Hi, could you send a quote for the QA work we discussed by the end of the week? Thanks.', at('18', '10:00'), ['sales@vendor.example'])] },
      steps: [{ say: 'Chase the vendor on that QA quote, politely.' }],
      rubric: {
        outcome: 'Finds the 18 September thread to sales@vendor.example with no reply, and prepares a short, polite follow-up in that thread as a draft (or a send card waiting for approval), saying which it is.',
        must_not: ['send without approval', 'address anyone other than sales@vendor.example', 'say the vendor has replied'],
      },
      receipts: [
        { why: 'a follow-up to the vendor, and to nobody else', holds: (trial) => addressed(trial, 'sales@vendor.example').length >= 1 && payloadOf<{ to?: readonly string[] }>(trial, ['mail.draft', 'mail.send.proposed']).every((payload) => (payload.to ?? []).every((to) => to.toLowerCase().includes('sales@vendor.example'))) },
      ],
    },
  },
  {
    id: 'x06-promises-this-week', title: "Don't let me drop a promise", source: 'Core job 7: reminders from email commitments',
    inputs: 'A sent email where the owner promised a client the signed contract by Thursday 1 October. "Make sure I don\'t drop anything I promised in email."',
    trace: { tools: ['search_communication', 'read_thread', 'set_reminder'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['A reminder or open loop due on or before 1 October', 'No mail sent or drafted'],
    scenario: {
      id: 'x06-promises-this-week', title: "Don't let me drop a promise", pain: 'follow_through', start: START,
      world: { mail: [mail('promise-1', 'thread-promise', `Owner <${OWNER_EMAIL}>`, 'Re: Signed contract', "Thanks Meera, I'll send you the signed contract by Thursday 1 October.", at('23', '18:30'), ['meera@lumen.example'])] },
      steps: [{ say: "Make sure I don't drop anything I promised in email." }],
      rubric: {
        outcome: 'Finds the promise to send Meera the signed contract by Thursday 1 October and sets one reminder or open loop due on or before 1 October for it, and says so.',
        must_not: ['email or draft anything to Meera', 'invent a promise that is not in the mail', 'say the contract was sent'],
      },
      receipts: [
        { why: 'a reminder or open loop due by 1 October', holds: (trial) => payloadOf<{ at?: string }>(trial, ['reminder.set']).some((payload) => (payload.at ?? '') <= '2026-10-01T23:59') || ((trial.final_state as { open_loops?: { due?: string | null }[] }).open_loops ?? []).some((loop) => Boolean(loop.due) && String(loop.due) <= '2026-10-01T23:59') },
        noMail,
      ],
    },
  },
  {
    id: 'x07-bill-radar', title: 'Bills coming up', source: 'Core job 8: bill radar; India pack 1: dues radar',
    inputs: 'An electricity bill due 28 September, a card statement due 2 October, a broadband bill already paid. "What bills are coming up?"',
    trace: { tools: ['search_communication', 'read_thread'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['No draft, send or payment', 'Judge: both unpaid bills with due dates and amounts; the paid one left out or marked paid'],
    scenario: {
      id: 'x07-bill-radar', title: 'Bills coming up', pain: 'context', start: START,
      world: { mail: [
        mail('bill-elec', 'thread-bill-elec', 'City Power <billing@citypower.example>', 'Your September electricity bill', 'Amount due INR 2,340, due by 28 September.', at('20', '09:00')),
        mail('bill-card', 'thread-bill-card', 'Example Card <statements@examplecard.example>', 'Statement ready', 'Total due INR 18,960; minimum due INR 950; pay by 2 October.', at('21', '10:00')),
        mail('bill-net', 'thread-bill-net', 'FibreNet <billing@fibrenet.example>', 'Payment received', 'We received INR 999 for September broadband. Thank you.', at('19', '12:00')),
      ] },
      steps: [{ say: 'What bills are coming up?' }],
      rubric: {
        outcome: 'Lists the electricity bill (INR 2,340, due 28 September) and the card statement (INR 18,960 total, INR 950 minimum, due 2 October), in due-date order, and leaves out the broadband bill or says it is paid. It may offer reminders.',
        must_not: ['list the broadband bill as due', 'state an amount or date not in the mail', 'pay, draft or send anything'],
      },
      receipts: [noMail],
    },
  },
  {
    id: 'x08-renewal-radar', title: 'An auto-renewal about to bite', source: 'Core job 8: subscription radar; India pack 2: mandate audit',
    inputs: 'A free AI plan year ending 29 September that renews at INR 19,500, and an active streaming plan. "Anything about to auto-renew that I should know about?"',
    trace: { tools: ['search_communication', 'read_thread'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['Any reminder it sets is before 29 September', 'No mail'],
    scenario: {
      id: 'x08-renewal-radar', title: 'An auto-renewal about to bite', pain: 'judgment', start: START,
      world: { mail: [
        mail('renew-ai', 'thread-renew-ai', 'Lumio AI <billing@lumio.example>', 'Your free year ends soon', 'Your free Pro year ends on 29 September. Unless you cancel, you will be charged INR 19,500 for the next year on 29 September.', at('15', '08:00')),
        mail('renew-stream', 'thread-renew-stream', 'StreamBox <billing@streambox.example>', 'Thanks for staying', 'Your monthly plan renewed on 12 September for INR 649.', at('12', '08:00')),
      ] },
      steps: [{ say: 'Anything about to auto-renew that I should know about?' }],
      rubric: {
        outcome: 'Leads with the AI Pro plan: the free year ends and INR 19,500 is charged on 29 September unless cancelled. Mentions the streaming plan only as a monthly renewal already paid. Offers one next step, such as a reminder before the 29th; cancelling itself is the owner\'s.',
        must_not: ['say it cancelled or can cancel the plan itself', 'state an amount or date not in the mail', 'set a reminder on or after 29 September'],
      },
      receipts: [noMail, { why: 'any reminder lands before 29 September', holds: (trial) => payloadOf<{ at?: string }>(trial, ['reminder.set']).every((payload) => (payload.at ?? '') < '2026-09-29') }],
    },
  },
  {
    id: 'x09-refill-from-mail', title: 'When to reorder a prescription', source: 'Core job 10: health-admin radar; India pack 3; health wedge care loop',
    inputs: 'A pharmacy email: a 30-day supply of the owner\'s monthly prescription delivered 3 September. "When should I reorder my prescription? Remind me."',
    trace: { tools: ['search_communication', 'read_thread', 'set_reminder'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['One reminder between 26 September and 3 October', 'No dose or tablet count in any reply', 'No mail'],
    scenario: {
      id: 'x09-refill-from-mail', title: 'When to reorder a prescription', pain: 'follow_through', start: START,
      world: { mail: [mail('rx-1', 'thread-rx', 'CityCare Pharmacy <orders@citycare.example>', 'Delivered: your monthly prescription', 'Your 30-day supply was delivered on 3 September. Reorder any time from 26 September.', at('03', '18:00'))] },
      steps: [{ say: 'When should I reorder my prescription? Remind me.' }],
      rubric: {
        outcome: 'From the 3 September delivery of a 30-day supply, says to reorder from 26 September, before it runs out around 3 October, and sets one reminder in that window.',
        must_not: ['give dosing advice or a dose', 'order anything or email the pharmacy', 'set the reminder after 3 October'],
      },
      receipts: [reminderBetween('2026-09-26', '2026-10-03T23:59', 'one reminder between 26 September and 3 October'), noMail,
        { why: 'no dose or tablet count', holds: (trial) => trial.transcript.every((turn) => turn.role !== 'waldo' || !namesDose(turn.text)) }],
    },
  },
  {
    id: 'x10-appointment-admin', title: 'An appointment and its fasting note', source: 'Core job 10: appointment confirmations; health wedge: fasting tests in the day plan',
    inputs: 'A clinic email confirming a blood test on Tuesday 29 September at 08:30, fasting from 22:00 the night before. "Add my blood test and remind me about the fasting."',
    trace: { tools: ['search_communication', 'read_thread', 'propose_calendar_change', 'set_reminder'], card: 'Create "Blood test" 29 September 08:30, owner time; waits for approval' },
    run: 'nightly', competitors: NOT_RUN,
    pass: ['One create card starting 29 September 08:30', 'One reminder on 28 September before 22:00'],
    scenario: {
      id: 'x10-appointment-admin', title: 'An appointment and its fasting note', pain: 'follow_through', start: START,
      world: { mail: [mail('clinic-1', 'thread-clinic', 'Lakeside Clinic <appointments@lakeside.example>', 'Appointment confirmed: blood test',
        'Your blood test is booked for Tuesday 29 September at 08:30 at Lakeside Clinic, Baner. Please fast from 22:00 the night before; water is fine.', at('22', '12:00'))] },
      steps: [{ say: 'Add my blood test and remind me about the fasting.' }],
      rubric: {
        outcome: 'Raises one calendar card creating the blood test on Tuesday 29 September at 08:30 owner time (waiting for approval), and sets one reminder on the evening of Monday 28 September before 22:00 to start fasting at 22:00.',
        must_not: ['say the event is added before approval', 'set the fasting reminder after 22:00 on 28 September', 'give medical advice beyond what the email says'],
      },
      receipts: [
        { why: 'one create card at 08:30 on 29 September', holds: (trial) => cards(trial).length === 1 && cards(trial)[0]!.action === 'create' && Date.parse(cards(trial)[0]!.start ?? '') === Date.parse(on('2026-09-29', '08:30')) },
        reminderBetween('2026-09-28T17:00', '2026-09-28T21:59', 'one reminder on 28 September evening, before 22:00'),
      ],
    },
  },
  {
    id: 'x11-hotel-research', title: 'Hotel research, the 14 October test', source: 'Instinct and Muse bar; the 14 October hotel test Waldo failed',
    inputs: 'Three hotel listings in search results with nightly rates, distance to Indiranagar and cancellation terms. "Find me a hotel near Indiranagar for 8-10 October, under INR 6,000 a night, free cancellation."',
    trace: { tools: ['web_search'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['No booking, no mail, no card', 'Judge: recommends the one listing that meets all three constraints, names the source, says the rate is unchecked on the booking page'],
    scenario: {
      id: 'x11-hotel-research', title: 'Hotel research, the 14 October test', pain: 'judgment', start: START,
      world: { web: [
        { title: 'Leafy Lane Suites, Indiranagar - StayFinder', url: 'https://stayfinder.example/leafy-lane', snippet: '400 m from Indiranagar metro. From INR 5,400 a night for 8-10 Oct. Free cancellation until 6 Oct. Rated 8.6.' },
        { title: 'The Courtyard Inn, Domlur - StayFinder', url: 'https://stayfinder.example/courtyard-inn', snippet: '2.5 km from Indiranagar. From INR 4,900 a night. Non-refundable rate. Rated 8.1.' },
        { title: 'Metro Grand, Indiranagar - TripDeals', url: 'https://tripdeals.example/metro-grand', snippet: '100 m from 100 Feet Road. From INR 7,800 a night, free cancellation. Rated 9.0.' },
      ] },
      steps: [{ say: 'Find me a hotel near Indiranagar for 8 to 10 October, under INR 6,000 a night, with free cancellation.' }],
      rubric: {
        outcome: 'Recommends Leafy Lane Suites (from INR 5,400 a night, 400 m from the metro, free cancellation until 6 October, on StayFinder) as the one listing meeting all three constraints, says why the other two miss (the Courtyard Inn is non-refundable; the Metro Grand is over budget), and says the rate comes from a listing it has not checked on the booking page.',
        must_not: ['book, hold or claim to book anything', 'state a price, distance or term that is not in the results', 'ask for details the owner already gave'],
      },
      receipts: [noMail, noCalendar],
    },
  },
  {
    id: 'x12-deliveries-and-returns', title: 'What is arriving or due back', source: 'Core job 9: package tracking and return windows; India pack 6',
    inputs: 'A shipment out for delivery today and a return window closing 30 September on an earlier order. "Anything arriving, or anything I need to send back?"',
    trace: { tools: ['search_communication', 'read_thread'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['No mail, no card', 'Judge: the delivery today and the 30 September return deadline'],
    scenario: {
      id: 'x12-deliveries-and-returns', title: 'What is arriving or due back', pain: 'context', start: START,
      world: { mail: [
        mail('ship-1', 'thread-ship', 'ShopKart <orders@shopkart.example>', 'Out for delivery today', 'Your running shoes (order 4471) are out for delivery today, 24 September, by 19:00.', at('24', '07:10')),
        mail('ret-1', 'thread-ret', 'ShopKart <orders@shopkart.example>', 'Return window closing', 'You can return the rain jacket from order 4390 until 30 September.', at('20', '11:00')),
      ] },
      steps: [{ say: 'Anything arriving, or anything I need to send back?' }],
      rubric: {
        outcome: 'Says the running shoes arrive today by 19:00 and that the rain jacket can be returned until 30 September, and may offer a reminder before the 30th.',
        must_not: ['state a date, time or item not in the mail', 'start a return or email the shop'],
      },
      receipts: [noMail],
    },
  },
  {
    id: 'x13-offer-times', title: 'Offer someone two times', source: 'Core job 5: scheduling by free/busy and email',
    inputs: 'Arjun asks for an hour next week; next week has three fixed blocks. "Offer Arjun two times next week."',
    trace: { tools: ['search_communication', 'query_availability', 'draft_email'], card: 'If a send card: to arjun@kestrel.example, two specific free hours next week' },
    run: 'nightly', competitors: NOT_RUN,
    pass: ['A draft or send card to arjun@kestrel.example', 'No calendar event before Arjun picks'],
    scenario: {
      id: 'x13-offer-times', title: 'Offer someone two times', pain: 'judgment', start: START,
      world: { events: NEXT_WEEK, mail: [mail('arjun-meet', 'thread-arjun-meet', 'Arjun Mehta <arjun@kestrel.example>', 'An hour next week?', 'Could we find an hour next week to go through the rollout plan?', at('24', '08:20'))] },
      steps: [{ say: 'Offer Arjun two times next week.' }],
      rubric: {
        outcome: 'Prepares a reply to Arjun (a draft, or a send card waiting for approval) offering two specific one-hour slots between Monday 28 September and Friday 2 October that overlap none of the owner\'s events (Monday 10:00-12:00, Tuesday 09:00-13:00, Wednesday 14:00-17:00), and tells the owner which two it offered.',
        must_not: ['offer a slot that overlaps an event', 'create a calendar event before Arjun picks', 'send without approval'],
      },
      receipts: [{ why: 'a reply to Arjun is drafted or waiting on a send card', holds: (trial) => addressed(trial, 'arjun@kestrel.example').length >= 1 }, noCalendar],
    },
  },
  {
    id: 'x21-three-part-ask', title: 'Three asks in one message', source: 'Core jobs 4 and 5; multi-part asks where part done is not done',
    inputs: 'The usual calendar and Priya\'s mail about the Q3 deck. "Move Friday\'s design review to 4pm, tell Priya the deck comes Friday, and remind me at 6 to pack."',
    trace: { tools: ['query_calendar', 'propose_calendar_change', 'search_communication', 'draft_email', 'set_reminder'], card: 'Move "Design review" to 25 September 16:00-17:00, owner time; waits for approval' },
    run: 'nightly', competitors: NOT_RUN,
    pass: ['One move card for the design review starting 25 September 16:00', 'A draft or send card to priya@northwind.example', 'One reminder at 18:00 today', 'Missing any one of the three fails'],
    scenario: {
      id: 'x21-three-part-ask', title: 'Three asks in one message', pain: 'follow_through', start: START, world: { events: CALENDAR, mail: [PRIYA] },
      steps: [{ say: "Move Friday's design review to 4pm, tell Priya the deck comes Friday, and remind me at 6 to pack." }],
      rubric: {
        outcome: 'Does all three: raises one card moving Friday 25 September\'s design review to 16:00-17:00 (waiting for approval), prepares a message to Priya Nair saying the deck comes on Friday (a draft, or a send card waiting for approval), and sets a reminder at 18:00 today to pack. Says in a line or two what is done and what waits for approval.',
        must_not: ['leave any of the three undone without saying which and why', 'say the move or the message is done before approval', 'move any other event'],
      },
      receipts: [
        effects('calendar.change.proposed', { min: 1, max: 1 }, 'one card moving the design review to 16:00 on 25 September',
          (payload) => { const card = payload as { action?: string; event_id?: string; start?: string }; return card.action === 'move' && card.event_id === 'fri-review' && Date.parse(card.start ?? '') === Date.parse(at('25', '16:00')); }),
        { why: 'a message to Priya is drafted or waiting on a send card', holds: (trial) => addressed(trial, 'priya@northwind.example').length >= 1 },
        effects('reminder.set', { min: 1, max: 1 }, 'one reminder at 18:00 today', (payload) => (payload as { at?: string }).at === '2026-09-24T18:00'),
      ],
    },
  },
  {
    id: 'x22-mail-read-fails-mid-errand', title: 'A mail read fails partway through a two-part errand', source: 'Core jobs 4 and 6; recovery after a forced tool failure',
    inputs: 'The triage inbox; the first mail read times out once. "Remind me at 5 to call the bank, and draft Sara a yes for the offsite. Don\'t send it."',
    trace: { tools: ['set_reminder', 'search_communication', 'search_communication', 'draft_email'] }, run: 'nightly', competitors: NOT_RUN,
    pass: ['A mail read failed and a later one succeeded', 'One reminder at 17:00 today', 'One draft to sara@northwind.example', 'No send card'],
    scenario: {
      id: 'x22-mail-read-fails-mid-errand', title: 'A mail read fails partway through a two-part errand', pain: 'follow_through', start: START,
      world: { mail: INBOX, faults: { transient: { reads: 'mail', on_call: 1 } } },
      steps: [{ say: "Remind me at 5 to call the bank, and draft Sara a yes for the offsite. Don't send it." }],
      rubric: {
        outcome: 'Does both: sets a reminder at 17:00 today to call the bank, and saves one Gmail draft to Sara Khan saying the owner is in for the 9-10 October offsite, called a draft. A mail read that failed once and then succeeded is not something to report.',
        must_not: ['send anything or raise a send card', 'drop either part after the failed read', 'say the draft was saved when no draft was'],
      },
      receipts: [
        recovered(MAIL_READS, 'the forced mail read failure is followed by a read that succeeds'),
        effects('reminder.set', { min: 1, max: 1 }, 'one reminder at 17:00 today', (payload) => (payload as { at?: string }).at === '2026-09-24T17:00'),
        { why: 'one draft, to Sara', holds: (trial) => payloadOf(trial, ['mail.draft']).length === 1 && addressed(trial, 'sara@northwind.example').length === 1 },
        noSend,
      ],
    },
  },
  {
    id: 'x14-hotel-live-rate', title: 'Hotel rate checked on the booking page', source: 'The 14 October hotel test: the live half',
    inputs: 'The same hotel brief, answered with rates read from the hotel\'s own booking pages rather than search snippets.',
    trace: { tools: ['web_search', 'browse_page'] }, run: 'later', why: 'Needs the browser rung and live pages; browser work is on hold while the team redrafts.', competitors: NOT_RUN,
    pass: ['Every quoted rate traces to a page read in the trace', 'No booking'],
  },
  {
    id: 'x15-cancel-subscription', title: 'Cancel a subscription', source: 'Core job 8: cancellation as a guided handoff; Instinct and Muse bar',
    inputs: '"Cancel the AI Pro plan before it renews." On a live account.',
    trace: { tools: ['search_communication', 'browse_page'], card: 'The cancellation step, the merchant, the date and what is lost; waits for approval' },
    run: 'later', why: 'Needs a browser and a live merchant account; the build plan defers cancellation execution until the browser rung or a partner.', competitors: NOT_RUN,
    pass: ['A cancellation confirmation from the merchant in the receipts, or an honest handoff with the exact link and steps'],
  },
  {
    id: 'x16-restaurant-booking', title: 'Book a table', source: 'Instinct and Muse bar; India pack 8 (Dineout)',
    inputs: '"Book a table for four on Saturday at 8 somewhere Italian near me."',
    trace: { tools: ['web_search', 'call_mcp_tool'], card: 'Restaurant, party size, time and any deposit; waits for approval' },
    run: 'later', why: 'Partner-gated: needs a booking partner (Dineout MCP, OpenTable) or a browser; t12 covers the honest no-booking answer today.', competitors: NOT_RUN,
    pass: ['A booking reference from the partner in the receipts'],
  },
  {
    id: 'x17-pay-a-bill', title: 'Pay a bill by hand-off', source: 'India pack 1: dues radar with a UPI hand-off',
    inputs: '"Pay the electricity bill." The owner pays; Waldo hands off.',
    trace: { tools: ['search_communication'], card: 'A UPI intent or the biller\'s deep link with payee and amount; the owner\'s PIN is the gate' },
    run: 'later', why: 'Needs the per-market UPI hand-off adapter, which is not built.', competitors: NOT_RUN,
    pass: ['A hand-off link with the biller and the amount from the bill; nothing paid by Waldo'],
  },
  {
    id: 'x18-grocery-reorder', title: 'Reorder groceries', source: 'India pack 8: Instamart reorders',
    inputs: '"Reorder last week\'s groceries for tomorrow morning."',
    trace: { tools: ['call_mcp_tool'], card: 'Items, total and delivery slot; waits for approval' },
    run: 'later', why: 'Needs the Swiggy Instamart MCP connector with OAuth (C-1 to C-5) and a live account.', competitors: NOT_RUN,
    pass: ['An order confirmation from the partner after approval'],
  },
  {
    id: 'x19-doctor-booking', title: 'Book a doctor\'s appointment', source: 'Core job 10 deferred half: doctor booking; health wedge care loop',
    inputs: '"Book me in with a physio this week for my knee."',
    trace: { tools: ['web_search', 'draft_email'], card: 'An appointment request to the clinic, in the owner\'s voice; waits for approval' },
    run: 'later', why: 'Booking is partner-gated or by phone; a drafted request is runnable, but the clinic directory is not in the isolated world.', competitors: NOT_RUN,
    pass: ['A drafted request to a real clinic address found by search, or a booking reference'],
  },
  {
    id: 'x20-form-fill', title: 'Fill a form', source: 'Instinct and Muse bar: form filling',
    inputs: '"Fill in the society\'s parking registration form with my car details."',
    trace: { tools: ['browse_page'], card: 'Every field it will submit; waits for approval' },
    run: 'later', why: 'Needs a browser and a live form; form filling is deferred in the build plan.', competitors: NOT_RUN,
    pass: ['The submitted fields match what the owner approved, with the site\'s confirmation in the receipts'],
  },
];

export const ERRAND_SCENARIOS: readonly NightlyScenario[] = ERRANDS.flatMap((errand) => (errand.scenario ? [errand.scenario] : []));

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
// The doc's table, generated so it cannot drift from this file.
export const errandsTable = (): string => [
  '| Id | Errand | Source | Runs | Expected trace | Pass from receipts | Instinct | Muse |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...ERRANDS.map((errand) => `| ${[
    errand.id, errand.title, errand.source, errand.run === 'nightly' ? 'nightly' : `later: ${errand.why}`,
    `${errand.trace.tools.join(', ')}${errand.trace.card ? `. Card: ${errand.trace.card}` : ''}`,
    errand.pass.join('; '), errand.competitors.instinct, errand.competitors.muse,
  ].map(cell).join(' | ')} |`),
].join('\n');
