import { WATCHING_MAX_DAYS_AHEAD_V1, WATCHING_MAX_ITEMS_V1, watchingChangeV1Schema, watchingCloseV1Schema, watchItemV1Schema, watchingMoveV1Schema,
  type WatchingChangeV1, type WatchItemV1 } from '../../../contracts/src/app/watching';
import type { Loop, LoopBook } from './loops';
import { localIso, localToEpoch } from './reminders';

// "What I'm keeping an eye on" (contracts/src/app/watching.ts): Waldo's own open follow-ups, which the owner can see, close or
// move. Closing or moving one changes only when Waldo looks again, never what it does, so neither needs a card. A repeated
// request lands once by the loop's own state: a close of a closed one answers closed, a move to the same time answers it again.
export const APP_WATCHING_PATH = '/app/v1/watching';
export const APP_WATCHING_CLOSE_PATH = `${APP_WATCHING_PATH}/close`;
export const APP_WATCHING_MOVE_PATH = `${APP_WATCHING_PATH}/move`;

export type AppWatchingHost = Readonly<{
  loops: Pick<LoopBook, 'watching' | 'ownByRow' | 'close' | 'moveOwn'>;
  timezone: string; now(): number;
  assertCurrent(): Promise<void>;
}>;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
const NO_NOTE = 'Waldo set this to look again.';
const clip = (text: string, max: number) => [...text.trim()].slice(0, max).join('');
// A follow-up's due is the owner's wall clock; a day alone is looked at in the morning.
const instantOf = (due: string, timezone: string) => new Date(localToEpoch(due.length === 10 ? `${due}T09:00` : due, timezone)).toISOString();

const itemOf = (loop: Loop & { row: number }, timezone: string): WatchItemV1 | null => {
  const parsed = watchItemV1Schema.safeParse({ id: `loop:${loop.row}`, title: clip(loop.title, 120), why: clip(loop.note || loop.watch_for || NO_NOTE, 200),
    due_at: instantOf(loop.due!, timezone), source: 'planning', from_outside: loop.taint === 'external' });
  return parsed.success ? parsed.data : null;
};

export async function appWatchingRequest(request: Request, host: AppWatchingHost): Promise<Response> {
  const url = new URL(request.url);
  await host.assertCurrent();
  if (url.pathname === APP_WATCHING_PATH) {
    if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
    if ([...url.searchParams.keys()].length) return reply({ error: 'invalid_query' }, 400);
    const loops = host.loops.watching(WATCHING_MAX_ITEMS_V1), items = loops.flatMap(loop => itemOf(loop, host.timezone) ?? []);
    if (items.length < loops.length) console.error(JSON.stringify({ hop: 'app_watching', ok: false, code: 'item_unreadable', detail: String(loops.length - items.length) }));
    return reply({ items });
  }
  if (url.pathname !== APP_WATCHING_CLOSE_PATH && url.pathname !== APP_WATCHING_MOVE_PATH) return reply({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  let raw: unknown; try { raw = await request.json(); } catch { return reply({ error: 'invalid_request' }, 400); }
  const closing = url.pathname === APP_WATCHING_CLOSE_PATH;
  const parsed = closing ? watchingCloseV1Schema.safeParse(raw) : watchingMoveV1Schema.safeParse(raw);
  if (!parsed.success) return reply({ error: 'invalid_request' }, 400);
  const { request_id, id } = parsed.data;
  const loop = host.loops.ownByRow(Number(id.slice('loop:'.length)));
  if (!loop) return reply({ error: 'not_found' }, 404);
  const answer = (change: WatchingChangeV1) => reply(watchingChangeV1Schema.parse(change));
  if (closing) {
    if (loop.status === 'open') host.loops.close(loop.id, 'dropped');
    return answer({ request_id, id, state: 'closed' });
  }
  const moved = watchingMoveV1Schema.safeParse(raw), at = moved.success ? Date.parse(moved.data.due_at) : NaN, now = host.now();
  if (!(at > now && at - now <= WATCHING_MAX_DAYS_AHEAD_V1 * 86_400_000)) return reply({ error: 'invalid_due' }, 400);
  if (loop.status !== 'open') return reply({ error: 'closed' }, 409);
  const due = localIso(at, host.timezone).slice(0, 16);
  if (!host.loops.moveOwn(loop.id, due)) return reply({ error: 'closed' }, 409);
  return answer({ request_id, id, state: 'moved', due_at: instantOf(due, host.timezone) });
}
