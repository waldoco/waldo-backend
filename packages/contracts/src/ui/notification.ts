import { z } from 'zod';
import { briefVariantSchema, triggerTypeSchema } from '../core/trigger';
import { formZoneSchema, loadZoneSchema, recoveryZoneSchema } from '../health/crs';
import { cardIdSchema } from './card';

// Push payloads ride the outbox and land in provider requests (ADR-0012 channel
// adapters), so the content contract is Art-9-safe by construction: stable IDs + zone
// words only. Rendered copy — and ADR-0015's free-text brief_trigger_reason — is
// composed at the persona-slicing layer (ADR-0035) and never persists in this shape.
export const pushNotificationSchema = z
  .strictObject({
    trigger: triggerTypeSchema,
    variant: briefVariantSchema.optional(),
    card_ref: cardIdSchema.optional(),
    form_zone: formZoneSchema.optional(),
    recovery_zone: recoveryZoneSchema.optional(),
    load_zone: loadZoneSchema.optional(),
  })
  .refine((payload) => (payload.trigger === 'brief') === (payload.variant !== undefined), {
    error: "variant is present iff trigger is 'brief'",
    path: ['variant'],
  });
export type PushNotification = z.infer<typeof pushNotificationSchema>;

// ADR-0067 (narrow acceptance): bind/rebind/unlink notices form a standalone,
// budget-exempt, zero-health delivery class. This module owns the class literal and the
// payload shape; the policy row composes into the ADR-0068 delivery-policy table.
export const accountEventClassSchema = z.literal('account_event');
export type AccountEventClass = z.infer<typeof accountEventClassSchema>;

export const accountEventKindSchema = z.enum(['bind', 'rebind', 'unlink']);
export type AccountEventKind = z.infer<typeof accountEventKindSchema>;

// System-emitted by the identity module, never agent-invocable: the literal false makes
// an agent-invocable claim unrepresentable, so the delivery invariant (every
// agent-reachable exempt class carries a non-null daily cap) is satisfied vacuously.
// Zero health content by construction — not even zone words. Addressing metadata
// (handle, chat_id) resolves at flush time (ADR-0067) and never rides this payload.
export const accountEventNoticeSchema = z.strictObject({
  push_class: accountEventClassSchema,
  event: accountEventKindSchema,
  binding_version: z.int().positive(),
  agent_invocable: z.literal(false),
});
export type AccountEventNotice = z.infer<typeof accountEventNoticeSchema>;
