import {
  cancelStandingOrderArgsSchema, listStandingOrdersArgsSchema, setStandingOrderArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type CancelStandingOrderArgs, type ListStandingOrdersArgs, type SetStandingOrderArgs, type StandingEscalation, type StandingGate, type ToolHandler, type ToolName,
} from '@waldo/contracts';
import type { ScheduleKind } from '@waldo/contracts';
import { nextOccurrence, type Scheduler } from '../scheduler/multiplexer';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { OwnerClock } from '../tools/live/get-context';
import { localIso, reminderRecurrence } from './reminders';

// A7 (BUILD_PLAN_2026-09-25): typed standing orders. every_turn orders ride the reply system
// prompt (read-only context); daily orders additionally arm a scheduler entry whose fire runs
// the same machine-turn path as a reminder. The gate governs the fired run's behavior; the
// write tools themselves stay ACL-bound to owner-confirmed turns exactly as before.
export type StandingOrder = Readonly<{
  id: string;
  scope: string;
  trigger: SetStandingOrderArgs['trigger'];
  cron?: string;
  at: string | null;
  gate: StandingGate;
  escalation: StandingEscalation;
  created_at: number;
}>;

type Sql = Pick<SqlStorage, 'exec'>;

export type StandingOrderBook = Readonly<{
  set(args: SetStandingOrderArgs): Promise<StandingOrder>;
  list(): readonly StandingOrder[];
  byId(id: string): StandingOrder | null;
  cancel(id: string): Promise<boolean>;
}>;

export const standingOrderBook = (sql: Sql, scheduler: Scheduler, clock: OwnerClock, newId: () => string): StandingOrderBook => {
  sql.exec(`CREATE TABLE IF NOT EXISTS standing_orders (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, trigger TEXT NOT NULL, at TEXT, gate TEXT NOT NULL, escalation TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  const toOrder = (row: StandingOrder): StandingOrder => {
    const recurrence = scheduler.read(row.id)?.recurrence;
    return recurrence?.type === 'cron' ? { ...row, cron: recurrence.expression } : row;
  };
  return {
    async set(args) {
      if (args.trigger !== 'every_turn' && args.trigger !== 'cron' && args.at === undefined) throw new Error('a daily standing order needs its local HH:MM time');
      if (args.trigger === 'every_turn' && (args.at !== undefined || args.cron !== undefined)) throw new Error('an every-turn standing order takes no time');
      const now = clock.now().getTime();
      const today = localIso(now, clock.timezone).slice(0, 10);
      const recurrence = args.trigger === 'every_turn' ? null : reminderRecurrence(args.trigger, `${today}T${args.at ?? '00:00'}`, clock.timezone, args.cron);
      const due = recurrence === null ? null : nextOccurrence(recurrence, now);
      const id = `order:${newId()}`;
      sql.exec(
        'INSERT INTO standing_orders (id, scope, trigger, at, gate, escalation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, args.scope, args.trigger, args.at ?? null, args.gate, args.escalation, clock.now().getTime(),
      );
      if (recurrence !== null && due !== null) {
        try {
          await scheduler.schedule({
            id, kind: 'standing_order' as ScheduleKind, payloadRefs: { order_id: id },
            occurrenceAt: due, dueAt: due,
            recurrence,
          });
        } catch (error) {
          // An active order with no armed schedule would look set and never run, and schedule() writes its
          // armed row before re-arming the alarm, so a late failure can leave that row behind: cancel it too
          // (idempotent; its own failure must not hide the original one).
          sql.exec('DELETE FROM standing_orders WHERE id = ?', id);
          try { await scheduler.cancel(id); } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Standing order scheduling and cleanup failed');
          }
          throw error;
        }
      }
      return { id, scope: args.scope, trigger: args.trigger, at: args.at ?? null, ...(args.cron === undefined ? {} : { cron: args.cron }), gate: args.gate, escalation: args.escalation, created_at: clock.now().getTime() };
    },
    list: () => sql.exec<StandingOrder>('SELECT * FROM standing_orders ORDER BY created_at').toArray().map(toOrder),
    byId: (id) => sql.exec<StandingOrder>('SELECT * FROM standing_orders WHERE id = ?', id).toArray().map(toOrder)[0] ?? null,
    async cancel(id) {
      const known = scheduler.read(id)?.kind === 'standing_order';
      // A DELETE returns no rows, so whether the order existed is read before removing it. The order row goes
      // first: if the scheduler cancel then fails (rearm), the owner's order is already gone instead of left
      // behind as an order that never fires.
      const existed = sql.exec('SELECT id FROM standing_orders WHERE id = ?', id).toArray().length > 0;
      sql.exec('DELETE FROM standing_orders WHERE id = ?', id);
      if (known) await scheduler.cancel(id);
      return existed || known;
    },
  };
};

// The system-prompt section every owner turn carries. Read-only context: the order text is
// owner-authored, and the legend keeps the gate meaning explicit so the model never treats a
// confirm_first order as license to act on its own.
export const standingOrdersPrompt = (book: StandingOrderBook): string => {
  const orders = book.list();
  if (orders.length === 0) return '';
  const line = (order: StandingOrder): string =>
    `- [${order.id}] ${order.scope} (${order.trigger === 'every_turn' ? 'applies every turn' : `runs ${order.trigger} ${order.cron ?? `at ${order.at}`}`}; gate: ${order.gate === 'confirm_first' ? 'confirm with the owner before acting' : 'act and report'})`;
  return [
    'Standing orders from the owner (apply until cancelled; a confirm_first order is never license to act without the owner):',
    ...orders.map(line),
  ].join('\n');
};

// The machine-turn message a daily fire runs, mirroring the reminder fire's phrasing.
export const standingOrderFireText = (order: StandingOrder): string =>
  `[Standing order due now, set earlier by the owner: "${order.scope}"] ${
    order.gate === 'confirm_first'
      ? 'Prepare what you would do and report it; make no changes until the owner confirms in chat.'
      : 'Do it now, then report what you did.'
  }`;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const standingOrderHandlers = (book: StandingOrderBook) => [
  {
    name: 'set_standing_order',
    description:
      "Create a standing order - a persistent instruction that applies every turn or runs daily, weekdays, weekly or on a cron schedule. Only when the owner asks for an ongoing rule; one-off requests are reminders. gate confirm_first means scheduled runs prepare and report, then wait for the owner.",
    schema: setStandingOrderArgsSchema,
    trigger_allowlist: allowlist('set_standing_order'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      try {
        return { ok: true, data: await book.set(args), source_taint: null };
      } catch (error) {
        return { ok: false, code: 'invalid_args', error: error instanceof Error ? error.message : String(error) };
      }
    },
  } satisfies ToolHandler<SetStandingOrderArgs, StandingOrder, ToolDispatcherContext>,
  {
    name: 'list_standing_orders',
    description: "The owner's active standing orders.",
    schema: listStandingOrdersArgsSchema,
    trigger_allowlist: allowlist('list_standing_orders'),
    autonomy_gated: false,
    async handle() {
      return { ok: true, data: { orders: book.list() }, source_taint: null };
    },
  } satisfies ToolHandler<ListStandingOrdersArgs, { orders: readonly StandingOrder[] }, ToolDispatcherContext>,
  {
    name: 'cancel_standing_order',
    description: 'Cancel a standing order by id.',
    schema: cancelStandingOrderArgsSchema,
    trigger_allowlist: allowlist('cancel_standing_order'),
    autonomy_gated: false,
    mutates_state: true,
    async handle({ id }) {
      return { ok: true, data: { id, cancelled: await book.cancel(id) }, source_taint: null };
    },
  } satisfies ToolHandler<CancelStandingOrderArgs, { id: string; cancelled: boolean }, ToolDispatcherContext>,
];
