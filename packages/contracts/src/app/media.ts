import { z } from 'zod';

// References select an immutable owner file. They carry no download credential or authority.
export const appMediaFileRefV1Schema = z.strictObject({ file_id: z.uuid(), revision: z.int().positive() });
export const appVoiceReviewV1Schema = z.strictObject({
  original: appMediaFileRefV1Schema,
  processing: z.enum(['transcribe', 'owner_reviewed']),
  transcript: z.string().trim().min(1).max(8000).optional(),
}).superRefine((value, ctx) => {
  if ((value.processing === 'owner_reviewed') !== (value.transcript !== undefined))
    ctx.addIssue({ code: 'custom', path: ['transcript'], message: 'Only an owner-reviewed transcript supplies transcript text.' });
});
export const appMediaInputV1Schema = z.strictObject({
  attachment_refs: z.array(appMediaFileRefV1Schema).max(4).optional(),
  voice: appVoiceReviewV1Schema.optional(),
});
export type AppMediaFileRefV1 = z.infer<typeof appMediaFileRefV1Schema>;
export type AppVoiceReviewV1 = z.infer<typeof appVoiceReviewV1Schema>;
