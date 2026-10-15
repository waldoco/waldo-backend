import { z } from 'zod';
import { viewInputSchema } from '../../app/view';

// show_view: Waldo shows structured content beside its reply on the surfaces that draw it (the app and the console),
// and as plain text everywhere else. What to show, and whether to, is the model's call; the host fits the view to its
// bounds and says how many entries were left out, never refuses it for its size.
export const showViewArgsSchema = z.strictObject({ view: viewInputSchema });
export type ShowViewArgs = z.infer<typeof showViewArgsSchema>;
export const showViewResultSchema = z.strictObject({ shown: z.literal(true), left_out: z.int().nonnegative() });
export type ShowViewResult = z.infer<typeof showViewResultSchema>;
