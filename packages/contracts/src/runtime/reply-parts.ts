import { z } from 'zod';
import { waldoCardSchema } from '../ui/card';

export const REPLY_TEXT_MAX_CHARS = 32_000;
// Telegram and WhatsApp cap one text message at 4,096 characters; a fallback must fit in one.
export const REPLY_FALLBACK_MAX_CHARS = 4_096;
export const REPLY_MAX_PARTS = 16;
export const QUICK_REPLY_MAX_CHOICES = 10;
// WhatsApp's reply-button title limit, so a label shows untruncated on every surface.
export const QUICK_REPLY_LABEL_MAX_CHARS = 20;

const visibleText = (max: number) => z.string().max(max).regex(/\S/);
const fallback_text = visibleText(REPLY_FALLBACK_MAX_CHARS);
const opaqueRef = z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/);
const epochMs = z.int().nonnegative();
const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;

export const approvalIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const approvalKindV1Schema = z.enum(['calendar_change', 'email_send', 'message_send', 'browser_submit', 'mcp_call']);
// The approval desk's decisions: Do it, Not now, Modify, and Undo after an effect.
export const approvalActionV1Schema = z.enum(['approve', 'skip', 'edit', 'undo']);
export const payloadDigestV1Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const replyVisibilityV1Schema = z.enum(['shared', 'app_only']);

export const replyTextPartV1Schema = z.strictObject({ type: z.literal('text'), text: visibleText(REPLY_TEXT_MAX_CHARS) });
export const replyCardPartV1Schema = z.strictObject({ type: z.literal('card'), card: waldoCardSchema, fallback_text });
export const replyApprovalPartV1Schema = z.strictObject({
  type: z.literal('approval'), approval_id: approvalIdV1Schema, kind: approvalKindV1Schema,
  review: visibleText(REPLY_TEXT_MAX_CHARS), payload_digest: payloadDigestV1Schema,
  actions: z.array(approvalActionV1Schema.exclude(['undo'])).min(1).max(3).refine(distinct, 'actions repeat'),
  expires_at: epochMs, fallback_text,
});
export const replyQuickRepliesPartV1Schema = z.strictObject({
  type: z.literal('quick_replies'),
  choices: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), label: visibleText(QUICK_REPLY_LABEL_MAX_CHARS) }))
    .min(1).max(QUICK_REPLY_MAX_CHOICES).refine(choices => distinct(choices.map(choice => choice.id)), 'choice ids repeat'),
  fallback_text,
});
export const replyChartSeriesPartV1Schema = z.strictObject({
  type: z.literal('chart_series'), title: visibleText(120), unit: z.string().max(24),
  series: z.array(z.strictObject({
    label: visibleText(60),
    points: z.array(z.strictObject({ t: epochMs, v: z.number() })).min(1).max(500),
  })).min(1).max(8),
  alt_text: visibleText(REPLY_FALLBACK_MAX_CHARS), fallback_text,
});
export const replyFilePartV1Schema = z.strictObject({
  type: z.literal('file'), file_ref: opaqueRef, name: z.string().min(1).max(255),
  mime: z.string().max(127).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/),
  bytes: z.int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), fallback_text,
});
export const replyArtifactPartV1Schema = z.strictObject({ type: z.literal('artifact'), artifact_id: opaqueRef, revision: z.int().positive(), fallback_text });
export const replyVoicePartV1Schema = z.strictObject({ type: z.literal('voice'), audio_ref: opaqueRef, transcript: visibleText(8_000), fallback_text });

// Parts come from structured tool results and desk proposals, never from parsing reply text.
export const replyPartV1Schema = z.discriminatedUnion('type', [
  replyTextPartV1Schema, replyCardPartV1Schema, replyApprovalPartV1Schema, replyQuickRepliesPartV1Schema,
  replyChartSeriesPartV1Schema, replyFilePartV1Schema, replyArtifactPartV1Schema, replyVoicePartV1Schema,
]);

// One reply, recorded once under reply_id; each surface delivery is a projection of it.
export const replyEnvelopeV1Schema = z.strictObject({
  reply_id: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  principal_ref: z.string().regex(/^prn_[a-f0-9]{32}$/),
  conversation_ref: z.string().min(1).max(256),
  anchor_entry_id: z.string().min(1).max(256).optional(),
  origin: z.enum(['turn', 'proactive']),
  visibility: replyVisibilityV1Schema,
  custody: z.enum(['durable', 'volatile_owner_health']),
  urgency: z.enum(['low', 'medium', 'high']).optional(),
  parts: z.array(replyPartV1Schema).min(1).max(REPLY_MAX_PARTS),
});

export type ApprovalKindV1 = z.infer<typeof approvalKindV1Schema>;
export type ApprovalActionV1 = z.infer<typeof approvalActionV1Schema>;
export type ReplyVisibilityV1 = z.infer<typeof replyVisibilityV1Schema>;
export type ReplyPartV1 = z.infer<typeof replyPartV1Schema>;
export type ReplyEnvelopeV1 = z.infer<typeof replyEnvelopeV1Schema>;
