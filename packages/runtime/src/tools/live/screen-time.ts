import {
  getScreenTimeArgsSchema, screenTimeToolDaySchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type GetScreenTimeArgs, type GetScreenTimeResult, type ToolHandler,
} from '@waldo/contracts';
import { screenTimeDaySummaryV1Schema } from '../../../../contracts/src/app/screen-time';
import { invokeScreenTime } from '../../channels/app-screen-time';
import { daysBetween } from '../../health/scores/time';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';
import { localDayOf } from './health';

// The owner's screen time for the owner's own model context: the daily summaries their phone sent, read from the health plane.
// The phone is never asked live. Consent for both purposes is checked by the database on every call, and the result lives in the
// turn that asked (turn_only_output), so no number reaches the tool ledger, memory, logs or storage.
type SignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
export type ScreenTimeReadBook = Readonly<{ days(range: Readonly<{ from: string; to: string }>): Promise<unknown> }>;

export const screenTimeReadBook = (call: SignedCall | null, doName: string | null): ScreenTimeReadBook => ({
  async days(range) {
    if (!call || !doName) return { error: 'not_linked' };
    return invokeScreenTime(call, doName, 'days_read', JSON.stringify({ from: range.from, to: range.to, purpose: 'model' }));
  },
});

type Unavailable = Extract<GetScreenTimeResult, { state: 'unavailable' }>['reason'];
type Row = Extract<GetScreenTimeResult, { state: 'available' }>['days'][number];
const REFUSALS: ReadonlySet<string> = new Set<Unavailable>(['consent_required', 'consent_withdrawn', 'not_linked']);

// A stored row that does not read as the contract's day is left out, never invented around.
const rowOf = (raw: unknown): Row | null => {
  const { device, received_at, summary } = (raw ?? {}) as Record<string, unknown>;
  const day = screenTimeDaySummaryV1Schema.safeParse(summary);
  if (!day.success) return null;
  const view: Record<string, unknown> = { ...day.data, device, received_at };
  delete view.timezone;
  delete view.platform;
  const row = screenTimeToolDaySchema.safeParse(view);
  return row.success ? row.data : null;
};

const allowlist = triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_screen_time'));

export const getScreenTimeHandler = (book: ScreenTimeReadBook, clock: OwnerClock): ToolHandler<GetScreenTimeArgs, GetScreenTimeResult, ToolDispatcherContext> => ({
  name: 'get_screen_time',
  description:
    "The owner's screen time by local day, up to 31 days ending today, as their Android phone sent it: minutes with the screen on, pickups, unlocks, minutes inside the late-night window, first and last use, and minutes per kind of app. One row per phone per day; never add two phones together. received_at is when the phone sent the day, so a missing or old day means the phone has not sent it yet, not zero use. coverage partial means the phone's record does not cover the whole day. A missing number is unknown, never zero. The numbers stay in this turn and are never stored or logged.",
  schema: getScreenTimeArgsSchema,
  trigger_allowlist: allowlist,
  autonomy_gated: false,
  turn_only_output: true,
  async handle(args) {
    const today = localDayOf(clock.now(), clock.timezone);
    if (daysBetween(args.to, today) < 0) return { ok: false, code: 'invalid_args', error: `to must not be after today (${today}) in the owner's time zone` };
    const unavailable = (reason: Unavailable) => result({ state: 'unavailable', reason });
    let raw: unknown;
    try { raw = await book.days(args); } catch { return unavailable('read_failed'); }
    const answer = (raw ?? {}) as { error?: unknown; days?: unknown };
    if (typeof answer.error === 'string') return unavailable(REFUSALS.has(answer.error) ? answer.error as Unavailable : 'read_failed');
    if (!Array.isArray(answer.days)) return unavailable('read_failed');
    const days = answer.days.flatMap((row) => rowOf(row) ?? []);
    if (days.length === 0) return unavailable('no_data');
    return result({ state: 'available', from: args.from, to: args.to, days });
  },
});

const result = (data: GetScreenTimeResult) => ({ ok: true as const, data, source_taint: null });
