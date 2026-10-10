import { z } from 'zod';

export const REPLY_TEXT_MAX_CHARS = 32_000;
// Telegram and WhatsApp cap one text message at 4,096 characters; a fallback must fit in one.
export const REPLY_FALLBACK_MAX_CHARS = 4_096;
export const QUICK_REPLY_MAX_CHOICES = 10;
// WhatsApp's reply-button title limit, so a label shows untruncated on every surface.
export const QUICK_REPLY_LABEL_MAX_CHARS = 20;

const visibleText = (max: number) => z.string().max(max).regex(/\S/);
const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;
export const fallbackTextV1Schema = visibleText(REPLY_FALLBACK_MAX_CHARS);
export const opaqueRefV1Schema = z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/);
// Epoch milliseconds. The floor (September 2001) makes a seconds value fail instead of reading as 1970.
export const epochMsV1Schema = z.int().min(1_000_000_000_000);

export const approvalIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const approvalKindV1Schema = z.enum(['calendar_change', 'email_send', 'message_send', 'browser_submit', 'mcp_call', 'google_task_change']);
// The approval desk's decisions: Do it, Not now, Modify, and Undo after an effect.
export const approvalActionV1Schema = z.enum(['approve', 'skip', 'edit', 'undo']);
export const approvalReviewV1Schema = visibleText(REPLY_TEXT_MAX_CHARS);
export const payloadDigestV1Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const replyVisibilityV1Schema = z.enum(['shared', 'app_only']);

export const replyApprovalPartV1Schema = z.strictObject({
  type: z.literal('approval'), approval_id: approvalIdV1Schema, kind: approvalKindV1Schema,
  review: approvalReviewV1Schema, payload_digest: payloadDigestV1Schema,
  // Empty once the approval is decided or its card is retired: a history card then offers nothing.
  actions: z.array(approvalActionV1Schema.exclude(['undo'])).max(3).refine(distinct, 'actions repeat'),
  expires_at: epochMsV1Schema, fallback_text: fallbackTextV1Schema,
});
export const replyQuickRepliesPartV1Schema = z.strictObject({
  type: z.literal('quick_replies'),
  choices: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), label: visibleText(QUICK_REPLY_LABEL_MAX_CHARS) }))
    .min(1).max(QUICK_REPLY_MAX_CHOICES).refine(choices => distinct(choices.map(choice => choice.id)), 'choice ids repeat'),
  fallback_text: fallbackTextV1Schema,
});
export const replyChartSeriesPartV1Schema = z.strictObject({
  type: z.literal('chart_series'), title: visibleText(120), unit: z.string().max(24),
  series: z.array(z.strictObject({
    label: visibleText(60),
    points: z.array(z.strictObject({ t: z.int().nonnegative(), v: z.number() })).min(1).max(500),
  })).min(1).max(8),
  alt_text: visibleText(REPLY_FALLBACK_MAX_CHARS), fallback_text: fallbackTextV1Schema,
});
export const replyFilePartV1Schema = z.strictObject({
  type: z.literal('file'), file_ref: opaqueRefV1Schema, name: z.string().min(1).max(255),
  mime: z.string().max(127).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/),
  bytes: z.int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), fallback_text: fallbackTextV1Schema,
});
export const replyVoicePartV1Schema = z.strictObject({
  type: z.literal('voice'), audio_ref: opaqueRefV1Schema, transcript: visibleText(8_000), fallback_text: fallbackTextV1Schema,
});

export type ApprovalKindV1 = z.infer<typeof approvalKindV1Schema>;
export type ApprovalActionV1 = z.infer<typeof approvalActionV1Schema>;
export type ReplyVisibilityV1 = z.infer<typeof replyVisibilityV1Schema>;
