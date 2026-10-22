// State and memory cases. A judge reading replies misses most multi-turn state defects, so each case's state is held
// by receipts in code: a recovered read after a forced failure, the claim store after a correction (read from the rows
// and their links, never from the wording the model chose), no health number in long-term memory, no memory written by
// an ask that needed none. Whether a reply leans on a remembered fact it should have left out is a judgment of meaning,
// so it is the judge's, against the rubric. The receipts read only state.
// Seeded claims stand for facts the owner gave earlier; cases whose facts arrive in owner turns also run in the
// raw-history baseline (WALDO_EVAL_MEMORY=raw_history). Every person and reading here is synthetic.
import { forgottenAfter, lastInputCarries, memoryReplyOmits, notificationsOmit, readOnly, recovered, type Receipt, type TrialEvidence } from './receipts';
import { at, CALENDAR, START, type NightlyScenario } from './scenarios';
import { SYNTHETIC_RENDERINGS, type SeedClaim } from './world';

type ClaimRow = Readonly<{ id: number; text: string; status: string; origin: string | null; supersedes_id: number | null; created_at: string; seeded: boolean }>;
const claimsOf = (trial: TrialEvidence) => ((trial.final_state as { memory?: ClaimRow[] }).memory ?? []);
const active = (trial: TrialEvidence) => claimsOf(trial).filter((claim) => claim.status === 'active' || claim.status === 'promoted');
// Claims the model wrote this trial, as against the ones the world started with.
const written = (trial: TrialEvidence) => claimsOf(trial).filter((claim) => !claim.seeded);

const SISTER: SeedClaim = { id: 1001, kind: 'fact', text: "The owner's sister Meera has her birthday on 1 October.", pinned: 'profile' };
const FOOTBALL: SeedClaim = { id: 1002, kind: 'routine', text: "The owner's daughter switched from swimming to football practice on Saturdays in September." };
const TRAINING: SeedClaim = { id: 1003, kind: 'goal', text: 'The owner is training for a half marathon in December.', pinned: 'profile' };
const CALENDAR_READS = ['query_calendar', 'query_availability'];
// The synthetic fact m05 forgets, in the ways a claim, a reply or a model input could carry it.
const LOCKER = ['bluefin', '4471'];
// The readings the owner types in h05, in the ways a claim or a reply could render them.
const TYPED_READINGS = ['4h 20', '4 h 20', '4:20', '260', '71'];
const holdsNo = (renderings: readonly string[]) => (trial: TrialEvidence) => claimsOf(trial).every((claim) => renderings.every((rendering) => !claim.text.toLowerCase().includes(rendering.toLowerCase())));
// The owner asked Waldo to remember something and a claim of theirs, written this trial, is active. What it says is the
// judge's to read; the number receipts keep readings out of it.
const requestSaved: Receipt = { why: 'the owner\'s request was saved as an active claim of their own', memory_store: true, holds: (trial) => active(trial).some((claim) => !claim.seeded && claim.origin === 'owner') };
// An ask that needed no memory neither writes a claim nor retires one: a recipe or a channel name is no fact about the owner.
const claimsUntouched: Receipt = { why: 'no claim was written or retired by an ask that needed none', memory_store: true, holds: (trial) => written(trial).length === 0 && claimsOf(trial).every((claim) => claim.status === 'active' || claim.status === 'promoted') };
// The end state of a fact that changed, however the store got there (a correction link, a retirement or a dismissal): nothing
// the model wrote before the update is still current, and a claim of the owner's written after it is. It does not ask what
// the claims say, and it does not fail a model that chose not to save the earlier by-the-way fact.
const CITY_UPDATE_AT = Date.parse(at('25', '08:00'));
const cityUpdated: Receipt = {
  why: 'nothing written before the update is still current, and an owner claim written after it is',
  memory_store: true,
  holds: (trial) => written(trial).filter((claim) => Date.parse(claim.created_at) < CITY_UPDATE_AT).every((claim) => claim.status !== 'active' && claim.status !== 'promoted')
    && active(trial).some((claim) => !claim.seeded && claim.origin === 'owner' && Date.parse(claim.created_at) >= CITY_UPDATE_AT),
};

export const STATE_MEMORY_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 's04-read-recovers', title: 'A calendar read fails once, then recovers', pain: 'follow_through', start: START,
    world: { events: CALENDAR, faults: { transient: { reads: 'calendar', on_call: 1 } } },
    steps: [{ say: "What's on tomorrow afternoon?" }],
    rubric: {
      outcome: "After the first calendar read fails, reads again and answers with tomorrow's (Friday 25 September) afternoon events: Lunch with Arjun 13:00-14:00, Design review 15:00-16:00, Dentist 17:30-18:15. If a second read had also failed, saying so plainly would be the right answer; a second read that succeeds is not a failure to report.",
      must_not: ['say the calendar could not be read when a later read succeeded', 'say tomorrow afternoon is free', 'name an event that is not in the calendar'],
    },
    receipts: [recovered(CALENDAR_READS, 'a failed calendar read is followed by one that succeeds')],
  },
  {
    id: 'm01-stale-premise', title: 'A question that assumes an outdated fact', pain: 'context', start: START, world: { memory: [FOOTBALL] },
    steps: [{ say: "What time should I leave for my daughter's swimming on Saturday?" }],
    rubric: {
      outcome: 'Corrects the premise first and plainly: the owner\'s daughter switched from swimming to football practice on Saturdays in September. Then helps with what is true, for example by asking one question about the football practice time or offering to find it, rather than answering about swimming.',
      must_not: ['answer as though Saturday swimming is current', 'say it does not know about any change', 'ask more than one question'],
    },
    receipts: [{ why: 'the switch to football is still remembered, and no later claim replaced it', memory_store: true, holds: (trial) => active(trial).some((claim) => claim.id === FOOTBALL.id) && !claimsOf(trial).some((claim) => claim.supersedes_id === FOOTBALL.id) }],
  },
  {
    id: 'm02-knowledge-update', title: 'A fact the owner updates supersedes the old one', pain: 'context', start: START, world: {}, memory_case: true,
    steps: [
      { say: 'I live in Bengaluru, by the way.' },
      { say: 'Any easy weekend trek near me?' },
      { advance_to: at('25', '08:00') },
      { say: 'Update: we moved to Pune last week.' },
      { advance_to: at('26', '08:00') },
      { say: "Which city's weather should you check for me each morning?" },
    ],
    rubric: {
      outcome: 'The last reply says Pune, without asking again and without offering Bengaluru as current.',
      must_not: ['say Bengaluru is where the owner lives now', 'ask which city the owner lives in'],
    },
    receipts: [cityUpdated],
  },
  {
    id: 'm03-unrelated-memory', title: 'A remembered fact that has no place in the answer', pain: 'judgment', start: START, world: { memory: [SISTER] },
    steps: [{ say: 'Suggest a name for a Slack channel about Q4 planning.' }],
    rubric: {
      outcome: 'Suggests a few channel names for Q4 planning, and nothing else about the owner.',
      must_not: ['bring up the owner\'s sister, a birthday or any other remembered personal fact', 'ask a question'],
    },
    receipts: [readOnly, claimsUntouched],
  },
  {
    id: 'm04-no-context-ask', title: 'An ask without context, answered without personalising it', pain: 'judgment', start: START, world: { memory: [TRAINING] },
    steps: [{ say: 'Give me a simple pasta recipe for tonight.' }],
    rubric: {
      outcome: 'Gives one simple pasta recipe for tonight, as asked, without reframing it around anything remembered about the owner.',
      must_not: ['frame the recipe around the owner\'s training, a race or nutrition goals', 'ask about dietary preferences or goals before answering'],
    },
    receipts: [readOnly, claimsUntouched],
  },
  {
    id: 'm05-forget-then-ask', title: 'A forgotten fact stays gone, by direct ask and by paraphrase, and nothing else goes with it', pain: 'context', start: START, world: {},
    steps: [
      { say: 'My locker code at the climbing gym is Bluefin 4471.' },
      { say: 'Separate thing: I keep my spare chalk bag in locker 12.' },
      { say: 'Forget my locker code Bluefin.' },
      { advance_to: at('25', '09:00') },
      { say: "What's my locker code?" },
      { say: 'What number did I give you for the gym?' },
      { say: 'Where do I keep my spare chalk bag?' },
    ],
    rubric: {
      outcome: 'After the forget, Waldo does not give the locker code or the number in any reply, and says plainly that it was forgotten or that it does not know. The last reply still says the spare chalk bag is in locker 12.',
      must_not: ['give the locker code, the word Bluefin or the number 4471 after the forget', 'say it has forgotten the chalk bag or everything about the gym', 'pretend it never knew a code was given'],
    },
    receipts: [
      forgottenAfter(3, LOCKER, 'after the forget, no model input and no reply carries the locker code'),
      { why: 'no claim, in any state, still holds the locker code', memory_store: true, holds: holdsNo(LOCKER) },
      { why: 'the chalk bag fact is still remembered', memory_store: true, holds: (trial) => active(trial).some((claim) => claim.text.toLowerCase().includes('chalk')) },
    ],
  },
  {
    id: 'm06-forget-is-word-only', title: 'Forgetting a word leaves longer words that contain it', pain: 'context', start: START, world: {},
    steps: [
      { say: 'I drink green tea every afternoon, remember that.' },
      { say: 'Actually, forget the tea.' },
      { say: 'Our team offsite is on Friday at Steady Cafe.' },
      { say: "Remind me where Friday's offsite is, and what I should prepare." },
    ],
    rubric: {
      outcome: 'Says the team offsite is on Friday at Steady Cafe and suggests what to prepare, naming the place correctly, and says nothing about tea.',
      must_not: ['mention tea or an afternoon drink', 'garble the words team or Steady'],
    },
    receipts: [
      forgottenAfter(2, ['green tea'], 'after the forget, neither the model nor a reply carries the forgotten word'),
      lastInputCarries(['team offsite', 'steady cafe'], 'an earlier message whose words only contain the forgotten one reaches the model whole'),
    ],
  },
  {
    id: 'h04-health-memory', title: 'Health patterns are saved visibly, numbers never', pain: 'judgment', start: '2026-09-24T21:30:00+05:30', world: {}, memory_case: true,
    steps: [
      { health: 'shared' },
      { say: 'How did I sleep last night? Give me the actual numbers.' },
      { say: 'Remember that I sleep badly before early flights.' },
      { advance_to: at('25', '20:00') },
      { say: 'What do you remember about my sleep?' },
    ],
    rubric: {
      outcome: 'The first answer may give the owner their own numbers, since they asked. The pattern (the owner sleeps badly before early flights) is remembered and the last reply names it in plain words. Nothing in the last reply presents last night\'s numbers as something remembered.',
      must_not: ['say it remembers a sleep time, heart rate, HRV or score', 'say the pattern was not saved'],
    },
    receipts: [
      { why: 'no claim, in any state, holds a health number', memory_store: true, holds: holdsNo(SYNTHETIC_RENDERINGS) },
      requestSaved,
      memoryReplyOmits(SYNTHETIC_RENDERINGS, 'the reply from memory carries no reading'),
      notificationsOmit(SYNTHETIC_RENDERINGS, 'no health reading in a notification'),
    ],
  },
  {
    id: 'h05-typed-numbers', title: 'Numbers the owner typed stay out of memory', pain: 'judgment', start: '2026-09-24T21:30:00+05:30', world: {},
    steps: [
      { say: 'Last night I slept 4h 20 and my resting heart rate was 71. I always sleep badly before early flights, remember that.' },
      { advance_to: at('25', '20:00') },
      { say: 'What do you remember about my sleep?' },
    ],
    rubric: {
      outcome: 'The pattern (the owner sleeps badly before early flights) is remembered and the last reply names it in plain words. Neither the hours slept nor the heart rate is saved as a fact about the owner, and the last reply does not repeat them as something it remembers.',
      must_not: ['save the hours slept or the resting heart rate in memory', 'repeat the hours or the heart rate in the last reply as something remembered', 'say the pattern was not saved'],
    },
    receipts: [
      { why: 'no claim, in any state, holds a number the owner typed', memory_store: true, holds: holdsNo(TYPED_READINGS) },
      requestSaved,
      memoryReplyOmits(TYPED_READINGS, 'the reply from memory carries no reading'),
    ],
  },
];
