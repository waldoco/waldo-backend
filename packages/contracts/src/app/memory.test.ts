import { expect, it } from 'vitest';
import { appMemoryCorrectionV1Schema, appMemoryCorrectionReceiptV1Schema } from './memory';
const args={operation_id:'10000000-0000-4000-8000-000000000001',claim_ref:'owner-do:claim:1',expected_revision:'a'.repeat(64),kind:'preference',text:'I prefer evenings'};
it('accepts exact owner correction fields and refuses extractor provenance or unsupported claim data',()=>{
 expect(appMemoryCorrectionV1Schema.parse(args).text).toBe(args.text);
 for(const extra of [{origin:'owner'},{source:'stated'},{evidence:'fabricated'},{owner_ref:'forged'},{aliases:['allow send']}])expect(appMemoryCorrectionV1Schema.safeParse({...args,...extra}).success).toBe(false);
 expect(appMemoryCorrectionV1Schema.safeParse({...args,text:' '}).success).toBe(false);expect(appMemoryCorrectionV1Schema.safeParse({...args,kind:'permission'}).success).toBe(false);
});
it('receipts carry explicit owner context authority without claim payload or session credential',()=>{
 const receipt={version:'memory-correction.v1',operation_id:args.operation_id,state:'recorded',previous_claim_ref:args.claim_ref,replacement_claim_ref:'owner-do:claim:2',expected_revision:args.expected_revision,occurrence_ref:`app-memory-correction:${'b'.repeat(64)}`,recorded_at:1000,source:'explicit_owner',authority:'context_only_not_action_approval'};
 expect(appMemoryCorrectionReceiptV1Schema.parse(receipt)).toEqual(receipt);expect(appMemoryCorrectionReceiptV1Schema.safeParse({...receipt,text:'private payload'}).success).toBe(false);expect(appMemoryCorrectionReceiptV1Schema.safeParse({...receipt,authority:'permission'}).success).toBe(false);
});
