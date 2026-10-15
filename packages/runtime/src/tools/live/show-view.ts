import {
  fitView, showViewArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, viewFallbackText,
  type ShowViewArgs, type ShowViewResult, type ToolHandler, type ViewV1,
} from '@waldo/contracts';
import type { LoopEventLike } from '../../hooks/claim-hook';
import type { ToolDispatcherContext } from '../dispatcher';

// The call is the record: the turn's views are read back from its successful show_view calls, as receipts are, so the
// handler keeps no state and a view the dispatcher refused never shows.
export const showViewHandler = (): ToolHandler<ShowViewArgs, ShowViewResult, ToolDispatcherContext> => ({
  name: 'show_view',
  description: "Show structured content beside your reply: drawn as a card in the Waldo app and console, sent as plain text on Telegram, iMessage and WhatsApp. Use it when the answer is easier to scan than to read: options to compare (hotels, flights, products, places), a table, steps in order, or a timeline for a day or a trip. Kinds: options (items with title, subtitle, facts as label/value pairs, note, an https link, and pick:true on the one you recommend), table (columns, and rows with one cell per column), steps (title, detail, state done/current/todo), timeline (when, title, detail). Put the content in the view and not in your reply too: the reply carries the lead-in and your judgment. Views follow the reply text in the order you call this. Nothing is refused for its size: left_out says how many entries did not fit, so say so when it matters. Show only what this turn's tools or the owner told you; a link must be one you read, never one you made up.",
  schema: showViewArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('show_view')),
  autonomy_gated: false,
  async handle(args) {
    return { ok: true, data: { shown: true, left_out: fitView(args.view).left_out }, source_taint: null };
  },
});

// The views a turn showed, fitted, in call order.
export const turnViews = (events: readonly LoopEventLike[]): readonly ViewV1[] => events.flatMap(event => {
  if (!event.ok || event.call.name !== 'show_view') return [];
  const args = showViewArgsSchema.safeParse(event.call.args);
  return args.success ? [fitView(args.data.view).view] : [];
});

// The stored reply: the model's words, then each view as text, so every surface that reads only text still shows them.
export const replyWithViews = (reply: string, views: readonly ViewV1[]): string =>
  [reply, ...views.map(viewFallbackText)].filter(text => text.trim()).join('\n\n');
