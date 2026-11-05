import { fence } from '../memory/claims';
import { MEDICATION_MEMORY_RULE, SLEEP_NEED_MEMORY_RULE } from '../memory/health-rules';

// CAPACITY_PLAN: Waldo learns how much real work the owner can do in a day and keep doing, and when they think best, and keeps
// it as one plain note in memory. The note shapes their deep work and their weekly reset. The judgment is the model's: code
// hands it the note, their memory, their calendar's shape and their body's zone words, and keeps no rule of its own.
export const CAPACITY_INSTRUCTION = [
  "It is night. Keep Waldo's capacity note for the owner up to date. It says how much real, focused work they can do in a day and keep doing day after day, which hours of their day they think best in, and what drains them. Waldo plans their deep work and their weekly reset from it.",
  "Read what you have: the current note, their memory (what they said about their energy, focus, routines and goals), the shape of their calendar over the past days and tomorrow, and their body today when they share it.",
  "Keep what still holds in the current note and change what the days contradict. Say how sure each part is: one day is a guess, a pattern over many days is a finding. Name what is still unknown rather than filling it in.",
  "Health supports the rest of their life: the note is about the work they can sustain, never a list of protocols to add.",
  "Speak of their body only from the health context in this request, in its words. When it has none, write from their calendar and their own words and say nothing about their body.",
  "Never a number about the body: no heart rate, sleep hours, score or reading. Times of day and hours of work are fine. Never a meeting's title, a person's name or a place: the calendar reaches you as shape only.",
  "Write it as two to four plain sentences about the owner, the way a memory note reads. In evidence, say in one short line what it rests on (which days, what they said, the body's zone words), with no titles or numbers about the body.",
  "When the days showed nothing new, return note null and the note stays as it is.",
  SLEEP_NEED_MEMORY_RULE,
  MEDICATION_MEMORY_RULE,
  'Reply with JSON only.',
].join('\n');

export const CAPACITY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['note', 'evidence'],
  properties: { note: { type: ['string', 'null'] }, evidence: { type: 'string' } },
};

export const NO_SHARED_HEALTH = 'The owner shares no health with Waldo now: write from their calendar and their own words.';
export const BODY_WITHDRAWN = 'The current note was written while the owner shared their health, and they share none now: rewrite it from their calendar and their own words, leaving out everything it drew from their body. Do not return null.';
export const NO_CALENDAR = 'Their calendar is not connected.';
export const NO_NOTE = 'Waldo has no capacity note for the owner yet.';

// The pass's own message; the owner's memory and the forget barrier are added by the responder, as for every memory pass.
export const capacityInput = (input: Readonly<{ now: string; note: string | null; health: string | null; withdrawn: boolean; calendar: string }>): string => [
  `Now: ${input.now} in the owner's local time.`,
  input.note === null ? 'There is no capacity note yet.' : `The current capacity note:\n<capacity_note>\n${fence(input.note)}\n</capacity_note>`,
  ...(input.withdrawn ? [BODY_WITHDRAWN] : []),
  `Their body today:\n${input.health ?? NO_SHARED_HEALTH}`,
  `The shape of their calendar, one line per day in their local time, each marked lived, under way or ahead:\n<calendar_shape>\n${input.calendar}\n</calendar_shape>`,
].join('\n\n');

// What the day cards read with CAPACITY_PLAN on. The note and the blocks travel as the job's context, never in the card's
// own text, which the day_card trace keeps.
export const capacityContext = (note: string | null, blocks: string): string => [
  note === null ? NO_NOTE : `What Waldo has learned about the owner's capacity, from memory:\n<capacity_note>\n${fence(note)}\n</capacity_note>`,
  `Protected blocks Waldo proposed in the last two weeks, and what became of each:\n${blocks || '- none'}`,
].join('\n\n');

const DEEP_WORK = "This request may carry their capacity note: what Waldo has learned about how much real work they sustain in a day and the hours they think best in. Let it shape the day's deep work: when, and how much, sized to what the calendar and their body leave room for. When there is no note, read the day as it is and do not guess their capacity.";
const RESET = "Once a week they need a reset that restores them without costing them: rest they choose, not another protocol. When this week has none on their calendar and none waits on them, and the protected blocks listed show they have not turned one down lately, offer one at a time their patterns suit, never over a commitment, and say why for them. When this is not the morning to settle it, leave it.";

export const CAPACITY_LINES = {
  brief: [DEEP_WORK, RESET].join('\n'),
  planningBrief: [
    `${DEEP_WORK} When a free stretch fits and nothing holds it yet, propose the block with propose_calendar_change and block deep_work.`,
    `${RESET} Propose it with propose_calendar_change and block rest.`,
  ].join('\n'),
  close: "Include the shape of tomorrow's deep work in a sentence: when and how much, from their capacity note when this request carries one, tomorrow's calendar and their body today when shared, and why for them. It is a plan for the morning, nothing that needs an answer tonight.",
} as const;
