import { z } from 'zod';
import type { AdapterResult } from '../core/error';
import { errorCodeSchema, iso8601Schema } from '../core/error';

export const emailProviderNameSchema = z.enum(['gmail', 'outlook_graph']);
export type EmailProviderName = z.infer<typeof emailProviderNameSchema>;

// sha256 hex of (user_id + to + subject + body_hash + 5-min bucket) per ADR-0027 — the
// create_draft dedup key. Lowercase-only pins one canonical representation per digest.
export const emailIdempotencyKeySchema = z.string().regex(/^[0-9a-f]{64}$/);

// ADR-0027 pinned tunables: the 5-min bucket feeding the idempotency formula, the 24h window
// inside which a repeated key returns the existing draft, and the confirmation-token expiry
// counted from [Send] button render.
export const emailDraftPolicySchema = z.strictObject({
  hash_bucket_minutes: z.int().positive(),
  dedup_window_hours: z.int().positive(),
  confirmation_token_ttl_minutes: z.int().positive(),
});
export type EmailDraftPolicy = z.infer<typeof emailDraftPolicySchema>;

export const EMAIL_DRAFT_POLICY: EmailDraftPolicy = {
  hash_bucket_minutes: 5,
  dedup_window_hours: 24,
  confirmation_token_ttl_minutes: 5,
};

// The draft reference Waldo holds (ADR-0027). No body field exists — strictObject makes a
// body key a parse failure, so the privacy wall (body lives only in the user's mail
// provider) is structural, not reviewed-for. Recipients are opaque non-empty strings, not
// z.email(): provider drafts legitimately carry display-name forms ("Sam <sam@example.com>").
export const emailDraftSchema = z.strictObject({
  draft_id: z.string().min(1),
  thread_id: z.string().min(1).optional(),
  message_id: z.string().min(1).optional(),
  subject: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
  created_at: iso8601Schema,
  // Deep link to the provider's compose UI for user review before send.
  send_url: z.url().optional(),
});
export type EmailDraft = z.infer<typeof emailDraftSchema>;

// The DO drafts-table row (ADR-0027): the audit-safe residue of a draft. recipient_count is
// stored, never the recipient list; there is no body column. Runtime row, so epoch-ms ints.
export const emailDraftRecordSchema = z.strictObject({
  draft_id: z.string().min(1),
  provider: emailProviderNameSchema,
  created_at: z.int().nonnegative(),
  sent_at: z.int().nonnegative().nullable(),
  recipient_count: z.int().positive(),
  idempotency_key: emailIdempotencyKeySchema,
});
export type EmailDraftRecord = z.infer<typeof emailDraftRecordSchema>;

export const emailMetadataArgsSchema = z.strictObject({
  date_range: z.strictObject({ from: iso8601Schema, to: iso8601Schema }),
});
export type EmailMetadataArgs = z.infer<typeof emailMetadataArgsSchema>;

// Aggregates only (ADR-0027 metadata-only reader) — never sender names, subjects, or bodies.
export const emailMetadataSummarySchema = z.strictObject({
  message_count: z.int().nonnegative(),
  after_hours_ratio: z.number().min(0).max(1),
  thread_depth_avg: z.number().nonnegative(),
  sender_domains: z.array(z.string().min(1)),
});
export type EmailMetadataSummary = z.infer<typeof emailMetadataSummarySchema>;

export const emailMetadataDataSchema = z.strictObject({ summary: emailMetadataSummarySchema });
export type EmailMetadataData = z.infer<typeof emailMetadataDataSchema>;

export const createDraftArgsSchema = z.strictObject({
  to: z.array(z.string().min(1)).min(1),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
  subject: z.string().min(1),
  // Already Scribe-sanitised (ADR-0024) when it reaches the adapter: recipients in `to` ARE
  // the message and stay; other attendees are redacted upstream; the 10KB size cap is the
  // sanitiser's, not re-enforced here. The body crosses Waldo exactly once, Worker to
  // provider — it is never persisted (contrast EmailDraft, which has no body field).
  body_markdown: z.string().min(1),
  reply_to_thread_id: z.string().min(1).optional(),
  in_reply_to_message_id: z.string().min(1).optional(),
  idempotency_key: emailIdempotencyKeySchema,
});
export type CreateDraftArgs = z.infer<typeof createDraftArgsSchema>;

export const createDraftDataSchema = z.strictObject({ draft: emailDraftSchema });
export type CreateDraftData = z.infer<typeof createDraftDataSchema>;

export const listDraftsArgsSchema = z.strictObject({ limit: z.int().positive().optional() });
export type ListDraftsArgs = z.infer<typeof listDraftsArgsSchema>;

export const listDraftsDataSchema = z.strictObject({ drafts: z.array(emailDraftSchema) });
export type ListDraftsData = z.infer<typeof listDraftsDataSchema>;

export const deleteDraftArgsSchema = z.strictObject({ draft_id: z.string().min(1) });
export type DeleteDraftArgs = z.infer<typeof deleteDraftArgsSchema>;

// delete_draft succeeds with no payload; the empty strict object keeps AdapterResult's
// required data key uniform without minting fields ADR-0027 does not define.
export const emailAckSchema = z.strictObject({});
export type EmailAck = z.infer<typeof emailAckSchema>;

export const sendDraftArgsSchema = z.strictObject({
  draft_id: z.string().min(1),
  // HMAC(secret, draft_id + user_id + timestamp), minted client-side on [Send] render and
  // validated server-side with a 5-min expiry (ADR-0027). Model output can never carry a
  // valid token, so prompt-injection-induced send is structurally impossible.
  user_confirmation_token: z.string().min(1),
});
export type SendDraftArgs = z.infer<typeof sendDraftArgsSchema>;

export const sendDraftDataSchema = z.strictObject({ message_id: z.string().min(1) });
export type SendDraftData = z.infer<typeof sendDraftDataSchema>;

// Runtime validator for the AdapterResult envelope around each method's payload. Module-local:
// core/error keeps AdapterResult a static type by design (a generic schema is a factory, not a
// value); the concrete per-method schemas below are the runtime-boundary validators.
const adapterResult = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data }),
    z.strictObject({ ok: z.literal(false), error: z.string().min(1), code: errorCodeSchema }),
  ]);

export const emailMetadataResultSchema = adapterResult(emailMetadataDataSchema);
export const createDraftResultSchema = adapterResult(createDraftDataSchema);
export const listDraftsResultSchema = adapterResult(listDraftsDataSchema);
export const deleteDraftResultSchema = adapterResult(emailAckSchema);
export const sendDraftResultSchema = adapterResult(sendDraftDataSchema);

// The EmailProvider seam (ADR-0027): drafts only. Waldo never auto-sends at any autonomy
// level, including L3 — an explicit user-protective override of the autonomy slider, same
// pattern as the ADR-0018 connector_write rule. send_draft exists on the adapter but the
// tool layer never routes model output to it: draft_email creates the draft; only a
// user-tapped [Send], carrying a valid confirmation token through execute_action, sends.
// Sent mail is the irreversible edge; drafts remain deletable via delete_draft.
export interface EmailProvider {
  provider: EmailProviderName;
  get_metadata(args: EmailMetadataArgs): Promise<AdapterResult<EmailMetadataData>>;
  create_draft(args: CreateDraftArgs): Promise<AdapterResult<CreateDraftData>>;
  list_drafts(args: ListDraftsArgs): Promise<AdapterResult<ListDraftsData>>;
  delete_draft(args: DeleteDraftArgs): Promise<AdapterResult<EmailAck>>;
  send_draft(args: SendDraftArgs): Promise<AdapterResult<SendDraftData>>;
}
