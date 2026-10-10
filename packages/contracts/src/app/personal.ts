import {z} from 'zod';
const text = z.string();
const timestamp = z.int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const APP_PERSONAL_MOMENTS_V1 = ['brief','window','prep','heads_up','close','adjustment'] as const;
export const appPersonalMomentIdV1Schema = z.enum(APP_PERSONAL_MOMENTS_V1);
export const appPersonalSourceRefV1Schema = z.strictObject({source:z.enum(['calendar','tasks','responsibility','prepared_work','conversation']),account_ref:text.nullable(),collection_ref:text.nullable(),resource_ref:text.min(1),revision:text.min(1),observed_at:timestamp});
export const appPersonalCoverageV1Schema = z.strictObject({source:z.enum(['calendar','tasks']),account_ref:text,collection_ref:text.nullable(),from:timestamp,to:timestamp,state:z.enum(['complete','partial','unavailable']),reason:text.nullable()});
export const appPersonalEventV1Schema = z.strictObject({id:text,title:text,start:text,end:text,all_day:z.boolean(),status:z.enum(['confirmed','tentative','cancelled']),source_ref:appPersonalSourceRefV1Schema});
export const appPersonalTaskV1Schema = z.strictObject({id:text,title:text,status:z.enum(['todo','done']),due_date:z.iso.date().nullable(),source_ref:appPersonalSourceRefV1Schema});
export const appPersonalBufferV1Schema = z.strictObject({id:text,title:text,start:timestamp,end:timestamp,kind:z.enum(['focus','travel','recovery','preparation']),authority:z.literal('proposed'),source_refs:z.array(appPersonalSourceRefV1Schema)});
export const appPersonalMomentV1Schema = z.strictObject({id:appPersonalMomentIdV1Schema,title:text,body:text,state:z.enum(['prepared','silent','unavailable']),source_refs:z.array(appPersonalSourceRefV1Schema),delivery:z.strictObject({state:z.enum(['prepared','silent','queued','delivered','unknown','blocked']),operation_ref:text.nullable(),receipt_ref:text.nullable()})});
export const appPersonalDayQueryV1Schema = z.strictObject({day:z.iso.date().optional()});
export const appPersonalDayV1Schema = z.strictObject({version:z.literal('personal.v1'),account_ref:z.string().regex(/^acct_[a-f0-9]{64}$/),source_revision:z.int().nonnegative(),revision:z.int().nonnegative(),day:z.iso.date(),timezone:text.min(1),observed_at:timestamp,authored_at:timestamp.nullable(),source_digest:digest,state:z.enum(['prepared','source_only']),overview:text.nullable(),events:z.array(appPersonalEventV1Schema),tasks:z.array(appPersonalTaskV1Schema),buffers:z.array(appPersonalBufferV1Schema),moments:z.array(appPersonalMomentV1Schema).length(6),coverage:z.array(appPersonalCoverageV1Schema)})
  .refine(value => new Set(value.moments.map(moment => moment.id)).size === 6, 'Each named moment has one current projection');
export const appPersonalRoutesV1 = [{method:'GET',path:'/app/v1/personal/day',query:appPersonalDayQueryV1Schema,response:appPersonalDayV1Schema,authenticated:true}] as const;
export type AppPersonalDayV1 = z.infer<typeof appPersonalDayV1Schema>;
export type AppPersonalSourceRefV1 = z.infer<typeof appPersonalSourceRefV1Schema>;
export type AppPersonalMomentV1 = z.infer<typeof appPersonalMomentV1Schema>;
