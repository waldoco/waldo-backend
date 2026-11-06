import type { ToolName } from '@waldo/contracts';

// A write the taint gate lets run without a card in the owner's own turn after outside text (tools/records owner_inward) is
// listed under the reply in these fixed words, whatever the model wrote: the owner sees what outside content led Waldo to
// change and can undo it. Each line is built from the call's own arguments.
export const INWARD_RECEIPTS_HEADER = 'Changed after reading outside content in this conversation; tell me to undo any of these:';

type Args = Readonly<Record<string, unknown>>;
const text = (args: Args, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string') return '';
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
};

export const INWARD_RECEIPT_LINES: Readonly<Partial<Record<ToolName, (args: Args) => string>>> = {
  set_reminder: (args) => `Reminder at ${text(args, 'at').replace('T', ' ')}: "${text(args, 'note')}"`,
  update_todo: (args) => `Marked step ${text(args, 'item_id')} as ${text(args, 'status')}`,
  track_responsibility: (args) => `Now tracking "${text(args, 'title')}"`,
  workspace_write: (args) => `Wrote ${text(args, 'path')} in your workspace`,
};

export const inwardReceipt = (tool: string, argumentsJson: string): string | null => {
  const line = INWARD_RECEIPT_LINES[tool as ToolName];
  if (line === undefined) return null;
  let args: unknown;
  try { args = JSON.parse(argumentsJson); } catch { args = {}; }
  return line(typeof args === 'object' && args !== null ? args as Args : {});
};

export const withInwardReceipts = (reply: string, receipts: readonly string[]): string =>
  receipts.length === 0 ? reply : `${reply}\n\n${INWARD_RECEIPTS_HEADER}\n${receipts.map((line) => `- ${line}`).join('\n')}`;
