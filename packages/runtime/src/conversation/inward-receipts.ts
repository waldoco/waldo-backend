import type { ToolName } from '@waldo/contracts';
import { SKIP_UPDATE } from '../prompt/skip-update';

// A write the taint gate lets run without a card after outside text (tools/records owner_inward and narrows, and a figure the
// owner stated) is listed under the reply in these fixed words, whatever the model wrote, so the owner sees what outside
// content led Waldo to change. Each line is built from the call's own arguments and result, and names a way back only where
// one exists.
export const INWARD_RECEIPTS_HEADER = 'Changed after reading outside content in this conversation:';

type Fields = Readonly<Record<string, unknown>>;
const text = (fields: Fields, key: string): string => {
  const value = fields[key];
  if (typeof value !== 'string') return '';
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
};

export const INWARD_RECEIPT_LINES: Readonly<Partial<Record<ToolName, (args: Fields, result: Fields) => string | null>>> = {
  set_reminder: (args) => `Reminder set for ${text(args, 'at').replace('T', ' ')}: "${text(args, 'note')}" (you can cancel it)`,
  update_todo: (args) => `Marked step ${text(args, 'item_id')} as ${text(args, 'status')} (you can mark it back)`,
  track_responsibility: (args) => `Now tracking "${text(args, 'title')}" (you can close it)`,
  workspace_write: (args) => `Wrote ${text(args, 'path')} in your workspace (its earlier versions are kept)`,
  create_artifact: (args) => `Created "${text(args, 'name')}" in your artifacts`,
  // The note is gone once cancelled, so the line carries it: the owner can set it again from here.
  cancel_reminder: (args, result) => args.all === true ? 'Cancelled all your reminders'
    : result.cancelled !== true ? null
    : `Cancelled the reminder${text(result, 'at') ? ` for ${text(result, 'at').replace('T', ' ')}` : ''}: "${text(result, 'note')}"`,
  cancel_task: (args) => `Stopped background task ${text(args, 'job_id')} (you can start it again)`,
  steer_task: (args) => `Changed background task ${text(args, 'job_id')}: "${text(args, 'instruction')}" (you can change it again or cancel it)`,
  cancel_standing_order: (args) => `Ended standing order ${text(args, 'id')}`,
  revoke_standing_grant: (args) => `Ended your standing permission for ${text(args, 'class')}`,
  pause_autonomy: () => 'Paused Waldo acting on its own (you can resume it in the app)',
  set_sleep_need: (args) => typeof args.minutes === 'number'
    ? `Set your sleep need to ${Math.floor(args.minutes / 60)} h${args.minutes % 60 ? ` ${args.minutes % 60} min` : ''} (you can change it)` : null,
};

const fields = (json: string | undefined): Fields => {
  if (json === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed as Fields : {};
  } catch { return {}; }
};

export const inwardReceipt = (tool: string, argumentsJson: string, data?: unknown): string | null => {
  const line = INWARD_RECEIPT_LINES[tool as ToolName];
  if (line === undefined) return null;
  return line(fields(argumentsJson), typeof data === 'object' && data !== null ? data as Fields : {});
};

// A turn that would have stayed silent still tells the owner what it changed: the receipts become the whole reply.
export const withInwardReceipts = (reply: string, receipts: readonly string[]): string => {
  if (receipts.length === 0) return reply;
  const listed = `${INWARD_RECEIPTS_HEADER}\n${receipts.map((line) => `- ${line}`).join('\n')}`;
  return reply.trim() === SKIP_UPDATE ? listed : `${reply}\n\n${listed}`;
};
