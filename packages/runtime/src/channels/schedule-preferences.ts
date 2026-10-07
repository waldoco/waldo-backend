import { SCHEDULE_KINDS, setSchedulePreferenceArgsSchema, type SetSchedulePreferenceArgs, type ToolHandler } from '@waldo/contracts';
import type { Scheduler } from '../scheduler/multiplexer';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { TOOL_PERMISSIONS, triggerTypeSchema } from '@waldo/contracts';
import { DAY_CARDS } from '../prompt/day-cards';
import { applyDayPlan, defaultPlan, type DayPlanBook } from './day-cards';
import { armBriefSweep, BRIEF_SWEEP_ID } from './event-briefs';
import { armNightly, NIGHTLY_ID } from './episodes';
import { armHeartbeat, HEARTBEAT_ID } from './heartbeat';
import type { LoopBook } from './loops';

export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export type SchedulePreferences = Readonly<Record<ScheduleKind, boolean>>;
type Sql = Pick<SqlStorage, 'exec'>;

export const SCHEDULE_LABELS: Readonly<Record<ScheduleKind, string>> = {
  daily_brief: 'daily brief cards (Brief, Check-in, Close)',
  followups: 'mail and calendar follow-ups',
  event_briefs: 'prep notes before events',
  nightly: 'overnight memory consolidation',
  heartbeat: 'periodic open-loop check',
};

// Every scheduled behavior is on by default (out of the box) and can be turned off per owner.
// Followups keep their single source of truth in the proactivity setting; the rest live in one small table.
export const schedulePreferences = (sql: Sql, loops: LoopBook) => {
  sql.exec('CREATE TABLE IF NOT EXISTS schedule_preferences (kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
  const stored = (): Map<string, boolean> =>
    new Map(sql.exec<{ kind: string; enabled: number }>('SELECT kind, enabled FROM schedule_preferences').toArray().map((row) => [row.kind, row.enabled === 1]));
  return {
    all(): SchedulePreferences {
      const rows = stored();
      return Object.fromEntries(SCHEDULE_KINDS.map((kind) => [kind, kind === 'followups' ? loops.proactivity().followups !== false : rows.get(kind) ?? true])) as SchedulePreferences;
    },
    enabled(kind: ScheduleKind): boolean { return this.all()[kind]; },
    set(kind: ScheduleKind, enabled: boolean): void {
      if (kind === 'followups') loops.setProactivity({ ...loops.proactivity(), followups: enabled });
      else sql.exec('INSERT INTO schedule_preferences (kind, enabled) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET enabled = excluded.enabled', kind, enabled ? 1 : 0);
    },
    reset(): void {
      sql.exec('DELETE FROM schedule_preferences');
      if (loops.proactivity().followups === false) loops.setProactivity({ ...loops.proactivity(), followups: true });
    },
  };
};
export type SchedulePreferenceBook = ReturnType<typeof schedulePreferences>;

export const schedulePreferencesLine = (prefs: SchedulePreferences): string =>
  `Scheduled behaviors (owner can change any with set_schedule_preference): ${SCHEDULE_KINDS.map((kind) => `${kind} (${SCHEDULE_LABELS[kind]}) ${prefs[kind] ? 'on' : 'off'}`).join('; ')}`;

export type ScheduleApplyContext = Readonly<{ scheduler: Scheduler; plans: DayPlanBook; timezone: string; now: number }>;

// Bring the scheduler in line with the preferences: off cancels the entries, on arms them again.
export const applySchedulePreferences = async (prefs: SchedulePreferences, ctx: ScheduleApplyContext, only?: ScheduleKind): Promise<void> => {
  const { scheduler, plans, timezone, now } = ctx;
  const want = (kind: ScheduleKind) => only === undefined || only === kind;
  if (want('nightly')) { if (prefs.nightly) await armNightly(scheduler, timezone, now); else if (scheduler.read(NIGHTLY_ID)) await scheduler.cancel(NIGHTLY_ID); }
  if (want('heartbeat')) { if (prefs.heartbeat) await armHeartbeat(scheduler, now); else if (scheduler.read(HEARTBEAT_ID)) await scheduler.cancel(HEARTBEAT_ID); }
  if (want('event_briefs')) { if (prefs.event_briefs) await armBriefSweep(scheduler, now); else if (scheduler.read(BRIEF_SWEEP_ID)) await scheduler.cancel(BRIEF_SWEEP_ID); }
  if (want('daily_brief')) {
    if (prefs.daily_brief) await applyDayPlan(scheduler, plans, timezone, now, defaultPlan(DAY_CARDS), true, true);
    else for (const card of DAY_CARDS) if (scheduler.read(card.id)) await scheduler.cancel(card.id);
  }
};

const allowlist = () => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('set_schedule_preference'));

export const schedulePreferenceHandlers = (book: SchedulePreferenceBook, context: () => ScheduleApplyContext) => [
  {
    name: 'set_schedule_preference',
    description: "Turn one of Waldo's own scheduled behaviors off or back on, or reset all of them to the out-of-the-box defaults. Only when the owner asks. The current state of every behavior is in the ledger; nothing is forced on the owner. Use kind for on and off. Tell the owner plainly what changed and that reset restores everything to on.",
    schema: setSchedulePreferenceArgsSchema,
    trigger_allowlist: allowlist(),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args: SetSchedulePreferenceArgs) {
      if (args.action !== 'reset' && args.kind === undefined) return { ok: false, code: 'invalid_args', error: 'kind is required for on and off', source_taint: null };
      if (args.action === 'reset') book.reset(); else book.set(args.kind!, args.action === 'on');
      await applySchedulePreferences(book.all(), context(), args.action === 'reset' ? undefined : args.kind);
      return { ok: true, data: { preferences: book.all() }, source_taint: null };
    },
  } satisfies ToolHandler<SetSchedulePreferenceArgs, { preferences: SchedulePreferences }, ToolDispatcherContext>,
];
