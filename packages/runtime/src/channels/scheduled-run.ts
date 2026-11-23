import { conversationModelMessages, type ConversationEntry, type ConversationModelMessage, type ConversationTree, type ToolName } from '@waldo/contracts';
import { LOOP_CHECK_BACK_TOOLS, OUTSIDE_TEXT_JOB_TOOLS } from './check-back';
import { toolsWhere } from '../tools/records';
import { windowModelMessages } from '../conversation/window';
import type { FinalRecord } from './telegram-final-outbox';

// A Waldo-first scheduled run (a day card, a loop check-back, an update sweep, an intervention) offers this one menu whatever
// its kind, so the tools and the system text built from them are the same bytes for every scheduled run of an owner and the
// provider reads them from its cache. It is the union of what those kinds hold: reads that send nothing out, and tools that
// raise a card. Each run may still call only its own list (the dispatcher refuses the rest), so seeing the menu grants nothing.
// Tools only the owner's own turn holds are never offered to a machine turn, so they are not part of it.
const OWNER_TURN_ONLY = toolsWhere((record) => record.ownerTurnOnly);
// Every run Waldo starts is offered these in its function list when it holds them, not one find_tools hop away: the owner's
// past conversation, which its lean view leaves out, and closing a loop whose time has passed.
export const LOOK_BACK_DIRECT: readonly ToolName[] = ['search_episodes', 'close_loop'];
export const SCHEDULED_DIRECT: readonly ToolName[] = ['offer_replies', 'propose_action', 'propose_calendar_change', 'propose_calendar_plan', ...LOOK_BACK_DIRECT];
// The update sweep's and triage's tools beyond the outside-text reads (update-sweep.ts; a test holds the two in step).
const SWEEP_TOOLS: readonly ToolName[] = ['get_context', 'read_memory', 'search_episodes', 'open_loop', 'send_email', 'propose_calendar_change', 'propose_action'];
export const SCHEDULED_MENU: readonly ToolName[] = [...new Set<ToolName>([...LOOP_CHECK_BACK_TOOLS, ...OUTSIDE_TEXT_JOB_TOOLS, ...SWEEP_TOOLS, ...SCHEDULED_DIRECT])]
  .filter((name) => !OWNER_TURN_ONLY.has(name)).sort();

// A run is lean only when what it could be offered sits inside the menu; one that holds more keeps the full chat view.
export const fitsScheduledMenu = (tools: readonly string[] | undefined): tools is readonly ToolName[] =>
  tools !== undefined && tools.every((name) => OWNER_TURN_ONLY.has(name as ToolName) || (SCHEDULED_MENU as readonly string[]).includes(name));

// What a run Waldo started is told about the rest of the owner's history, which it reads with its own tools when the work
// needs it: whether to look, and for what, is the model's call.
export const LOOK_BACK = 'Only the newest of your conversation with the owner is shown here. Everything they said before, on every surface (the app, WhatsApp, email, iMessage), is in search_episodes, and what you know about them is in read_memory. When this work touches something the owner may have talked about before (a project, a person, a plan, a promise), search for it before you write, and use what you find.';

const shown = (entry: ConversationEntry) => entry.role !== 'compaction' && entry.modelProjection.mode !== 'omit';
// Rows written before roles were stored name their reply by id.
const roleOf = (entry: ConversationEntry) => entry.role ?? (entry.id.endsWith('-reply') ? 'assistant' : 'user');

// What a scheduled run reads of the conversation instead of the chat replay, chosen by where each row came from, never by
// matching a reply's text: a scheduled run's own answer (a card, a sweep's or an intervention's decision) is the model's raw
// output, not what the owner received, so it is never read here whatever its shape.
// - The owner's exchange: the owner's messages, each with the answer to it.
// - What Waldo sent: the messages the owner object's outbox delivered to the owner in the last day (host-supplied).
// Both are held to the history budget a chat turn's conversation is held to, so a run Waldo starts sees as much of the owner's
// conversation as their own turn does. The day's sends are read first, so a long chat never pushes out what Waldo already said
// today; the exchange takes the rest of the budget, newest first. Rows are read whole, as chat reads them.
const recentExchange = (tree: ConversationTree, currentId: string, budgetTokens: number): Readonly<{ messages: readonly ConversationModelMessage[]; readOutside: boolean }> => {
  if (budgetTokens <= 0) return { messages: [], readOutside: false };
  const before = tree.path(currentId).slice(0, -1).filter(shown);
  const asked = new Set(before.filter((entry) => roleOf(entry) === 'user' && entry.inputOrigin === 'owner').map((entry) => entry.id));
  const kept = before.filter((entry) => asked.has(entry.id) || (roleOf(entry) === 'assistant' && entry.parentId !== null && asked.has(entry.parentId)));
  const messages = windowModelMessages(conversationModelMessages(kept), budgetTokens).messages;
  // Only the rows the window kept can carry what Waldo read elsewhere into this run.
  const shownRows = kept.slice(kept.length - messages.length);
  return { messages, readOutside: shownRows.some((entry) => entry.readOutside === true) };
};

export type SentMessage = Readonly<{ at: number; text: string }>;
export type LeanWindow = Readonly<{ exchange: ReturnType<typeof recentExchange>; sent: readonly SentMessage[] }>;
export const leanWindow = (tree: ConversationTree, currentId: string, sent: readonly SentMessage[], budgetTokens: number): LeanWindow => {
  const sentWindow = sent.length ? windowModelMessages(sent.map((message) => ({ role: 'assistant' as const, content: message.text })), budgetTokens) : null;
  const keptSent = sentWindow ? sent.slice(sent.length - sentWindow.messages.length) : [];
  return { sent: keptSent, exchange: recentExchange(tree, currentId, budgetTokens - (sentWindow?.stats.estimated_tokens ?? 0)) };
};

export const recentExchangeText = (messages: readonly ConversationModelMessage[]): string =>
  messages.map((message) => `${message.role === 'assistant' ? 'Waldo' : 'Owner'}: ${message.content}`).join('\n');

export const sentText = (sent: readonly Readonly<{ at: string; text: string }>[]): string =>
  sent.map((message) => `[${message.at}] ${message.text}`).join('\n');

// What the outbox delivered to the owner in the last day, oldest first: a surface's confirmation (delivered), or its acceptance
// where it confirms arrival later (WhatsApp), and a send whose arrival is unknown (a part went out but no confirmation came): the
// owner may have read it, so it counts as said, marked as unconfirmed. A record a forget reached is not read.
const SENT_WITHIN_MS = 24 * 3_600_000;
export const UNCONFIRMED_MARK = '(delivery not confirmed) ';
export const deliveredLately = (records: readonly FinalRecord[], now: number): readonly SentMessage[] =>
  records.filter((record) => (record.status === 'delivered' || record.status === 'accepted' || record.status === 'quarantined')
    && !record.forgotten && record.payload.text.trim() !== '' && now - (record.deliveredAt ?? record.createdAt) < SENT_WITHIN_MS)
    .map((record) => ({ at: record.deliveredAt ?? record.createdAt, text: `${record.status === 'quarantined' ? UNCONFIRMED_MARK : ''}${record.payload.text}` }))
    .sort((a, b) => a.at - b.at);
