import { z } from 'zod';
import {
  fallbackTextV1Schema, opaqueRefV1Schema, REPLY_TEXT_MAX_CHARS, replyApprovalPartV1Schema, replyChartSeriesPartV1Schema,
  replyFilePartV1Schema, replyQuickRepliesPartV1Schema, replyVisibilityV1Schema, replyVoicePartV1Schema,
} from '../app/parts';
import { waldoCardSchema } from '../ui/card';

export {
  approvalActionV1Schema, approvalIdV1Schema, approvalKindV1Schema, payloadDigestV1Schema, QUICK_REPLY_LABEL_MAX_CHARS,
  QUICK_REPLY_MAX_CHOICES, REPLY_FALLBACK_MAX_CHARS, REPLY_TEXT_MAX_CHARS, replyApprovalPartV1Schema, replyChartSeriesPartV1Schema,
  replyFilePartV1Schema, replyQuickRepliesPartV1Schema, replyVisibilityV1Schema, replyVoicePartV1Schema,
} from '../app/parts';
export type { ApprovalActionV1, ApprovalKindV1, ReplyVisibilityV1 } from '../app/parts';

export const REPLY_MAX_PARTS = 16;

export const replyTextPartV1Schema = z.strictObject({ type: z.literal('text'), text: z.string().max(REPLY_TEXT_MAX_CHARS).regex(/\S/) });
export const replyCardPartV1Schema = z.strictObject({ type: z.literal('card'), card: waldoCardSchema, fallback_text: fallbackTextV1Schema });
export const replyArtifactPartV1Schema = z.strictObject({ type: z.literal('artifact'), artifact_id: opaqueRefV1Schema, revision: z.int().positive(), fallback_text: fallbackTextV1Schema });

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

export type ReplyPartV1 = z.infer<typeof replyPartV1Schema>;
export type ReplyEnvelopeV1 = z.infer<typeof replyEnvelopeV1Schema>;
