import { z } from 'zod';
import { memoryClaimKindSchema } from '../tools/schemas/memory';

export const APP_MEMORY_CORRECTION_MAX_REQUEST_BYTES = 16 * 1024;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const claimRef = z.string().min(1).max(256);
export const appMemoryCorrectionV1Schema = z.strictObject({
  operation_id: z.uuid(), claim_ref: claimRef, expected_revision: revision,
  kind: memoryClaimKindSchema,
  // Preserve the owner's exact replacement as evidence; never accept extractor
  // provenance, aliases, source/owner labels or model-created evidence fields.
  text: z.string().min(1).max(4096).refine(text => text.trim().length > 0),
});
export type AppMemoryCorrectionV1 = z.infer<typeof appMemoryCorrectionV1Schema>;
export const appMemoryCorrectionReceiptV1Schema = z.strictObject({
  version: z.literal('memory-correction.v1'), operation_id: z.uuid(),
  state: z.literal('recorded'), previous_claim_ref: claimRef, replacement_claim_ref: claimRef,
  expected_revision: revision, occurrence_ref: z.string().regex(/^app-memory-correction:[a-f0-9]{64}$/),
  recorded_at: z.int().nonnegative(), source: z.literal('explicit_owner'), authority: z.literal('context_only_not_action_approval'),
});
export type AppMemoryCorrectionReceiptV1 = z.infer<typeof appMemoryCorrectionReceiptV1Schema>;
export const appMemoryCorrectionTargetsV1Schema = z.strictObject({
  version: z.literal('memory-correction.v1'), targets: z.array(z.strictObject({claim_ref:claimRef,revision})).max(200),
  truncated: z.boolean(),
});
export const appMemoryCorrectionRoutesV1 = [
  {method:'GET',path:'/app/v1/memory/corrections/targets',response:appMemoryCorrectionTargetsV1Schema},
  {method:'POST',path:'/app/v1/memory/corrections',request:appMemoryCorrectionV1Schema,max_request_bytes:APP_MEMORY_CORRECTION_MAX_REQUEST_BYTES,response:appMemoryCorrectionReceiptV1Schema},
  {method:'GET',path:'/app/v1/memory/corrections/{operation_id}',response:appMemoryCorrectionReceiptV1Schema},
] as const;
