import { conversationModelMessages, type ConversationEntry, type ConversationModelMessage, type ConversationTree, type ToolName } from '@waldo/contracts';
import { surfaceOfTrace } from './owner-turn-envelope';
import { LOOP_CHECK_BACK_TOOLS, OUTSIDE_TEXT_JOB_TOOLS } from './check-back';
import { toolsWhere } from '../tools/records';
import type { FinalRecord } from './telegram-final-outbox';

// A Waldo-first scheduled run (a day card, a loop check-back, an update sweep, an intervention) offers this one menu whatever
// its kind, so the tools and the system text built from them are the same bytes for every scheduled run of an owner and the
// provider reads them from its cache. It is the union of what those kinds hold: reads that send nothing out, and tools that
// raise a card. Each run may still call only its own list (the dispatcher refuses the rest), so seeing the menu grants nothing.
// Tools only the owner's own turn holds are never offered to a machine turn, so they are not part of it.
const OWNER_TURN_ONLY = toolsWhere((record) => record.ownerTurnOnly);
export const SCHEDULED_DIRECT: readonly ToolName[] = ['offer_replies', 'propose_action', 'propose_calendar_change', 'propose_calendar_plan'];
// The update sweep's and triage's tools beyond the outside-text reads (update-sweep.ts; a test holds the two in step).
const SWEEP_TOOLS: readonly ToolName[] = ['get_context', 'read_memory', 'search_episodes', 'open_loop', 'send_email', 'propose_calendar_change', 'propose_action'];
export const SCHEDULED_MENU: readonly ToolName[] = [...new Set<ToolName>([...LOOP_CHECK_BACK_TOOLS, ...OUTSIDE_TEXT_JOB_TOOLS, ...SWEEP_TOOLS, ...SCHEDULED_DIRECT])]
  .filter((name) => !OWNER_TURN_ONLY.has(name)).sort();

// A run is lean only when what it could be offered sits inside the menu; one that holds more keeps the full chat view.
export const fitsScheduledMenu = (tools: readonly string[] | undefined): tools is readonly ToolName[] =>
  tools !== undefined && tools.every((name) => OWNER_TURN_ONLY.has(name as ToolName) || (SCHEDULED_MENU as readonly string[]).includes(name));

// What a scheduled run reads of the conversation instead of the chat replay, chosen by where each row came from, never by
// matching a reply's text: a scheduled run's own answer (a card, a sweep's or an intervention's decision) is the model's raw
// output, not what the owner received, so it is never read here whatever its shape.
// - The owner's exchange: the owner's last messages, each with the answer to it.
// - What Waldo sent: the messages the owner object's outbox delivered to the owner (host-supplied).
// Counted apart, so neither crowds the other out.
export const RECENT_OWNER_MESSAGES = 3;
// The most of Waldo's sent messages a run reads: a day's worth (the day cards, the looks, the follow-ups), so a look can see
// what it already said hours ago behind the cards that went since.
export const RECENT_SENT_MESSAGES = 8;
// The newest are read whole; older ones of the day only by their opening, enough to know it was said.
export const WHOLE_SENT_MESSAGES = 3;
export const OLDER_SENT_MAX_CHARS = 300;
// Enough of each row for its gist, so one long Brief does not fill the run. Rows are cut as they are rendered, after the forget
// barrier has judged them whole, so a cut can never split a held topic past it.
export const RECENT_ROW_MAX_CHARS = 1_500;

const shown = (entry: ConversationEntry) => entry.role !== 'compaction' && entry.modelProjection.mode !== 'omit';
// Rows written before roles were stored name their reply by id.
const roleOf = (entry: ConversationEntry) => entry.role ?? (entry.id.endsWith('-reply') ? 'assistant' : 'user');

export const recentExchange = (tree: ConversationTree, currentId: string): Readonly<{ messages: readonly ConversationModelMessage[]; readOutside: boolean }> => {
  const before = tree.path(currentId).slice(0, -1).filter(shown);
  const asked = before.filter((entry) => roleOf(entry) === 'user' && entry.inputOrigin === 'owner').slice(-RECENT_OWNER_MESSAGES);
  const ids = new Set(asked.map((entry) => entry.id));
  const kept = before.filter((entry) => ids.has(entry.id) || (roleOf(entry) === 'assistant' && entry.parentId !== null && ids.has(entry.parentId)));
  return { messages: conversationModelMessages(kept), readOutside: kept.some((entry) => entry.readOutside === true) };
};

// Cut on a whole code point, so a cut never leaves half a surrogate pair.
const gist = (text: string, max = RECENT_ROW_MAX_CHARS): string => {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]!) ? max - 1 : max;
  return `${text.slice(0, end)}…`;
};

export const recentExchangeText = (messages: readonly ConversationModelMessage[]): string =>
  messages.map((message) => `${message.role === 'assistant' ? 'Waldo' : 'Owner'}: ${gist(message.content)}`).join('\n');

export const sentText = (sent: readonly Readonly<{ at: string; text: string; confirmed: boolean }>[]): string =>
  sent.map((message) => `[${message.at}]${message.confirmed ? '' : ' (sent, not yet confirmed delivered)'} ${gist(message.text)}`).join('\n');

// What Waldo sent the owner of its own accord in the last day, oldest first: a surface's confirmation (delivered), or its
// acceptance where it confirms arrival later (WhatsApp), which is marked not yet confirmed. A reply to the owner's own message
// is left out, since the recent exchange already shows it; a notice of Waldo's own stays, whatever turn queued it. A record a
// forget reached is not read.
// day (OWNER_CLOSES_MAIL_ITEMS): the whole day's sends, so a look does not say again what it said before the cards that went
// since, and also a send whose arrival is unknown (a part went out but no confirmation came): the owner may have read it, so it
// counts as said, not yet confirmed. Without it, the newest whole messages only, confirmed or accepted.
const SENT_WITHIN_MS = 24 * 3_600_000;
export const deliveredLately = (records: readonly FinalRecord[], now: number, day = false): readonly Readonly<{ at: number; text: string; confirmed: boolean }>[] => {
  const said = records.filter((record) => (record.status === 'delivered' || record.status === 'accepted' || (day && record.status === 'quarantined'))
    && !record.forgotten && record.payload.text.trim() !== '' && (record.notice === true || surfaceOfTrace(record.trace) === null)
    && now - (record.deliveredAt ?? record.createdAt) < SENT_WITHIN_MS)
    .map((record) => ({ at: record.deliveredAt ?? record.createdAt, text: record.payload.text, confirmed: record.status === 'delivered' }))
    .sort((a, b) => a.at - b.at);
  if (!day) return said.slice(-WHOLE_SENT_MESSAGES);
  const kept = said.slice(-RECENT_SENT_MESSAGES);
  return kept.map((message, index) => index < kept.length - WHOLE_SENT_MESSAGES ? { ...message, text: gist(message.text, OLDER_SENT_MAX_CHARS) } : message);
};
