import { z } from 'zod';
import { healthDayV1Schema } from './health-ingest';

// GENERAL_WAKE: the one card the owner sees first on Home, "what matters now" in a few lines, written by Waldo's general wake.
// The app reads it on open with no model call. Plain words only: a card that holds a health reading is never kept. Read-only;
// the owner comes from the authenticated session. A card for an earlier day reads as none.
export const APP_HOME_CARD_PATH = '/app/v1/home-card';
export const HOME_CARD_MAX_CHARS = 600;

export const appHomeCardV1Schema = z.discriminatedUnion('state', [
  // It could not be read now.
  z.strictObject({ state: z.literal('unavailable') }),
  // No wake has written one for the owner's today.
  z.strictObject({ state: z.literal('none') }),
  z.strictObject({
    state: z.literal('written'),
    // Changes whenever the card is rewritten.
    card_id: z.string().min(1).max(128),
    text: z.string().min(1).max(HOME_CARD_MAX_CHARS),
    // Epoch milliseconds.
    written_at: z.int().positive(),
    // The owner-local day it is for.
    day: healthDayV1Schema,
    // Written by a run that had read other people's words (mail, the web), so the app can say where it partly came from.
    from_outside: z.boolean(),
  }),
]);
export type AppHomeCardV1 = z.infer<typeof appHomeCardV1Schema>;
