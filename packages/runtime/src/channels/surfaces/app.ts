import { REPLY_TEXT_MAX_CHARS, replyApprovalPartV1Schema } from '@waldo/contracts';
import type { z } from 'zod';

export type AppApprovalPart = z.infer<typeof replyApprovalPartV1Schema>;
export const APP_REVIEW_MAX_CHARS = REPLY_TEXT_MAX_CHARS;

// The app's form of an approval card, checked against the pinned contract. A card that does not
// parse is never presented, so it can never open a row.
export const appApprovalPart = (part: AppApprovalPart): AppApprovalPart => replyApprovalPartV1Schema.parse(part);
export const appApprovalLink = (approvalId: string): string => `waldo://approvals/${approvalId}`;

// A turn's reply reaches the app through the transcript its own turn writes, so a plain send during a
// turn is accepted and goes nowhere else. Scheduled work has no turn: while the alarm holds a delivery,
// the text is written to the transcript, and a failed write throws so the job fails instead of recording
// a message the owner never got. A callback keyboard is a decision affordance the app cannot render
// from this path; it is never acknowledged as shown, nor written as plain text.
export const appCaller = (scheduledDelivery: () => ((text: string) => Promise<void>) | null = () => null) => async (method: string, body: unknown): Promise<unknown> => {
  if (method !== 'sendMessage') return undefined;
  const { chat_id: chatId, text, reply_markup: markup } = body as { chat_id?: number; text?: string; reply_markup?: { inline_keyboard?: readonly (readonly { callback_data?: unknown }[])[] } };
  if ((markup?.inline_keyboard ?? []).some(row => row.some(button => button.callback_data !== undefined))) return undefined;
  const deliver = scheduledDelivery();
  if (deliver) await deliver(text ?? '');
  return { message_id: 1, chat: { id: chatId ?? 0 } };
};
