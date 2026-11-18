import { z } from 'zod';

// "What I'm keeping an eye on": Waldo's own follow-ups (the open loops a run Waldo started left itself, MODEL_SET_WAKES), which
// the owner can see, close or move. GET /app/v1/watching lists the open ones in due order; POST /app/v1/watching/close and
// /app/v1/watching/move change one. Additive routes: a build that does not call them sees nothing change. Titles and reasons
// are the model's words, never a health value; `from_outside` marks one set by a run that had read outside text, whose words
// may be that text's.
export const watchingIdV1Schema = z.string().regex(/^loop:[0-9]{1,18}$/);
// Where the follow-up came from, as far as the server knows it. `planning`: Waldo's own planning (a day card, a check-back, an
// update); the server does not yet record which run.
export const watchingSourceV1Schema = z.enum(['calendar', 'mail', 'health', 'memory', 'chat', 'event', 'planning']);
export const WATCHING_MAX_ITEMS_V1 = 50;
// The furthest ahead a follow-up may be due, as the server bounds it.
export const WATCHING_MAX_DAYS_AHEAD_V1 = 14;

export const watchItemV1Schema = z.strictObject({
  id: watchingIdV1Schema,
  title: z.string().trim().min(1).max(120),
  why: z.string().trim().min(1).max(200),
  due_at: z.iso.datetime({ offset: true }),
  source: watchingSourceV1Schema,
  from_outside: z.boolean(),
});
export const watchingListV1Schema = z.strictObject({
  items: z.array(watchItemV1Schema).max(WATCHING_MAX_ITEMS_V1).refine(items => new Set(items.map(item => item.id)).size === items.length, 'each item once'),
});

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const watchingCloseV1Schema = z.strictObject({ request_id: requestId, id: watchingIdV1Schema });
export const watchingMoveV1Schema = z.strictObject({ request_id: requestId, id: watchingIdV1Schema, due_at: z.iso.datetime({ offset: true }) });
export const watchingChangeV1Schema = z.discriminatedUnion('state', [
  z.strictObject({ request_id: requestId, id: watchingIdV1Schema, state: z.literal('closed') }),
  z.strictObject({ request_id: requestId, id: watchingIdV1Schema, state: z.literal('moved'), due_at: z.iso.datetime({ offset: true }) }),
]);

export type WatchItemV1 = z.infer<typeof watchItemV1Schema>;
export type WatchingChangeV1 = z.infer<typeof watchingChangeV1Schema>;
