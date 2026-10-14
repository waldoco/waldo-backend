import type { ToolName } from '@waldo/contracts';
import { CHILD_READ_TOOLS } from '../conversation/subagent';
import { SKIP_UPDATE } from '../prompt/update-cards';
import type { Loop } from './loops';

// A due check-back is a fresh machine turn: it reads the current state and decides what to say, or says nothing. It holds
// read tools only, so a check-back can look but never act; a loop check-back may also close the loops it was given.
export const CHECK_BACK_TOOLS: readonly ToolName[] = CHILD_READ_TOOLS;
export const LOOP_CHECK_BACK_TOOLS: readonly ToolName[] = [...CHILD_READ_TOOLS, 'close_loop'];

const LOOK = 'Look at the current state with your read tools before you write anything (mail, drafts, calendar, memory, earlier conversation, whatever this is about). Say what you checked and what you found, and ask at most one question.';
const SILENT = `If what you found means the owner gains nothing from hearing from you now, reply with exactly ${SKIP_UPDATE}.`;

// The note is the owner's own words from when they set it; it says what to look at, it is not the message.
export const reminderCheckBackText = (note: string): string => [
  `[Reminder due now, set earlier by the owner: "${note}"]`,
  `${LOOK} If it is a plain reminder, remind them in your own words, with anything current that helps. Do not repeat the note word for word, and do not add a sentence explaining that they asked for it.`,
  SILENT,
].join('\n\n');

export const loopCheckBackText = (loops: readonly Loop[]): string => [
  '[Check-back due now. Earlier you took these on for the owner and they are now due:]',
  loops.map(loop => `- ${loop.title}${loop.due ? ` (due ${loop.due.replace('T', ' ')})` : ''} [${loop.id}]`).join('\n'),
  `${LOOK} Close a loop with close_loop once it is done or no longer wanted; leave it open if it still needs the owner. Do not resend the list.`,
  SILENT,
].join('\n\n');

// null is the model's decision to stay silent. A blank reply is no decision, so the attempt fails and the scheduler owns the retry.
export const checkBackReply = (raw: string): string | null => {
  const text = raw.trim();
  if (text === SKIP_UPDATE) return null;
  if (!text) throw new Error('check-back turn returned no reply');
  return text;
};
