import { z } from 'zod';
import { briefVariantSchema } from '../core/trigger';
import { formZoneSchema, loadZoneSchema, recoveryZoneSchema } from '../health/crs';

// Canonical card-kind vocabulary — this file is its single owner. The literals are
// ADR-0035's card_kinds_allowed set; ADR-0013's display-card `type` union is absorbed
// into it (which stat or entry a card shows is payload, not kind — mapping documented
// in card.test.ts). adapters/channel persona shapes consume this via z.infer.
export const waldoCardKindSchema = z.enum([
  'adjustment_proposal',
  'window_proposal',
  'fetch_card',
  'brief_card',
  'skill_proposal',
  'draft_email_card',
  'context_card',
]);
export type WaldoCardKind = z.infer<typeof waldoCardKindSchema>;

// card_id anchors the tap-to-thread flow and the chat_messages card columns (ADR-0013).
export const cardIdSchema = z.string().min(1);

// Card payloads persist in chat_messages.context_card_data and ride outbox/journal
// shapes (ADR-0013), so the payload is Art-9-safe by construction: stable source IDs
// + zone words only, per the ADR-0077 layering (raw arrays and sensor values live in
// other layers). strictObject turns a drifted-in raw sensor field into a parse failure.
export const cardDataSchema = z.strictObject({
  source_refs: z.array(z.string().min(1)),
  form_zone: formZoneSchema.optional(),
  recovery_zone: recoveryZoneSchema.optional(),
  load_zone: loadZoneSchema.optional(),
});
export type CardData = z.infer<typeof cardDataSchema>;

// Every Brief carries its variant (ADR-0015) so renderers frame morning/midday/evening/
// event without a second taxonomy. The free-text brief_trigger_reason stays on
// InvocationContext — never on a persisted card payload.
export const briefCardDataSchema = z.strictObject({
  ...cardDataSchema.shape,
  variant: briefVariantSchema,
});
export type BriefCardData = z.infer<typeof briefCardDataSchema>;

// ADR-0027: the draft body is never persisted in Waldo — the card carries only the
// provider draft_id reference, and strictObject makes a smuggled body field a parse failure.
export const draftEmailCardDataSchema = z.strictObject({
  draft_id: z.string().min(1),
});
export type DraftEmailCardData = z.infer<typeof draftEmailCardDataSchema>;

export const waldoCardSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('adjustment_proposal'), card_id: cardIdSchema, data: cardDataSchema }),
  z.strictObject({ kind: z.literal('window_proposal'), card_id: cardIdSchema, data: cardDataSchema }),
  z.strictObject({ kind: z.literal('fetch_card'), card_id: cardIdSchema, data: cardDataSchema }),
  z.strictObject({ kind: z.literal('brief_card'), card_id: cardIdSchema, data: briefCardDataSchema }),
  z.strictObject({ kind: z.literal('skill_proposal'), card_id: cardIdSchema, data: cardDataSchema }),
  z.strictObject({ kind: z.literal('draft_email_card'), card_id: cardIdSchema, data: draftEmailCardDataSchema }),
  z.strictObject({ kind: z.literal('context_card'), card_id: cardIdSchema, data: cardDataSchema }),
]);
export type WaldoCard = z.infer<typeof waldoCardSchema>;
