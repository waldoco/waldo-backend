import { z } from 'zod';
import { HOME_CARD_MAX_CHARS } from '../../app/home-card';

// write_home_card: the general wake writes the one card the owner sees first on Home, replacing the one before. Plain words.
export const writeHomeCardArgsSchema = z.strictObject({
  text: z.string().trim().min(1).max(HOME_CARD_MAX_CHARS).describe('What matters now for the owner, in a few plain lines they read first on Home. Never a reading or a number about the body.'),
});
export type WriteHomeCardArgs = z.infer<typeof writeHomeCardArgsSchema>;
