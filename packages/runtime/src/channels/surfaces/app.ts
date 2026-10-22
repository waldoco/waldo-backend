import { REPLY_TEXT_MAX_CHARS, replyApprovalPartV1Schema } from '@waldo/contracts';
import type { z } from 'zod';
import { SEND_NOW_ONLY } from '../delivery-routes';

export type AppApprovalPart = z.infer<typeof replyApprovalPartV1Schema>;
export const APP_REVIEW_MAX_CHARS = REPLY_TEXT_MAX_CHARS;

// The app's form of an approval card, checked against the pinned contract. A card that does not
// parse is never presented, so it can never open a row.
export const appApprovalPart = (part: AppApprovalPart): AppApprovalPart => replyApprovalPartV1Schema.parse(part);
export const appApprovalLink = (approvalId: string): string => `waldo://approvals/${approvalId}`;
// What a chat turn on the app tells the model when a tool needs Google: the app connects from its own screen.
export const APP_CONNECT_GUIDANCE = 'No connect button was sent: the app chat has none. Tell the owner to go back to Home, open the menu at the top left, tap Connections and connect Google there - never quote or retype any link yourself.';

// A turn's reply reaches the app through the transcript its own turn writes, so a plain send during a
// turn is accepted and goes nowhere else. Scheduled work has no turn: while the alarm holds a delivery,
// the text is written to the transcript, and a failed write throws so the job fails instead of recording
// a message the owner never got. Its receipt names the Main chat row it wrote. A keyboard, with decision or
// link buttons, is an affordance the app cannot render from this path; it is never acknowledged as shown,
// nor written as plain text. The delivery learns whether the send is worth delivering only now, so a copy of it
// is never kept for later on another surface.
export type AppSend = Readonly<{ nowOnly?: boolean }>;
export type ScheduledAppDelivery = (text: string, send?: AppSend) => Promise<string>;
// A surface whose turn replies leave through an outbox of their own (iMessage) acknowledges a plain send only during its
// turn: outside one, a send with no delivery bound has nowhere to go, so it returns no message, which producers read as
// not sent.
export const appCaller = (scheduledDelivery: () => ScheduledAppDelivery | null = () => null, inTurn: () => boolean = () => true) => async (method: string, body: unknown): Promise<unknown> => {
  if (method !== 'sendMessage') return undefined;
  const { chat_id: chatId, text, reply_markup: markup } = body as { chat_id?: number; text?: string; reply_markup?: { inline_keyboard?: readonly (readonly unknown[])[] } };
  if ((markup?.inline_keyboard ?? []).some(row => row.length > 0)) return undefined;
  const deliver = scheduledDelivery();
  if (!deliver && !inTurn()) return undefined;
  const row = deliver ? await deliver(text ?? '', { nowOnly: (body as { [SEND_NOW_ONLY]?: unknown })[SEND_NOW_ONLY] === true }) : undefined;
  return { message_id: 1, chat: { id: chatId ?? 0 }, ...(row === undefined ? {} : { app_row_id: row }) };
};
