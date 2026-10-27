import { z } from 'zod';
import { briefVariantSchema, triggerTypeSchema } from '../core/trigger';
import { formZoneSchema, loadZoneSchema, recoveryZoneSchema } from '../health/crs';
import { approvalIdV1Schema } from '../app/parts';
import { cardIdSchema } from './card';

// Push payloads ride the outbox and land in provider requests (ADR-0012 channel
// adapters), so the content contract is Art-9-safe by construction: stable IDs + zone
// words only. Rendered copy — and ADR-0015's free-text brief_trigger_reason — is
// composed at the persona-slicing layer (ADR-0035) and never persists in this shape.
//
// An approval push says only that something waits and which approval opens: the id, never why.
export const pushNotificationSchema = z
  .strictObject({
    trigger: triggerTypeSchema.or(z.literal('approval')),
    variant: briefVariantSchema.optional(),
    card_ref: cardIdSchema.optional(),
    approval_id: approvalIdV1Schema.optional(),
    form_zone: formZoneSchema.optional(),
    recovery_zone: recoveryZoneSchema.optional(),
    load_zone: loadZoneSchema.optional(),
  })
  .refine((payload) => (payload.trigger === 'brief') === (payload.variant !== undefined), {
    error: "variant is present iff trigger is 'brief'",
    path: ['variant'],
  })
  .refine(
    (payload) =>
      payload.trigger === 'approval'
        ? payload.approval_id !== undefined &&
          [payload.card_ref, payload.form_zone, payload.recovery_zone, payload.load_zone].every((key) => key === undefined)
        : payload.approval_id === undefined,
    { error: "an approval push carries its approval_id and nothing else, and no other trigger carries one", path: ['approval_id'] },
  );
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
