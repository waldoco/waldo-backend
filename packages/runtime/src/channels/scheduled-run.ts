import { conversationModelMessages, type ConversationEntry, type ConversationModelMessage, type ConversationTree, type ToolName } from '@waldo/contracts';
import { LOOP_CHECK_BACK_TOOLS, OUTSIDE_TEXT_JOB_TOOLS } from './check-back';
import { SKIP_CARD } from '../prompt/day-cards';
import { SKIP_UPDATE } from '../prompt/skip-update';
import { toolsWhere } from '../tools/records';

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
  tools !== undefined && tools.every((name) => OWNER_TURN_ONLY.has(name) || (SCHEDULED_MENU as readonly string[]).includes(name));

// The rows of the owner's own exchange with Waldo a scheduled run reads instead of the chat replay: what the owner said and
// what Waldo sent, newest last. Machine job prompts, summaries and runs that sent nothing are not part of that exchange.
export const RECENT_EXCHANGE_ROWS = 6;
// Enough of each row for its gist, so one long Brief does not fill the run.
export const RECENT_ROW_MAX_CHARS = 1_500;

const SENT_NOTHING = new Set([SKIP_CARD, SKIP_UPDATE]);

export const recentExchange = (tree: ConversationTree, currentId: string): Readonly<{ messages: readonly ConversationModelMessage[]; readOutside: boolean }> => {
  const before = tree.path(currentId).slice(0, -1);
  const rows = before.filter((entry: ConversationEntry) => entry.role !== 'compaction' && entry.modelProjection.mode !== 'omit'
    && ((entry.role ?? (entry.id.endsWith('-reply') ? 'assistant' : 'user')) === 'assistant' ? !SENT_NOTHING.has(entry.modelPayload.trim()) : entry.inputOrigin === 'owner'));
  const kept = rows.slice(-RECENT_EXCHANGE_ROWS);
  const messages = conversationModelMessages(kept).map((message) => message.content.length > RECENT_ROW_MAX_CHARS
    ? { ...message, content: `${message.content.slice(0, RECENT_ROW_MAX_CHARS)}…` } : message);
  return { messages, readOutside: kept.some((entry) => entry.readOutside === true) };
};

export const recentExchangeText = (messages: readonly ConversationModelMessage[]): string =>
  messages.map((message) => `${message.role === 'assistant' ? 'Waldo' : 'Owner'}: ${message.content}`).join('\n');
