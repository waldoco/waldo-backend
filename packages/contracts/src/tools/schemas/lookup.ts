import { z } from 'zod';
import { APP_FINDING_TEXT_MAX_V1, appFindingCategoryV1Schema } from '../../app/onboarding';

// The owner look-up skill. A finding is one fact about the owner, never about anyone else, from a page a search in this turn
// returned. anchor is one of the owner's own handles, sites or email addresses that ties the page to the owner: it must appear
// on the page and in the owner's own words, so a page about someone with the same name cannot be kept.
export const recordOwnerFindingArgsSchema = z.strictObject({
  category: appFindingCategoryV1Schema,
  text: z.string().trim().min(1).max(APP_FINDING_TEXT_MAX_V1),
  source_url: z.url({ protocol: /^https?$/ }).max(2048),
  evidence_quote: z.string().trim().min(1).max(500),
  anchor: z.string().trim().min(3).max(254),
});
export type RecordOwnerFindingArgs = z.infer<typeof recordOwnerFindingArgsSchema>;
export const listOwnerFindingsArgsSchema = z.strictObject({ limit: z.int().min(1).max(50).default(20) });
export type ListOwnerFindingsArgs = z.infer<typeof listOwnerFindingsArgsSchema>;
