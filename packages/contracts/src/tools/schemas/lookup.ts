import { z } from 'zod';
import { APP_FINDING_TEXT_MAX_V1, appFindingCategoryV1Schema } from '../../app/onboarding';

// The owner look-up skill. A finding is one fact the model judges to be about the owner, from a page a search or read in this
// run returned, quoted from that page. Whether the page is the owner's is the model's judgment and then the owner's: every
// finding waits, unconfirmed and with its source, until the owner keeps, corrects or forgets it.
export const recordOwnerFindingArgsSchema = z.strictObject({
  category: appFindingCategoryV1Schema,
  text: z.string().trim().min(1).max(APP_FINDING_TEXT_MAX_V1),
  // A page address, not a destination: the dispatcher accepts only a page this run's search or browse returned.
  source_url: z.string().regex(/^https?:\/\/[^\s]+$/).max(2048),
  // Long enough to identify one passage: forgetting the finding hides this exact text across chat history.
  evidence_quote: z.string().trim().min(12).max(500),
});
export type RecordOwnerFindingArgs = z.infer<typeof recordOwnerFindingArgsSchema>;
export const listOwnerFindingsArgsSchema = z.strictObject({ limit: z.int().min(1).max(50).default(20) });
export type ListOwnerFindingsArgs = z.infer<typeof listOwnerFindingsArgsSchema>;
