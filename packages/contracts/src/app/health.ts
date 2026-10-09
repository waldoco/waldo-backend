import { z } from 'zod';
import { healthSourceSchema } from '../adapters/health';
import { healthConsentGrantSchema, healthConsentWithdrawSchema, healthConsentListSchema, healthConsentChangeSchema, healthIngestSchema, healthIngestReceiptSchema, healthDailySummarySchema, healthHistoryQuerySchema, healthReadingsSchema } from '../health/ingest';
const historyQuery = z.strictObject({ source: healthSourceSchema, from:z.iso.date(),to:z.iso.date(),consent_epoch:z.coerce.number().int().nonnegative() }).refine(value=>healthHistoryQuerySchema.safeParse(value).success);
export const appHealthRoutesV1 = [
  {method:'GET',path:'/app/v1/health/consents',response:healthConsentListSchema,authenticated:true},
  {method:'POST',path:'/app/v1/health/consents',request:healthConsentGrantSchema,response:healthConsentChangeSchema,authenticated:true,idempotency_field:'request_id',max_request_bytes:98304},
  {method:'POST',path:'/app/v1/health/consents/withdraw',request:healthConsentWithdrawSchema,response:healthConsentChangeSchema,authenticated:true,idempotency_field:'request_id',max_request_bytes:98304},
  {method:'POST',path:'/app/v1/health/ingest',request:healthIngestSchema,response:healthIngestReceiptSchema,authenticated:true,idempotency_field:'request_id',max_request_bytes:98304},
  {method:'GET',path:'/app/v1/health/today',query:z.strictObject({source:healthSourceSchema.optional()}),response:healthDailySummarySchema.nullable(),authenticated:true},
  {method:'GET',path:'/app/v1/health/history',query:historyQuery,response:z.strictObject({days:z.array(healthDailySummarySchema).max(90)}),authenticated:true},
  {method:'GET',path:'/app/v1/health/readings',query:historyQuery,response:healthReadingsSchema,authenticated:true},
] as const;
