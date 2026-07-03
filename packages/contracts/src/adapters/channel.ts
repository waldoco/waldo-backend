import { z } from 'zod';
import type { AdapterResult } from '../core/error';
import { idempotencyKeySchema } from '../runtime/outbox';
import { waldoCardKindSchema, waldoCardSchema } from '../ui/card';

// Single owner of channel literals (ADR-0012). 'discord', 'slack', and 'whatsapp' are
// Phase-2 surfaces — the vocabulary is closed now so every downstream module types
// against the full set, while adapter implementations and personas land per phase.
export const channelNameSchema = z.enum([
  'telegram',
  'apns',
  'whatsapp',
  'discord',
  'slack',
  'in_app',
]);
export type ChannelName = z.infer<typeof channelNameSchema>;

// ADR-0035 persona slicing. 'all' resolves the ADR's own type drift (the iOS persona sets
// the string sentinel against a declared array field): a typed union member keeps the
// sentinel meaning "every kind, including future ones" without a bare-string escape hatch.
export const cardKindsAllowedSchema = z.union([z.literal('all'), z.array(waldoCardKindSchema)]);
export type CardKindsAllowed = z.infer<typeof cardKindsAllowedSchema>;

// One agent, channel-sliced expression (ADR-0035): decision is shared, expression is
// per-channel. Redaction is a tone shift, not data hiding — work channels still get
// health-aware decisions, expressed functionally rather than clinically.
export const channelPersonaSchema = z.strictObject({
  channel: channelNameSchema,
  tone: z.enum(['warm_personal', 'structured_visual', 'professional_work']),
  verbosity_ceiling_tokens: z.int().positive(),
  greeting_style: z.enum(['casual', 'structured', 'professional']),
  signoff_style: z.enum(['casual', 'structured', 'professional', 'none']),
  health_data_redaction: z.enum(['none', 'work_filter']),
  card_kinds_allowed: cardKindsAllowedSchema,
  inline_affordances: z.array(z.enum(['buttons', 'chips', 'quick_replies', 'long_press_actions'])),
  raw_value_policy: z.enum(['show_zones', 'show_descriptions_only']),
});
export type ChannelPersona = z.infer<typeof channelPersonaSchema>;

export const TELEGRAM_PERSONA: ChannelPersona = {
  channel: 'telegram',
  tone: 'warm_personal',
  verbosity_ceiling_tokens: 180,
  greeting_style: 'casual',
  signoff_style: 'casual',
  health_data_redaction: 'none',
  card_kinds_allowed: [
    'adjustment_proposal',
    'window_proposal',
    'fetch_card',
    'brief_card',
    'skill_proposal',
    'draft_email_card',
    'context_card',
  ],
  inline_affordances: ['buttons'],
  raw_value_policy: 'show_zones',
};

export const IOS_PERSONA: ChannelPersona = {
  channel: 'apns',
  tone: 'structured_visual',
  verbosity_ceiling_tokens: 120,
  greeting_style: 'structured',
  signoff_style: 'none',
  health_data_redaction: 'none',
  card_kinds_allowed: 'all',
  inline_affordances: ['buttons', 'long_press_actions', 'quick_replies'],
  raw_value_policy: 'show_zones',
};

// Phase-2 forward-compatible spec (ADR-0035): no fetch_card — acute-health cards stay out
// of work channels; show_descriptions_only strips numeric scores.
export const SLACK_PERSONA: ChannelPersona = {
  channel: 'slack',
  tone: 'professional_work',
  verbosity_ceiling_tokens: 100,
  greeting_style: 'professional',
  signoff_style: 'professional',
  health_data_redaction: 'work_filter',
  card_kinds_allowed: ['adjustment_proposal', 'window_proposal', 'context_card', 'draft_email_card'],
  inline_affordances: ['buttons'],
  raw_value_policy: 'show_descriptions_only',
};

// Deliberately partial: 'discord' ships as vocabulary with no accepted persona, 'whatsapp'
// adopts the warm-personal persona once platform approval lands (ADR-0012), and 'in_app'
// renders with the apns persona at the slicing layer. Completeness checks must not demand
// one persona per channel literal.
export const CHANNEL_PERSONAS: Readonly<Partial<Record<ChannelName, ChannelPersona>>> = {
  telegram: TELEGRAM_PERSONA,
  apns: IOS_PERSONA,
  slack: SLACK_PERSONA,
};

// The sliced message a channel adapter delivers (ADR-0035). The idempotency key is the
// repo-canonical outbox key, so redelivery collapses at the channel seam too.
export const channelMessageSchema = z.strictObject({
  channel: channelNameSchema,
  text: z.string().min(1),
  cards: z.array(waldoCardSchema),
  idempotency_key: idempotencyKeySchema,
});
export type ChannelMessage = z.infer<typeof channelMessageSchema>;

// Message-tree depth bound (ADR-0039): reply nesting inside one thread, distinct from the
// thread-tree depth ADR-0077 owns — both trees cap at 4.
export const MAX_MESSAGE_BRANCH_DEPTH = 4;

// Binds a channel-delivered message into its thread position (ADR-0039): top-level means
// no parent AND depth 0 — the refine makes a half-detached message unrepresentable.
export const messageThreadBindingSchema = z
  .strictObject({
    thread_id: z.string().min(1),
    parent_message_id: z.string().min(1).nullable(),
    branch_depth: z.int().min(0).max(MAX_MESSAGE_BRANCH_DEPTH),
  })
  .refine((b) => (b.parent_message_id === null) === (b.branch_depth === 0), {
    error: 'top-level messages have no parent and depth 0; branched messages have both',
    path: ['branch_depth'],
  });
export type MessageThreadBinding = z.infer<typeof messageThreadBindingSchema>;

// What send() returns so SENT outbox rows can journal the provider message id and time
// (ADR-0067) — the unbind deleteMessage sweep selects on exactly these two fields.
export const channelSendReceiptSchema = z.strictObject({
  message_id: z.string().min(1),
  sent_at: z.int().nonnegative(),
});
export type ChannelSendReceipt = z.infer<typeof channelSendReceiptSchema>;

// The five-gate inbound contract (ADR-0067) — the ORDER is contract, not implementation
// detail: no update reaches agent execution unless every gate passes, in this order.
export const inboundGateSchema = z.enum(['transport', 'shape', 'identity', 'budget', 'replica']);
export type InboundGate = z.infer<typeof inboundGateSchema>;

// ACK semantics (ADR-0067): a transport (gate-1) mismatch is the coded auth_failed error —
// 401 before JSON parse — never a 200 decision, so 'transport' is absent from the drop
// branch by construction. Every handled-and-dropped outcome and every accepted turn is 200;
// accepted means durably journaled keyed by update_id. No designed 5xx.
export const inboundDecisionSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('accepted'), update_id: z.int().positive() }),
  z.strictObject({ outcome: z.literal('dropped'), gate: z.enum(['shape', 'identity', 'budget', 'replica']) }),
]);
export type InboundDecision = z.infer<typeof inboundDecisionSchema>;

// The ChannelAdapter seam (ADR-0012): provider-agnostic from day 1, so WhatsApp Phase 2 is
// an adapter implementation, not a refactor. Methods resolve coded failures, never throw.
export interface ChannelAdapter {
  channel: ChannelName;
  send(message: ChannelMessage): Promise<AdapterResult<ChannelSendReceipt>>;
  receive_webhook(payload: unknown): Promise<AdapterResult<InboundDecision>>;
}

// Gate 2 (ADR-0067): per-update-type shape with length bounds; the schema IS the gate.
// strictObject makes forwards (forward_origin), edits, and unknown update types
// unrecognized keys; the literals make bot senders and group chats unparseable. Bound
// values are defensive ceilings pending ADR-0067's platform re-verification pass.
const telegramSenderSchema = z.strictObject({
  id: z.int().positive(),
  is_bot: z.literal(false),
});

const telegramPrivateChatSchema = z.strictObject({
  id: z.int(),
  type: z.literal('private'),
});

// Registered server-side via setWebhook allowed_updates; the union below mirrors it 1:1
// as the runtime belt ('edited_message' is excluded at the source AND unparseable here).
export const telegramUpdateTypeSchema = z.enum(['message', 'callback_query', 'my_chat_member']);
export type TelegramUpdateType = z.infer<typeof telegramUpdateTypeSchema>;

// Media-only messages carry no text and are unparseable by design — the static
// "text only for now" reply lives behind the shape gate, never in a run.
export const telegramMessageUpdateSchema = z.strictObject({
  update_id: z.int().positive(),
  message: z.strictObject({
    from: telegramSenderSchema,
    chat: telegramPrivateChatSchema,
    text: z.string().min(1).max(4096),
  }),
});
export type TelegramMessageUpdate = z.infer<typeof telegramMessageUpdateSchema>;

// Callbacks carry no top-level chat: the private-chat check binds to
// callback_query.message.chat (ADR-0067 gate 2). data is an opaque server-issued id —
// never parsed as content.
export const telegramCallbackQueryUpdateSchema = z.strictObject({
  update_id: z.int().positive(),
  callback_query: z.strictObject({
    id: z.string().min(1).max(64),
    from: telegramSenderSchema,
    message: z.strictObject({ chat: telegramPrivateChatSchema }),
    data: z.string().min(1).max(64),
  }),
});
export type TelegramCallbackQueryUpdate = z.infer<typeof telegramCallbackQueryUpdateSchema>;

// Group chats are representable ONLY here: 'member'/'administrator' in a group drives
// leaveChat; 'kicked' in the private chat marks the binding suppressed_blocked, 'member'
// reactivates, and the post-leave 'left' matches no leave condition (no recursion).
export const telegramMyChatMemberUpdateSchema = z.strictObject({
  update_id: z.int().positive(),
  my_chat_member: z.strictObject({
    chat: z.strictObject({
      id: z.int(),
      type: z.enum(['private', 'group', 'supergroup', 'channel']),
    }),
    from: telegramSenderSchema,
    new_chat_member: z.strictObject({
      status: z.enum(['member', 'administrator', 'left', 'kicked']),
    }),
  }),
});
export type TelegramMyChatMemberUpdate = z.infer<typeof telegramMyChatMemberUpdateSchema>;

export const telegramInboundUpdateSchema = z.union([
  telegramMessageUpdateSchema,
  telegramCallbackQueryUpdateSchema,
  telegramMyChatMemberUpdateSchema,
]);
export type TelegramInboundUpdate = z.infer<typeof telegramInboundUpdateSchema>;

export const linkTokenKindSchema = z.literal('telegram_link');
export type LinkTokenKind = z.infer<typeof linkTokenKindSchema>;

// The raw deep-link bearer: 32 random bytes as exactly 64 lower-hex chars (ADR-0067).
// Lowercase-only keeps one canonical form for the SHA-256 digest-at-rest match; the raw
// token exists only inside the deep link and the minting response, never at rest.
export const linkTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type LinkToken = z.infer<typeof linkTokenSchema>;

// Minting voids the previous token; consume is a single guarded UPDATE inside this TTL.
export const LINK_TOKEN_TTL_MIN = 10;

// Channel-namespaced addressing for the identity module: peer_id is the string form of
// the wire sender id, so WhatsApp Phase 2 reuses the module with a new namespace
// (ADR-0067). handle is display-only and may be absent even while bound.
export const channelPeerSchema = z.strictObject({
  peer_id: z.string().min(1),
  chat_id: z.string().min(1),
  handle: z.string().min(1).nullable(),
});
export type ChannelPeer = z.infer<typeof channelPeerSchema>;

// The closed consume-outcome vocabulary (ADR-0067) — an eighth code is contract drift.
export const bindResultCodeSchema = z.enum([
  'bound',
  'already_used_self',
  'already_used_other',
  'expired',
  'invalid',
  'rebind_required',
  'peer_already_bound',
]);
export type BindResultCode = z.infer<typeof bindResultCodeSchema>;

// Only the two idempotent-success codes carry identity: the confirm outbox key derives
// from (user_id, binding_version). Failure results carry the code alone — the chat is no
// oracle (generic copy is identical across failure codes), so a failure that leaks the
// bound user is unrepresentable.
export const bindResultSchema = z.union([
  z.strictObject({
    code: z.enum(['bound', 'already_used_self']),
    user_id: z.string().min(1),
    binding_version: z.int().positive(),
  }),
  z.strictObject({
    code: z.enum(['already_used_other', 'expired', 'invalid', 'rebind_required', 'peer_already_bound']),
  }),
]);
export type BindResult = z.infer<typeof bindResultSchema>;

export const resolveResultSchema = z
  .strictObject({
    user_id: z.string().min(1),
    binding_version: z.int().positive(),
  })
  .nullable();
export type ResolveResult = z.infer<typeof resolveResultSchema>;

// The capability-ceiling dichotomy (ADR-0067): every grant and revocation flows from an
// authenticated app session except the one Telegram-side mutation — the version-fenced
// "not me" unbind, which can only reduce the pressing peer's own access.
export const unbindReasonSchema = z.enum(['app_initiated', 'peer_revoked']);
export type UnbindReason = z.infer<typeof unbindReasonSchema>;

// Unbind tombstones the binding rather than deleting it; the retained version is the
// fence that keeps a delayed stale bind-poke from resurrecting a revoked binding.
export const unbindResultSchema = z.strictObject({
  binding_version: z.int().positive(),
});
export type UnbindResult = z.infer<typeof unbindResultSchema>;

// ChannelIdentity (ADR-0067): three calls hide token atomics, UNIQUE-collision policy,
// version fencing, replica reconciliation, outbox cancellation, and the deleteMessage
// sweep. Ordering invariant: grants hit Supabase first, revocations hit the DO first; the
// replica adopts state only from Supabase-provenance reads, never from KV.
export interface ChannelIdentity {
  bind(token: LinkToken, peer: ChannelPeer): Promise<AdapterResult<BindResult>>;
  resolve(peer_id: string): Promise<AdapterResult<ResolveResult>>;
  unbind(user_id: string, reason: UnbindReason): Promise<AdapterResult<UnbindResult>>;
}

// 'bound' is the active state; 'suppressed_blocked' (user blocked the bot) keeps the
// binding and addressing but stops sends; 'unbound' is the 30d-reaped tombstone.
export const channelBindingStateSchema = z.enum(['bound', 'suppressed_blocked', 'unbound']);
export type ChannelBindingState = z.infer<typeof channelBindingStateSchema>;

// The DO replica row behind gate 5 (ADR-0067). The refine encodes the tombstone law:
// addressing is scrubbed exactly when state is 'unbound' — the tombstone keeps only the
// version fence, so the DO holds no peer identifiers post-unlink.
export const channelBindingSchema = z
  .strictObject({
    channel: channelNameSchema,
    peer_id: z.string().min(1).nullable(),
    chat_id: z.string().min(1).nullable(),
    handle: z.string().min(1).nullable(),
    binding_version: z.int().positive(),
    bound_at: z.int().nonnegative(),
    state: channelBindingStateSchema,
  })
  .refine(
    (row) =>
      row.state === 'unbound'
        ? row.peer_id === null && row.chat_id === null && row.handle === null
        : row.peer_id !== null && row.chat_id !== null,
    {
      error: "addressing is scrubbed exactly when state is 'unbound'",
      path: ['state'],
    },
  );
export type ChannelBinding = z.infer<typeof channelBindingSchema>;

// ADR-0067 inbound limits — typed constants, tunable without re-ADR. KV-enforced limits
// are advisory and fail toward silence/drop; authoritative budgets live with the single
// writer (DO SQLite for bound senders, Postgres for mint caps). The "not me" revocation
// has no numeric row: it is valid for the lifetime of its binding_version (the fence).
export const inboundLimitsSchema = z.strictObject({
  live_link_tokens_per_user: z.int().positive(),
  token_mints_per_day: z.int().positive(),
  invalid_start_per_hour: z.int().positive(),
  invalid_start_mute_hours: z.int().positive(),
  bound_inbound_per_min: z.int().positive(),
  bound_inbound_per_day: z.int().positive(),
  over_limit_notices_per_hour: z.int().positive(),
  unknown_sender_replies_per_day: z.int().positive(),
  unknown_sender_global_circuit_per_day: z.int().positive(),
});
export type InboundLimits = z.infer<typeof inboundLimitsSchema>;

export const INBOUND_LIMITS: InboundLimits = {
  live_link_tokens_per_user: 1,
  token_mints_per_day: 5,
  invalid_start_per_hour: 5,
  invalid_start_mute_hours: 24,
  bound_inbound_per_min: 10,
  bound_inbound_per_day: 200,
  over_limit_notices_per_hour: 1,
  unknown_sender_replies_per_day: 1,
  unknown_sender_global_circuit_per_day: 100,
};

// Structured-log counter names (ADR-0067). Counters carry hashed peer ids only — never
// handles, raw update bodies, or the received header value.
export const gateCounterSchema = z.enum(['gate1_reject', 'tg_token_replay', 'tg_unknown_drop']);
export type GateCounter = z.infer<typeof gateCounterSchema>;

// Gate 1 reads exactly this header, constant-time, against the {current, next} dual-accept
// set, before any body read (ADR-0067). The received value is never logged.
export const TELEGRAM_WEBHOOK_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

// Salt of the bind-confirm outbox idempotency key, hash(user_id, kind, binding_version):
// redelivery and gate-5 reconciliation converge on one confirm send per binding version.
export const TG_BIND_CONFIRM_KIND = 'tg_bind_confirm';
