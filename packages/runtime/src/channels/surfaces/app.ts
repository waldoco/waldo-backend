import { REPLY_TEXT_MAX_CHARS, replyApprovalPartV1Schema } from '@waldo/contracts';
import type { z } from 'zod';

export type AppApprovalPart = z.infer<typeof replyApprovalPartV1Schema>;
export const APP_REVIEW_MAX_CHARS = REPLY_TEXT_MAX_CHARS;

// The app's form of an approval card, checked against the pinned contract. A card that does not
// parse is never presented, so it can never open a row.
export const appApprovalPart = (part: AppApprovalPart): AppApprovalPart => replyApprovalPartV1Schema.parse(part);
export const appApprovalLink = (approvalId: string): string => `waldo://approvals/${approvalId}`;

// Replies reach the app through the transcript, so a plain send is accepted here and delivered nowhere
// else. A callback keyboard is a decision affordance the app cannot render from this path; it is
// never acknowledged as shown.
export const appCaller = () => async (method: string, body: unknown): Promise<unknown> => {
  if (method !== 'sendMessage') return undefined;
  const rows = (body as { reply_markup?: { inline_keyboard?: readonly (readonly { callback_data?: unknown }[])[] } }).reply_markup?.inline_keyboard ?? [];
  if (rows.some(row => row.some(button => button.callback_data !== undefined))) return undefined;
  return { message_id: 1, chat: { id: (body as { chat_id?: number }).chat_id ?? 0 } };
};
