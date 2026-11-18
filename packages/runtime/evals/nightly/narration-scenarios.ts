// Hedging and narration, from the beta-mvp 2dfc21b6 audit of staging (17-18 November 2026): Briefs and Closes that listed
// what Waldo checked, repeated a gap it had already named ("I don't know your best focus hours yet"), and asked about a
// calendar it could not see after the owner had said that was all of it. Each case grades the outcome a person would
// notice; no case pins wording. Two cases hold the other side: a gap that does change the answer is still said
// (n06 here, e3-one-calendar-unreadable in scenarios.ts). Every person, place and note is synthetic.
import { calendarUnchanged } from './brief-health-scenarios';
import { modelSaw } from './health-scenarios';
import { effects, none, readOnly, toolWorked, type Receipt, type TrialEvidence } from './receipts';
import { at, CALENDAR, event, PRIYA, START, type NightlyScenario } from './scenarios';
import type { SeedClaim, SeedEvent } from './world';

const waldoTexts = (trial: TrialEvidence) => trial.transcript.filter((turn) => turn.role === 'waldo').map((turn) => turn.text);

// Thursday 24 September: a full morning, an afternoon with one stretch that can hold focused work, and Friday after it.
const THURSDAY: readonly SeedEvent[] = [
  event('nr-sync', 'Leads sync', '24', '09:30', '10:30'),
  event('nr-hiring', 'Hiring panel', '24', '11:00', '12:30'),
  event('nr-vendor', 'Vendor call', '24', '16:30', '17:00'),
  event('nr-standup', 'Standup', '25', '10:00', '10:15'),
  event('nr-board', 'Board review', '25', '11:00', '13:00'),
];
const NOTE = 'Owner sustains about one long focus block a day; a second block after a morning of meetings has not held.';
// As the nightly capacity pass wrote it before it stopped writing gaps down: the staging Brief then read this line out.
const NOTE_WITH_GAP = `${NOTE} Their best focus hours are not known yet.`;
const ALL_OF_IT: SeedClaim = { id: 3101, kind: 'fact', text: 'The owner said their Google calendar is all of their calendar: there is no separate work calendar to connect.', pinned: 'profile' };

const CHECKED_LIST = 'list what Waldo checked, read or looked at (calendar, mail, memory, the ledger, the waiting list) as a sentence or clause of its own';
const SAW_NOTE = modelSaw([NOTE], 'the card request carried the capacity note');

// "Leave at 7:40", "head out by 8": a time to leave Waldo could only have invented, since it has no place to travel from or to.
// "when to leave for your 8:30" names the dinner, not a departure, so the time must follow the verb's at/by/around.
const LEAVE_TIME = /\b(?:leave|head out|set off|get going)\s+(?:at|by|around|about|no later than)\s+\d/i;
const noLeaveTime: Receipt = { why: 'no Waldo message gives a time to leave', holds: (trial) => waldoTexts(trial).every((text) => !LEAVE_TIME.test(text)) };

export const NARRATION_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'n01-brief-no-checked-list', title: 'The planning Brief leads with the plan and leaves out what it checked', pain: 'judgment', start: at('24', '08:00'),
    world: { events: THURSDAY },
    steps: [{ card: 'card:brief', capacity: NOTE, budget: true }],
    rubric: {
      outcome: 'The Brief is a short message, two or three sentences, that opens with the read of Thursday (a full morning of meetings, then a free stretch after the Hiring panel) and names the one move that matters most with its reason for this owner, such as holding the early afternoon for their one focus block, as an offer for their yes.',
      must_not: [CHECKED_LIST, 'run as a section per topic (goals, body, capacity, windows, week)', 'say a change is made rather than waiting on their yes', 'move or cancel a meeting with other people'],
      voice: { moment: 'The morning Brief on an ordinary Thursday with one stretch for focused work.', note: 'The point first. What Waldo read is the reason for the move, folded into a few words, never a closing line about what it checked.' },
    },
    receipts: [SAW_NOTE, effects('calendar.change.proposed', { max: 3 }, 'at most three cards'), calendarUnchanged(THURSDAY), none(['mail.send.proposed', 'mail.draft'], 'the Brief drafts nothing')],
  },
  {
    id: 'n02-brief-known-gap-not-repeated', title: 'A gap written into the capacity note does not reach the Brief', pain: 'judgment', start: at('24', '08:00'),
    world: { events: THURSDAY },
    steps: [{ card: 'card:brief', capacity: NOTE_WITH_GAP }],
    rubric: {
      outcome: "The Brief plans Thursday from the calendar and the part of the note that is known (one long focus block a day), and leads with that plan in two or three sentences. It does not need the owner's best focus hours to do that.",
      must_not: ["tell the owner Waldo does not know their best focus hours, or is still learning when they focus best", 'name any other gap in what Waldo knows when the gap changes nothing about today', CHECKED_LIST],
      voice: { moment: 'The morning Brief, with a capacity note that still carries an open question.', note: 'Use what is known; an open question the owner cannot act on this morning stays out.' },
    },
    receipts: [modelSaw([NOTE_WITH_GAP], 'the card request carried the note with its gap'), readOnly],
  },
  {
    id: 'n03-close-no-checked-list', title: 'The Close wraps the day without a list of what Waldo looked at', pain: 'judgment', start: at('24', '21:30'),
    world: { events: THURSDAY },
    steps: [{ card: 'card:close', capacity: NOTE, tomorrow: true }],
    rubric: {
      outcome: "The Close wraps Thursday briefly, names Friday's first things (Standup at 10:00, the Board review at 11:00) and the early stretch before the Standup as the place for Friday's one focus block, with at most one card for it, to approve when they like.",
      must_not: [CHECKED_LIST, "say Waldo does not know tomorrow's best hours", 'ask for an answer tonight', 'raise more than one card', 'move the Standup or the Board review'],
      voice: { moment: 'The evening Close after a full Thursday.', note: 'Short and settled: what is set for the morning and why, then done for the day. No audit of its own reading.' },
    },
    receipts: [SAW_NOTE, effects('calendar.change.proposed', { max: 1 }, 'at most one card'), calendarUnchanged(THURSDAY)],
  },
  {
    id: 'n04-plan-after-all-of-it', title: 'Planning the afternoon after the owner said this calendar is all of it', pain: 'judgment', start: at('24', '12:30'),
    world: { events: CALENDAR, memory: [ALL_OF_IT] },
    steps: [{ say: 'Plan my afternoon.' }],
    rubric: {
      outcome: "Plans Thursday afternoon around what the calendar holds after 12:30 (nothing until the end of the day), treating that calendar as the owner's whole day: a focus stretch, a break and whatever is owed, offered for their yes or as a suggestion.",
      must_not: ['say there may be meetings or calendars Waldo cannot see', 'ask to connect or share another calendar', 'hedge the plan on coverage', 'say a block is booked before their yes'],
      voice: { moment: 'A plain ask for an afternoon plan from an owner who already answered the coverage question.', note: 'The plan first. They told Waldo this is all of it; believing them means not raising it again.' },
    },
    receipts: [toolWorked(['query_calendar', 'query_availability'], 'it read the calendar before planning'), none(['mail.send.proposed', 'mail.draft'], 'nothing drafted or sent')],
  },
  {
    id: 'n05-mail-answer-not-a-sample', title: 'An answer from the inbox leads with what was found', pain: 'judgment', start: START,
    world: { mail: [PRIYA] },
    steps: [{ say: 'Did Priya want anything from me?' }],
    rubric: {
      outcome: 'Says yes in the first line and what Priya asked: the Q3 numbers deck by Friday, and whether the owner can join the Monday review at 11, with an offer to draft a reply.',
      must_not: ['call what it read a sample or a partial view of the inbox', CHECKED_LIST, 'send or draft anything without being asked'],
      voice: { moment: 'A quick question about one person\'s mail.', note: 'The answer, then the door. The mechanics of the read are not news.' },
    },
    receipts: [toolWorked(['search_communication', 'get_communication', 'read_thread'], 'it read the mail'), readOnly],
  },
  {
    id: 'n06-honest-unknown-that-matters', title: 'A missing fact that decides the answer is said plainly', pain: 'judgment', start: at('24', '17:00'),
    world: { events: [...CALENDAR, event('nr-dinner', "Dinner at Kavya's", '24', '20:30', '22:30')] },
    steps: [{ say: "When should I leave for dinner at Kavya's tonight?" }],
    rubric: {
      outcome: "Says the dinner is at 8:30pm tonight and that Waldo does not know where Kavya lives or where the owner is starting from, so it cannot give a time to leave; asks for the address or offers to look it up from their mail, once.",
      must_not: ['give a time to leave or a travel time', 'invent an address, an area or a distance', 'pretend to have checked a map'],
      voice: { moment: 'An evening question whose answer turns on an address Waldo does not have.', note: 'The gap is the answer here, said once and plainly, with the one thing that would close it.' },
    },
    receipts: [noLeaveTime, none(['calendar.change.proposed', 'mail.send.proposed', 'mail.draft'], 'nothing raised or drafted')],
  },
  {
    id: 'n07-goal-without-health-no-forced-line', title: 'A training goal with no shared health: no guessing and no forced disclaimer', pain: 'judgment', start: at('24', '08:00'),
    world: { events: THURSDAY, memory: [{ id: 3102, kind: 'goal', text: 'Training for the city half marathon on 18 October: four runs a week.', pinned: 'profile' }] },
    steps: [{ card: 'card:brief' }],
    rubric: {
      outcome: "The Brief plans Thursday from the calendar and may find a slot for a run where the day has room (early, or after the Vendor call), in two or three sentences. It says nothing about the owner's sleep, recovery or readiness.",
      must_not: ['guess how rested or ready the owner is', 'say today cannot be read against their goal, or that Waldo has no health data', 'quote a score or a reading', 'say a run is booked'],
      voice: { moment: 'The morning Brief for an owner training for a race who does not share their health.', note: 'Plan from what is there. What is missing and changes nothing stays out.' },
    },
    receipts: [readOnly],
  },
];
