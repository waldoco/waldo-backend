import type { ToolName } from '@waldo/contracts';
import { HEALTH_READ_TOOLS } from '../tools/loaded';
import { parseUpdateEffects } from './update-sweep';

// BRIEF_BODY_REVISION: today's first scored Recovery landed after the Daily Brief reached the owner, so the Brief was written
// without the owner's body data. A row with no Recovery (steps and the calendar only) is not that data. One turn reads the
// data against what the Brief said and decides whether the Brief should now read differently; code holds only when that turn
// runs (once a day, first Recovery only, the Brief already sent) and how it lands.
export const BRIEF_BODY_KEY = 'brief_body_revision_v1';

// What one recompute did about the Brief, as a closed code for the log.
export type BriefBodyCode = 'row_before' | 'row_unread' | 'no_model_health' | 'unscored' | 'quiet' | 'not_reaching_out' | 'left' | 'invalid' | 'revised' | 'failed';

// The turn reads the owner's health the way their other turns do, and get_health too, which holds the readings the day's
// scores do not use. Reads only: the turn changes nothing but the Brief it returns.
export const BRIEF_BODY_TOOLS: readonly ToolName[] = [...new Set([...HEALTH_READ_TOOLS, 'get_health'])] as ToolName[];

// A stored pillar holds a score only when it names a zone; an unavailable one holds a reason alone.
export const recoveryScored = (pillar: unknown): boolean =>
  pillar !== null && typeof pillar === 'object' && typeof (pillar as { zone?: unknown }).zone === 'string';

export const briefBodyPrompt = (localNow: string, cards: string, revisesCards: boolean): string => [
  `[It is ${localNow}. The owner's body data for today has just reached Waldo, after their Daily Brief went out, so the Brief was written without it.]`,
  cards,
  'Read today\'s health (the health block, or your health tools) against what the Brief told the owner. If it changes what the Brief should say about the day (its pace, where the hard work goes, what to protect), write the whole Brief as it should now read, with the change in its place, not under a heading such as "Updated". If it changes nothing worth their attention, leave the Brief as it is.',
  ...(revisesCards ? [] : ['The owner reads Waldo where a card cannot be edited: a revision goes out as a new message, so write it as a short note of what changed in the Brief.']),
  'Reply with one JSON object and nothing else: {"revise": {"card": "card:brief", "text": "..."}}, or {} to leave it.',
].join('\n\n');

// The revised Brief's text; 'left' when the turn chose to leave it; 'invalid' for any other answer, another card included.
export const briefBodyRevision = (reply: string): Readonly<{ text: string }> | 'left' | 'invalid' => {
  const chosen = parseUpdateEffects(reply);
  if (chosen === 'invalid' || chosen.say !== undefined || chosen.push !== undefined) return 'invalid';
  if (!chosen.revise) return 'left';
  return chosen.revise.card === 'card:brief' ? { text: chosen.revise.text } : 'invalid';
};

// Before a recompute: whether today already held a scored Recovery, read only while the Brief has reached the owner today and
// was not yet looked at again for body data. null: nothing to decide; 'unread': the read failed.
export const briefBodyBefore = async (deps: Readonly<{ day: string; reached: boolean; doneOn: string | undefined; todayScored(): Promise<boolean> }>): Promise<boolean | 'unread' | null> => {
  if (!deps.reached || deps.doneOn === deps.day) return null;
  try { return await deps.todayScored(); } catch { return 'unread'; }
};

// After it: 'go' when this run scored today's first Recovery and the turn can read it under the owner's model-use consent; else
// why not ('unscored': today's row has no Recovery yet, so the day is not spent), or null when there was nothing to decide.
export const briefBodyAfter = async (before: boolean | 'unread' | null, outcome: string, modelToday: () => Promise<Readonly<{ day: string; scored: boolean }> | null>, day: string): Promise<'go' | BriefBodyCode | null> => {
  if (before === null || outcome !== 'written') return null;
  if (before === 'unread') return 'row_unread';
  if (before) return 'row_before';
  const read = await modelToday().catch(() => null);
  return read === null || read.day !== day ? 'no_model_health' : read.scored ? 'go' : 'unscored';
};
