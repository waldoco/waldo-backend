import { z } from 'zod';
import { rungBlockedOutcomeSchema } from '../core/error';
import { browserTaskReceiptSchema } from './browser-session';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ref = z.string().min(1).max(200);
const httpsOrigin = z.string().max(300).regex(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/, 'errand origin must be a bare HTTPS origin');
const httpsUrl = z.url().refine(value => /^https:\/\/(?![^/]*@)/.test(value), 'errand URL must be credential-free HTTPS');
const factsSchema = z.record(z.string().min(1).max(80), z.string().min(1).max(500))
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 24 && Object.keys(value).every(key => !['__proto__', 'constructor', 'prototype'].includes(key)), 'errand facts need 1-24 plain keys');

// A page or site refusal the model can act on: answer a challenge another way, hand a login to the owner, or pick a
// tier that runs scripts. Anything else an engine reports is a failure, never a guessed reason.
export const browserErrandBlockedSchema = rungBlockedOutcomeSchema.extract(['challenge', 'login_required', 'js_required']);
export type BrowserErrandBlocked = z.infer<typeof browserErrandBlockedSchema>;

export const browserErrandEngineSchema = z.enum(['browser_use_v4', 'stagehand_browserbase']);
export type BrowserErrandEngineName = z.infer<typeof browserErrandEngineSchema>;

export const browserLoginStateSchema = z.enum(['requested', 'owner_in_control', 'owner_done', 'signed_in', 'failed', 'expired', 'cancelled']);
export type BrowserLoginState = z.infer<typeof browserLoginStateSchema>;

export const browserErrandPhaseSchema = z.enum([
  'preparing', 'awaiting_approval', 'login_handoff', 'ready', 'submitting', 'submitted',
  'verified', 'unknown', 'not_applied', 'expired', 'cancelled', 'blocked', 'failed',
]);
export type BrowserErrandPhase = z.infer<typeof browserErrandPhaseSchema>;

// Vendor session, run and live-view references sit only in `custody`. Nothing outside the errand module reads that
// field: cards, outcomes, logs and model text are built from the other fields.
export const browserErrandCustodySchema = z.strictObject({
  profileRef: ref.nullable(),
  sessionRef: ref.nullable(),
  prepareRunRef: ref.nullable(),
  submitRunRef: ref.nullable(),
  liveViewUrl: httpsUrl.nullable(),
});

export const browserErrandCheckpointSchema = z.strictObject({
  version: z.literal(1),
  errandId: ref,
  ownerId: ref,
  errandType: z.string().regex(/^[a-z0-9_]{1,60}$/),
  engine: browserErrandEngineSchema,
  origin: httpsOrigin,
  phase: browserErrandPhaseSchema,
  holdExpiresAt: z.int().nonnegative().nullable(),
  review: z.strictObject({ url: httpsUrl, facts: factsSchema, factsDigest: digestSchema }).nullable(),
  finalAction: z.string().min(1).max(500),
  expected: factsSchema,
  verifyCheck: z.string().min(1).max(1000),
  proposalId: ref.nullable(),
  approvalExpiresAt: z.int().nonnegative().nullable(),
  submit: z.strictObject({ key: z.string().regex(/^[0-9a-f]{32,64}$/), startedAt: z.int().nonnegative() }).nullable(),
  blocked: browserErrandBlockedSchema.nullable(),
  login: z.strictObject({ state: browserLoginStateSchema, expiresAt: z.int().nonnegative() }).nullable(),
  receipt: browserTaskReceiptSchema.nullable(),
  custody: browserErrandCustodySchema,
  updatedAt: z.int().nonnegative(),
});
export type BrowserErrandCheckpoint = z.infer<typeof browserErrandCheckpointSchema>;
