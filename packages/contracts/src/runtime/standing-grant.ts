import { z } from 'zod';
import { appAutonomyGrantTermsV1Schema } from '../app/autonomy';
import { surfaceNameV1Schema } from '../app/surfaces';

// What started a run, set once when it starts and never changed by its tool loop. Grants are decided by origin, not by what
// the run read since: `owner` is a turn the owner typed that is not a reply to someone else's words, `owner_standing` a fire
// of a standing order the owner created on such a turn, `waldo` Waldo's own initiative, and `external` a run woken by or
// replying to someone else's words.
export const runOriginSchema = z.enum(['owner', 'owner_standing', 'waldo', 'external']);
export type RunOrigin = z.infer<typeof runOriginSchema>;

// One standing grant as the owner's object stores it. A change to its terms keeps the id and raises the revision, so an
// effect evaluated against one revision is refused at dispatch under another. An ended grant authorizes nothing.
export const standingGrantRecordSchema = z.strictObject({
  grant_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  revision: z.int().positive(),
  terms: appAutonomyGrantTermsV1Schema,
  created_at: z.int().nonnegative(),
  created_via: surfaceNameV1Schema,
  ended: z.strictObject({ at: z.int().nonnegative(), reason: z.enum(['revoked', 'connection_removed']) }).nullable(),
});
export type StandingGrantRecord = z.infer<typeof standingGrantRecordSchema>;
